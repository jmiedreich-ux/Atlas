// The five endpoints.
//
//   * `POST /api/answer` records an answer to a question in a register.
//   * `POST /api/acceptance` records an acceptance result.
//   * `POST /api/deployment-transition` records a deployment stage transition (M8, decision 35
//     amended: a third writable thing, not a second one).
//   * `POST /api/approve` moves a proposed design into its feature's own directory, scaffolding
//     its first milestone if one doesn't already exist, in one commit (M9, decision 59 — a
//     fourth, and the first that is not "edit one record").
//   * `POST /api/refresh` triggers the project's own rebuild workflow (M9, decision 61 — a fifth,
//     and the first that commits nothing at all).
//
// Decision 35 scoped write-back to the first two of these and justified the rest going to a
// separate "operations console" that would own approving milestones and editing manifests.
// Decision 57 withdrew that justification — the console named does not do those things — without
// itself widening the scope; decision 58 retired decision 35 on that basis, and decisions 59 and 61
// are what has actually been re-decided under it since, each on its own stated grounds (see
// `api/approve/index.mjs`/`api/lib/approve.mjs` and `api/refresh/index.mjs` respectively). This is
// not "decision 35 never mattered" — M8 shipped exactly on its strength — it is that the reason it
// gave stopped being true, and a write path into a manifest is still treated as the bigger surface
// it always was: `approve` gets its own atomic-commit mechanism rather than reusing the single-file
// one below, precisely because that surface is bigger. `refresh` is the opposite case — decision 57
// named it explicitly as one of the two things waiting on this re-decision, and it commits nothing
// at all (decision 37 stays completely intact: the repository is still the only source of truth,
// this only asks the site to notice sooner).
//
// The first three still share the same five steps, in the same order, and the order is load-bearing:
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
// `handleApprove` shares steps 1 to 3 (`prepare`, parametrised over which GitHub client it builds)
// but not 4 to 5 — it touches more than one record, so its own read/write shape lives in
// `api/lib/approve.mjs` and `createTreeClient` (api/lib/github.mjs) instead.
//
// Nothing is kept anywhere. Decision 37: the answer exists in the repository or it does not exist
// — no database, no cache, no queue, no pending list. The rebuild is the workflow's job, triggered
// by the push, which is the whole reason decision 36 insists on a GitHub App.

import { GitHubError, createContentsClient, createTreeClient, createWorkflowClient } from './github.mjs';
import { RECORDS_ROOT, whyNotAWritableRecord } from './contract.mjs';
import { RecordError, answerQuestion, answerRegisterQuestion, appendDeploymentTransition, recordAcceptance } from './records.mjs';
import { ApproveError, addWorkstreamToConfig, planApproval } from './approve.mjs';
import { buildManifestText, buildPlanText } from './manifest-template.mjs';
import { authorise } from './principal.mjs';
import { fetchInstallationToken } from './app-token.mjs';
import { readCredential } from './credentials.mjs';
import {
  validateAcceptancePayload,
  validateAnswerPayload,
  validateApprovePayload,
  validateDeploymentTransitionPayload,
  validateRefreshPayload,
} from './payload.mjs';

/** The register a workstream's open questions live in (decision 40's convention). */
const REGISTER = 'open-questions.md';
// M5: a structured register, same directory, same convention `src/build.mjs`'s `loadRegister`
// already uses to decide whether a workstream has one.
const REGISTER_JSON = 'register.json';
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

const APPROVE_ERROR_STATUS = {
  'no-such-proposal': 404,
  'ambiguous-proposal': 409,
  'name-collision': 409,
  'no-config': 502,
  'invalid-config': 502,
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
 * Steps 1 to 3, which every write shares, plus the client the last steps need.
 *
 * @param {object} request
 * @param {object} deps
 * @param {(body: unknown) => object} validate
 * @param {(args: { repo: string, token: string, fetchImpl: typeof fetch }) => object} [makeClient] -
 *   `createContentsClient` by default; `handleApprove` passes `createTreeClient` instead, since it
 *   is not editing one record.
 * @returns {{ ok: true, payload: object, principal: object, client: object, credential: object }
 *   | { ok: false, response: object }}
 */
async function prepare(request, { env, fetchImpl, nowSeconds }, validate, makeClient = createContentsClient) {
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
    client: makeClient({ repo: credential.value.repo, token, fetchImpl }),
    // Exposed alongside `client` only for `handleRefresh`, which is the one caller needing a
    // SECOND client (a content read for `atlas.config.json`'s "workflow" field, then a dispatch)
    // — every other handler builds exactly one client from `makeClient` and never touches this.
    token,
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
  if (error instanceof ApproveError) {
    return refusal({
      status: APPROVE_ERROR_STATUS[error.code] ?? 400,
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

  // M5: which register shape this workstream has decides which record gets written, and it is
  // decided the same way `src/build.mjs` decides it — by whether `register.json` exists, not by a
  // manifest field. A manifest field would be a second, separately-authored answer to the exact
  // question file existence already answers for the build, and the two could drift; one source of
  // truth for "does this workstream have a structured register" is worth one extra read.
  const registerJsonPath = workstreamPath(payload.workstream, REGISTER_JSON);

  try {
    let current;
    try {
      current = await client.read(registerJsonPath, credential.branch);
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) {
        // `await` here, not a bare `return` — a bare `return somePromise` inside this try block
        // would hand the caller an unsettled promise directly, and a rejection from it would skip
        // this function's own `catch` below entirely (the try/catch only catches what it awaits).
        return await answerProseRegister({ payload, principal, credential, client });
      }
      throw error;
    }

    const stale = staleAgainstCaller(registerJsonPath, payload.sha, current.sha);
    if (stale) return stale;

    const text = answerRegisterQuestion(current.text, {
      questionId: payload.question,
      chosen: payload.answer,
      chosenWasOffered: payload.chosenWasOffered ?? false,
      author: principal.author,
    });

    const commit = await client.write({
      path: registerJsonPath,
      message: `atlas: answer ${payload.question} in ${payload.workstream}\n\nAnswered by ${principal.author} through Atlas.`,
      text,
      sha: current.sha,
      branch: credential.branch,
    });

    return respond(200, {
      ok: true,
      path: registerJsonPath,
      question: payload.question,
      commit: commit.commitUrl,
      sha: commit.sha,
    });
  } catch (error) {
    return fromError(error);
  }
}

// The prose path (pre-M5, and any register `register.json` deferral leaves as `open-questions.md`
// — Task 6's stated cost). Unchanged from before this milestone: same file, same function, same
// five-step order — this is that same code, only reachable now after the structured-register probe
// above has already 404'd.
async function answerProseRegister({ payload, principal, credential, client }) {
  const path = workstreamPath(payload.workstream, REGISTER);

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

/**
 * `POST /api/approve` — move a proposed design straight into its feature's own directory, and
 * scaffold its first milestone if one doesn't already exist, in one commit (M9, decision 59).
 *
 * Unlike the three handlers above, this does not edit one record at a known SHA: it moves every
 * file under `docs/design/proposed/<slug>/` to `docs/features/<slug>/`, and adds `<slug>` to
 * `atlas.config.json`'s `workstreams` — several file changes that either all land or none do.
 * Whether it also writes a starter `workstream.json` and `m1-plan.md` there depends on whether one
 * already exists: an already-tracked feature (`planApproval`'s own header names real examples) is
 * moved in without disturbing its existing manifest, never scaffolded a second time.
 * `createTreeClient` (api/lib/github.mjs) builds this as one git tree and one commit;
 * `planApproval` (api/lib/approve.mjs) decides which moves, which config change, and whether to
 * scaffold, from a fresh read of the branch, taken inside this call rather than from anything the
 * caller sent — so the preconditions it checks (proposal exists, nothing name-colliding under this
 * slug) are checked against the repository as it actually is at write time, not as a page happened
 * to render it.
 *
 * @param {{ method?: string, headers: object, body: unknown }} request
 * @param {{ env: object, fetchImpl?: typeof fetch, nowSeconds: number }} deps
 * @returns {Promise<{ status: number, headers: object, body: object }>}
 */
export async function handleApprove(request, deps) {
  const ready = await prepare(request, deps, validateApprovePayload, createTreeClient);
  if (!ready.ok) return ready.response;

  const { payload, principal, credential, client } = ready;
  const slug = payload.slug;

  try {
    const { commitSha, treeSha } = await client.readBranch(credential.branch);
    const entries = await client.readTree(treeSha);

    const { moves, configEntry, manifestExists } = planApproval({ entries, slug });

    const configText = await client.readBlob(configEntry.sha);
    const newConfigText = addWorkstreamToConfig(configText, slug);

    // A manifest already on record is never written over — see `planApproval`'s own header for why
    // that is a real case, not a hypothetical one.
    const [manifestSha, planSha, configSha] = await Promise.all([
      manifestExists ? null : client.createBlob(buildManifestText(slug)),
      manifestExists ? null : client.createBlob(buildPlanText(slug)),
      client.createBlob(newConfigText),
    ]);

    const treeEntries = [
      // Each move is two entries: the new path, carrying the SAME blob SHA the file already has
      // (a git blob is content-addressed, so moving a file commits no new content, only a new tree
      // position) — and the old path, removed by sending `sha: null` for it.
      ...moves.flatMap((move) => [
        { path: move.to, mode: move.mode, type: 'blob', sha: move.sha },
        { path: move.from, mode: move.mode, type: 'blob', sha: null },
      ]),
      ...(manifestExists
        ? []
        : [
            { path: `docs/features/${slug}/workstream.json`, mode: '100644', type: 'blob', sha: manifestSha },
            { path: `docs/features/${slug}/m1-plan.md`, mode: '100644', type: 'blob', sha: planSha },
          ]),
      { path: 'atlas.config.json', mode: '100644', type: 'blob', sha: configSha },
    ];

    const newTreeSha = await client.createTree({ baseTreeSha: treeSha, entries: treeEntries });
    const newCommitSha = await client.createCommit({
      treeSha: newTreeSha,
      parentSha: commitSha,
      message:
        `atlas: approve ${slug}\n\n` +
        `Moved docs/design/proposed/${slug}/ to docs/features/${slug}/` +
        (manifestExists
          ? ', which already had a workstream on record — left untouched'
          : ', scaffolded its first milestone') +
        `, and registered it in atlas.config.json.\n\n` +
        `Approved by ${principal.author} through Atlas.`,
    });

    const commit = await client.updateRef({ branch: credential.branch, commitSha: newCommitSha });

    return respond(200, {
      ok: true,
      slug,
      featurePath: `docs/features/${slug}/`,
      manifestPath: `docs/features/${slug}/workstream.json`,
      commit: commit.commitUrl,
    });
  } catch (error) {
    return fromError(error);
  }
}

/**
 * `POST /api/refresh` — trigger the project's own rebuild workflow (M9, decision 61).
 *
 * The owner's own spec, quoted because it is the whole design: "a refresh button that rebuilds the
 * site... it keeps decision 37 completely intact: the repository stays the only source of truth,
 * the page is still rendered from records, nothing is held anywhere. It just stops him waiting on
 * CI to notice." Nothing here writes a byte. It reads `atlas.config.json`'s `"workflow"` field —
 * the same file `handleApprove` already reads and writes, not a new secret, because a workflow
 * filename is not sensitive (decisions 38, 41: Atlas is a generic multi-project generator, and each
 * project names its own workflow the way it already names everything else about itself) — then
 * asks GitHub to dispatch it, through the same installation token every write endpoint already
 * holds (decision 61: no new credential, no new trust boundary).
 *
 * @param {{ method?: string, headers: object, body: unknown }} request
 * @param {{ env: object, fetchImpl?: typeof fetch, nowSeconds: number }} deps
 * @returns {Promise<{ status: number, headers: object, body: object }>}
 */
export async function handleRefresh(request, deps) {
  const ready = await prepare(request, deps, validateRefreshPayload);
  if (!ready.ok) return ready.response;

  const { principal, credential, client, token } = ready;

  try {
    const config = await client.read('atlas.config.json', credential.branch);

    let parsed;
    try {
      parsed = JSON.parse(config.text);
    } catch (error) {
      return refusal({
        status: 502,
        error: 'unreadable-config',
        message: `atlas.config.json is not valid JSON (${error.message}), so Atlas cannot tell which workflow to trigger.`,
      });
    }

    const workflow = parsed?.workflow;
    if (typeof workflow !== 'string' || workflow.trim() === '') {
      return refusal({
        status: 409,
        error: 'no-workflow',
        message:
          `atlas.config.json has no "workflow" field, so there is nothing to trigger. Add the ` +
          `rebuild workflow's filename (e.g. "atlas.yml") to atlas.config.json first — Atlas ` +
          `triggers a workflow the project already has, it does not create one.`,
      });
    }

    const workflowClient = createWorkflowClient({ repo: credential.repo, token, fetchImpl: deps.fetchImpl });
    await workflowClient.dispatch({ workflow, ref: credential.branch });

    return respond(200, { ok: true, workflow, ref: credential.branch, triggeredBy: principal.author });
  } catch (error) {
    return fromError(error);
  }
}
