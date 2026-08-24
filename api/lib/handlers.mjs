// The three endpoints. Decision 35, and nothing beyond it.
//
//   * `POST /api/answer` records an answer to a question in a register.
//   * `POST /api/acceptance` records an acceptance result.
//   * `POST /api/deployment-transition` records a deployment stage transition (M8, decision 35
//     amended: a third writable thing, not a second one).
//
// Creating an issue, approving a milestone, editing a manifest and triggering work belong to the
// project's own operations console — *"two consoles that both act is how they diverge."* A status
// dropdown on every milestone is the obvious next thing to build here and it is deliberately
// absent; a test asserts that this module exports exactly three handlers.
//
// Every write is the same five steps, in the same order, and the order is load-bearing:
//
//   1. **Authorise from the header alone.** Before the credential is read, so an unauthenticated
//      caller is never told how Atlas is configured, and so the empty-credential refusal does not
//      mask a 401 for as long as the App does not exist.
//   2. **Read the credential slot**, which may be empty. When it is, the refusal is clear, says
//      the site still reads, and carries no stack trace.
//   3. **Validate the payload** against the closed vocabularies, rejecting by name.
//   4. **Read the record and its SHA**, and refuse if the caller's SHA is already stale.
//   5. **Write with that SHA**, which both commits and gives optimistic concurrency for free.
//
// Nothing is kept anywhere. Decision 37: the answer exists in the repository or it does not exist
// — no database, no cache, no queue, no pending list. The rebuild is the workflow's job, triggered
// by the push, which is the whole reason decision 36 insists on a GitHub App.

import { GitHubError, createContentsClient } from './github.mjs';
import { RECORDS_ROOT, whyNotAWritableRecord } from './contract.mjs';
import { RecordError, answerQuestion, appendDeploymentTransition, recordAcceptance } from './records.mjs';
import { authorise } from './principal.mjs';
import { fetchInstallationToken } from './app-token.mjs';
import { readCredential } from './credentials.mjs';
import {
  validateAcceptancePayload,
  validateAnswerPayload,
  validateDeploymentTransitionPayload,
} from './payload.mjs';

/** The register a workstream's open questions live in (decision 40's convention). */
const REGISTER = 'open-questions.md';
const MANIFEST = 'workstream.json';
const WORKSTREAMS_ROOT = 'docs/features';

const RECORD_ERROR_STATUS = {
  'no-such-question': 404,
  'ambiguous-question': 409,
  'invalid-payload': 400,
  // `appendDeploymentTransition` (records.mjs) raises this rather than silently truncating a
  // malformed log — the same posture `unreadable-manifest` below takes for a malformed manifest.
  'unreadable-deployment-log': 502,
};

function respond(status, body) {
  return { status, headers: { 'Content-Type': 'application/json' }, body };
}

function refusal({ status, error, message }) {
  return respond(status, { error, message });
}

function workstreamPath(slug, filename) {
  return `${WORKSTREAMS_ROOT}/${slug}/${filename}`;
}

/**
 * Steps 1 to 3, which every write shares, plus the client the last two need.
 *
 * @returns {{ ok: true, payload: object, principal: object, client: object, credential: object }
 *   | { ok: false, response: object }}
 */
async function prepare(request, { env, fetchImpl, nowSeconds }, validate) {
  // Not `?? 'POST'`. This was the one guard in the file that assumed the safe answer when it was
  // not told, and nothing else in the write path does that.
  if (typeof request.method !== 'string' || request.method.toUpperCase() !== 'POST') {
    return {
      ok: false,
      response: refusal({
        status: 405,
        error: 'method-not-allowed',
        message: 'this endpoint records a write, so it answers POST and nothing else.',
      }),
    };
  }

  // 1. Identity, from the header Static Web Apps injects. Never from the body — which is passed in
  // here only so that the function that ignores it is the one that has it.
  const caller = authorise(request.headers, request.body);
  if (!caller.ok) return { ok: false, response: refusal(caller) };

  // 2. The credential slot, which may be empty until the owner creates the App.
  const credential = readCredential(env);
  if (!credential.ok) return { ok: false, response: refusal(credential) };

  // 3. The payload, against the closed vocabularies.
  const payload = validate(request.body);
  if (!payload.ok) return { ok: false, response: refusal(payload) };

  let token;
  try {
    token = await fetchInstallationToken({
      appId: credential.value.appId,
      installationId: credential.value.installationId,
      privateKey: credential.value.privateKey,
      nowSeconds,
      fetchImpl,
    });
  } catch (error) {
    return { ok: false, response: fromError(error) };
  }

  return {
    ok: true,
    payload: payload.value,
    principal: caller.principal,
    credential: credential.value,
    client: createContentsClient({ repo: credential.value.repo, token, fetchImpl }),
  };
}

// Every failure below this line is one of two kinds, and both carry a status and a sentence a
// person can act on. Anything else would be a defect in Atlas rather than in the request, and it
// is reported as one — without a stack trace, because a stack trace in a browser tells the reader
// nothing and tells everyone else too much.
function fromError(error) {
  if (error instanceof GitHubError) {
    return refusal({ status: error.status, error: error.code, message: error.message });
  }
  if (error instanceof RecordError) {
    return refusal({
      status: RECORD_ERROR_STATUS[error.code] ?? 400,
      error: error.code,
      message: error.message,
    });
  }
  return refusal({
    status: 500,
    error: 'atlas-failed',
    message: 'Atlas could not complete this write, and nothing was committed. The site still reads normally.',
  });
}

/**
 * Refuse when the record has already moved on from what the caller was looking at.
 *
 * The SHA on the PUT covers the narrow race between Atlas's own read and its own write. This
 * covers the wide one: the page was built, somebody else answered, and this caller is submitting
 * against what they saw. Optional, because a page that does not know the SHA can still write —
 * it just gets the narrow guarantee rather than the wide one.
 */
function staleAgainstCaller(path, expected, actual) {
  if (!expected || expected === actual) return null;
  return refusal({
    status: 409,
    error: 'conflict',
    message:
      `${path} has changed since the page you are looking at was built, so nothing was written. ` +
      `Reload and send this again — whatever changed is still there.`,
  });
}

/**
 * `POST /api/answer` — record an answer to a question in a workstream's register.
 *
 * @param {{ method?: string, headers: object, body: unknown }} request
 * @param {{ env: object, fetchImpl?: typeof fetch, nowSeconds: number }} deps
 * @returns {Promise<{ status: number, headers: object, body: object }>}
 */
export async function handleAnswer(request, deps) {
  const ready = await prepare(request, deps, validateAnswerPayload);
  if (!ready.ok) return ready.response;

  const { payload, principal, credential, client } = ready;
  const path = workstreamPath(payload.workstream, REGISTER);

  try {
    const current = await client.read(path, credential.branch);

    const stale = staleAgainstCaller(path, payload.sha, current.sha);
    if (stale) return stale;

    const text = answerQuestion(current.text, {
      question: payload.question,
      answer: payload.answer,
      author: principal.author,
      where: path,
    });

    const commit = await client.write({
      path,
      // The commit message names the question and whoever answered. The App is the committer, so
      // without this the history would say only that Atlas wrote something.
      message: `atlas: answer ${payload.question} in ${payload.workstream}\n\nAnswered by ${principal.author} through Atlas.`,
      text,
      sha: current.sha,
      branch: credential.branch,
    });

    return respond(200, { ok: true, path, question: payload.question, commit: commit.commitUrl, sha: commit.sha });
  } catch (error) {
    return fromError(error);
  }
}

/**
 * `POST /api/acceptance` — record an acceptance result in the record a milestone's manifest names.
 *
 * The path is never the caller's to choose: decision 14 puts it in `acceptance.record`, so Atlas
 * reads the manifest to find out where the result goes.
 *
 * @param {{ method?: string, headers: object, body: unknown }} request
 * @param {{ env: object, fetchImpl?: typeof fetch, nowSeconds: number }} deps
 * @returns {Promise<{ status: number, headers: object, body: object }>}
 */
export async function handleAcceptance(request, deps) {
  const ready = await prepare(request, deps, validateAcceptancePayload);
  if (!ready.ok) return ready.response;

  const { payload, principal, credential, client } = ready;
  const manifestPath = workstreamPath(payload.workstream, MANIFEST);

  try {
    const manifest = await client.read(manifestPath, credential.branch);

    let parsed;
    try {
      parsed = JSON.parse(manifest.text);
    } catch (error) {
      return refusal({
        status: 502,
        error: 'unreadable-manifest',
        message: `${manifestPath} is not valid JSON (${error.message}), so Atlas cannot tell where this result goes.`,
      });
    }

    const milestones = Array.isArray(parsed?.milestones) ? parsed.milestones : [];
    const wanted = payload.milestone.toLowerCase();
    const milestone = milestones.find(
      (entry) => typeof entry?.id === 'string' && entry.id.toLowerCase() === wanted,
    );

    if (!milestone) {
      return refusal({
        status: 404,
        error: 'no-such-milestone',
        message:
          `${manifestPath} has no milestone ${JSON.stringify(payload.milestone)}. Nothing was written.`,
      });
    }

    const record = milestone.acceptance?.record;
    if (typeof record !== 'string' || record.trim() === '') {
      return refusal({
        status: 409,
        error: 'no-acceptance-record',
        message:
          `milestone ${milestone.id} has no acceptance.record in ${manifestPath}, so there is ` +
          `nowhere for this result to go. Add the record's repository path to the manifest ` +
          `first — Atlas writes into records, it does not create them.`,
      });
    }

    // The manifest is a record like any other, and a record can be wrong — or can have been made
    // wrong on purpose by somebody with repository write. This is the last thing between it and a
    // PUT, and it is a containment rule rather than only a traversal one: see
    // `whyNotAWritableRecord`.
    const wrong = whyNotAWritableRecord(record);
    if (wrong) {
      return refusal({
        status: 409,
        error: 'unwritable-record',
        message:
          `milestone ${milestone.id} in ${manifestPath} names ${JSON.stringify(record)} as its ` +
          `acceptance record, and that path ${wrong}. Atlas writes to records under ` +
          `${RECORDS_ROOT}/ and nowhere else. Nothing was written.`,
      });
    }

    const current = await client.read(record, credential.branch);

    const stale = staleAgainstCaller(record, payload.sha, current.sha);
    if (stale) return stale;

    const text = recordAcceptance(current.text, {
      result: payload.result,
      note: payload.note,
      author: principal.author,
    });

    const commit = await client.write({
      path: record,
      message:
        `atlas: acceptance ${payload.result} for ${milestone.id} in ${payload.workstream}\n\n` +
        `Recorded by ${principal.author} through Atlas.`,
      text,
      sha: current.sha,
      branch: credential.branch,
    });

    return respond(200, {
      ok: true,
      path: record,
      milestone: milestone.id,
      result: payload.result,
      commit: commit.commitUrl,
      sha: commit.sha,
    });
  } catch (error) {
    return fromError(error);
  }
}

/**
 * `POST /api/deployment-transition` — record a deployment stage transition in the log a
 * workstream's manifest names.
 *
 * The path is never the caller's to choose, same as `handleAcceptance` above: the manifest's own
 * `deploymentLog` field names it, so Atlas reads the manifest to find out where the transition
 * goes. Unlike `handleAcceptance` there is no milestone lookup — a deployment transition is
 * feature-level, a workstream moving to a new stage, not milestone-level.
 *
 * @param {{ method?: string, headers: object, body: unknown }} request
 * @param {{ env: object, fetchImpl?: typeof fetch, nowSeconds: number }} deps
 * @returns {Promise<{ status: number, headers: object, body: object }>}
 */
export async function handleDeploymentTransition(request, deps) {
  const ready = await prepare(request, deps, validateDeploymentTransitionPayload);
  if (!ready.ok) return ready.response;

  const { payload, principal, credential, client } = ready;
  const manifestPath = workstreamPath(payload.workstream, MANIFEST);

  try {
    const manifest = await client.read(manifestPath, credential.branch);

    let parsed;
    try {
      parsed = JSON.parse(manifest.text);
    } catch (error) {
      return refusal({
        status: 502,
        error: 'unreadable-manifest',
        message: `${manifestPath} is not valid JSON (${error.message}), so Atlas cannot tell where this transition goes.`,
      });
    }

    const log = parsed?.deploymentLog;
    if (typeof log !== 'string' || log.trim() === '') {
      return refusal({
        status: 409,
        error: 'no-deployment-log',
        message:
          `${manifestPath} has no deploymentLog, so there is nowhere for this transition to go. ` +
          `Add the log's repository path to the manifest first — Atlas writes into records, it ` +
          `does not create them.`,
      });
    }

    // Same containment rule `handleAcceptance` applies to `acceptance.record`: the manifest is a
    // record like any other, and a record can be wrong. This is the last thing between it and a
    // PUT.
    const wrong = whyNotAWritableRecord(log);
    if (wrong) {
      return refusal({
        status: 409,
        error: 'unwritable-record',
        message:
          `${manifestPath} names ${JSON.stringify(log)} as its deploymentLog, and that path ` +
          `${wrong}. Atlas writes to records under ${RECORDS_ROOT}/ and nowhere else. Nothing was written.`,
      });
    }

    const current = await client.read(log, credential.branch);

    const stale = staleAgainstCaller(log, payload.sha, current.sha);
    if (stale) return stale;

    const text = appendDeploymentTransition(current.text, {
      stage: payload.stage,
      note: payload.note,
    });

    const commit = await client.write({
      path: log,
      message:
        `atlas: deployment transition ${payload.stage} for ${payload.workstream}\n\n` +
        `Recorded by ${principal.author} through Atlas.`,
      text,
      sha: current.sha,
      branch: credential.branch,
    });

    return respond(200, {
      ok: true,
      path: log,
      stage: payload.stage,
      commit: commit.commitUrl,
      sha: commit.sha,
    });
  } catch (error) {
    return fromError(error);
  }
}
