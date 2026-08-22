// What a write request may say, and nothing more.
//
// Decision 32's rule, applied to a request body rather than to a manifest: every vocabulary is
// closed and an unknown value is rejected by name. Here that extends to the field names
// themselves. A body carrying `repo`, `path` or `author` is not a body with a harmless extra
// field — it is a caller trying to name the repository, the file or the identity, all three of
// which come from somewhere the caller cannot reach. Refusing it by name says so; ignoring it
// silently lets whoever sent it believe it worked.

import { ACCEPTANCE_RESULTS, whyNotADirectoryName } from './contract.mjs';
import { whyNotWritableText } from './records.mjs';

/** A question's id: letters then digits, the shape a register heading carries. */
const QUESTION_ID = /^[A-Za-z]{1,8}[-.]?\d+[a-z]?$/;

/** A milestone's id (decision 18): `M<n>`, and its parts `M<n>.<m>`. Historical ids are wider. */
const MILESTONE_ID = /^[A-Za-z][A-Za-z0-9.-]{0,31}$/;

const ANSWER_FIELDS = Object.freeze(['workstream', 'question', 'answer', 'sha']);
const ACCEPTANCE_FIELDS = Object.freeze(['workstream', 'milestone', 'result', 'note', 'sha']);

function fail(message) {
  return { ok: false, status: 400, error: 'invalid-payload', message };
}

function asObject(body) {
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  return body;
}

function unknownFields(body, allowed) {
  return Object.keys(body).filter((key) => !allowed.includes(key));
}

function checkShape(body, allowed) {
  const parsed = asObject(body);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fail(
      `this request carried no JSON object as its body, so there is nothing to record. ` +
        `It must be an object with ${allowed.filter((f) => f !== 'sha' && f !== 'note').map((f) => `"${f}"`).join(', ')}.`,
    );
  }

  const unknown = unknownFields(parsed, allowed);
  if (unknown.length > 0) {
    return fail(
      `${unknown.map((f) => `"${f}"`).join(', ')} ${unknown.length > 1 ? 'are fields' : 'is a field'} ` +
        `Atlas does not accept here, and it will not guess what ${unknown.length > 1 ? 'they' : 'it'} ` +
        `meant. This request accepts ${allowed.map((f) => `"${f}"`).join(', ')}. The repository, the ` +
        `file and the identity of whoever is writing are not the caller's to name.`,
    );
  }

  return { ok: true, value: parsed };
}

function checkWorkstream(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return fail(`"workstream" is required and must name one workstream directory (got ${JSON.stringify(value)}).`);
  }
  const wrong = whyNotADirectoryName(value);
  if (wrong) {
    return fail(
      `"workstream" names ONE directory under docs/features/, not a path — ` +
        `${JSON.stringify(value)} ${wrong} (decision 40).`,
    );
  }
  return { ok: true };
}

function checkSha(value) {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== 'string' || !/^[0-9a-f]{4,64}$|^sha-[\w./-]{1,120}$/.test(value)) {
    return fail(`"sha" must be the blob SHA the page was rendered from (got ${JSON.stringify(value)}).`);
  }
  return { ok: true };
}

/**
 * Validate `POST /api/answer`'s body.
 *
 * @param {unknown} body
 * @returns {{ ok: true, value: { workstream: string, question: string, answer: string, sha?: string } }
 *   | { ok: false, status: 400, error: 'invalid-payload', message: string }}
 */
export function validateAnswerPayload(body) {
  const shape = checkShape(body, ANSWER_FIELDS);
  if (!shape.ok) return shape;
  const value = shape.value;

  const workstream = checkWorkstream(value.workstream);
  if (!workstream.ok) return workstream;

  if (typeof value.question !== 'string' || !QUESTION_ID.test(value.question.trim())) {
    return fail(
      `"question" must be a question's id as its heading carries it — letters then a number, as ` +
        `in "Q1" (got ${JSON.stringify(value.question)}).`,
    );
  }

  const why = whyNotWritableText(value.answer);
  if (why) return fail(`"answer" cannot be written into the register because ${why}.`);

  const sha = checkSha(value.sha);
  if (!sha.ok) return sha;

  return {
    ok: true,
    value: {
      workstream: value.workstream,
      question: value.question.trim(),
      answer: value.answer,
      sha: value.sha ?? null,
    },
  };
}

/**
 * Validate `POST /api/acceptance`'s body.
 *
 * @param {unknown} body
 * @returns {{ ok: true, value: { workstream: string, milestone: string, result: string,
 *   note: string | null, sha?: string } }
 *   | { ok: false, status: 400, error: 'invalid-payload', message: string }}
 */
export function validateAcceptancePayload(body) {
  const shape = checkShape(body, ACCEPTANCE_FIELDS);
  if (!shape.ok) return shape;
  const value = shape.value;

  const workstream = checkWorkstream(value.workstream);
  if (!workstream.ok) return workstream;

  if (typeof value.milestone !== 'string' || !MILESTONE_ID.test(value.milestone.trim())) {
    return fail(
      `"milestone" must be a milestone's id as its manifest carries it, as in "M1" or "M6.3" ` +
        `(got ${JSON.stringify(value.milestone)}).`,
    );
  }

  // Decision 32, and the reason this endpoint has a vocabulary at all: an acceptance result is
  // `pass` or `fail`. Everything else anybody would want to send — `done`, `waived`, `blocked` —
  // is a judgement about a milestone's position, and decision 35 gives those to the project's own
  // operations console. Rejected by name, so the caller is told what they sent and what is allowed.
  if (typeof value.result !== 'string' || !ACCEPTANCE_RESULTS.includes(value.result)) {
    return fail(
      `"result" must be one of: ${ACCEPTANCE_RESULTS.join(', ')} (got ${JSON.stringify(value.result)}). ` +
        `A milestone's status is not an acceptance result — that lives in its manifest, and ` +
        `decision 35 keeps it out of Atlas.`,
    );
  }

  if (value.note !== undefined && value.note !== null && String(value.note).trim() !== '') {
    const why = whyNotWritableText(value.note);
    if (why) return fail(`"note" cannot be written into the record because ${why}.`);
  }

  const sha = checkSha(value.sha);
  if (!sha.ok) return sha;

  return {
    ok: true,
    value: {
      workstream: value.workstream,
      milestone: value.milestone.trim(),
      result: value.result,
      note: value.note ?? null,
      sha: value.sha ?? null,
    },
  };
}
