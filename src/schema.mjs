// The manifest and config contract every project consuming Atlas must satisfy.
//
// This module defines the shape of a workstream manifest (decision 14) and a project's
// `atlas.config.json`, and validates values against that shape. It holds no project content of
// its own (decision 40) — only the contract. Every validator here returns
// `{ ok: true, value }` or `{ ok: false, errors: [{ path, message }] }`, never throws, and never
// returns a partially-valid object.

import { isCalendarDate } from './dates.mjs';

// Decision 32: the status vocabulary is closed. An unknown value is rejected by name rather
// than rendered as a blank chip.
//
// The vocabularies themselves — and the rule that decides whether a string names one directory
// under docs/features/ or is a path — live in api/lib/contract.mjs, because the managed Function
// that writes back (decisions 35-37) validates against exactly these and Static Web Apps packages
// its api directory on its own. Re-exported here so this module stays the one place a reader of
// the generator looks for a closed vocabulary, and so there is one definition rather than two that
// look alike.
export {
  ACCEPTANCE_RESULTS,
  MILESTONE_STATUSES,
  WORKSTREAM_STAGES,
  DEPLOYMENT_STAGES,
  whyNotADirectoryName,
} from '../api/lib/contract.mjs';

import { MILESTONE_STATUSES, WORKSTREAM_STAGES, whyNotADirectoryName } from '../api/lib/contract.mjs';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNullableString(value) {
  return value === null || isNonEmptyString(value);
}

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function isNullablePositiveInteger(value) {
  return value === null || isPositiveInteger(value);
}

function joinPath(base, segment) {
  return base ? `${base}.${segment}` : segment;
}

function requireString(obj, key, path, errors) {
  const value = obj[key];
  if (!isNonEmptyString(value)) {
    errors.push({
      path: joinPath(path, key),
      message: `"${key}" is required and must be a non-empty string (got ${JSON.stringify(value)})`,
    });
    return false;
  }
  return true;
}

const CONCISE_FIELD_LIMIT = 240;

// `position` and `next` are read at a glance, not read as prose — a field that drifts into a
// paragraph is the authoring mistake this caps, structurally, rather than leaving it to review.
function requireConciseString(obj, key, path, errors) {
  if (!requireString(obj, key, path, errors)) return;
  const value = obj[key];
  if (value.length > CONCISE_FIELD_LIMIT) {
    errors.push({
      path: joinPath(path, key),
      message:
        `"${key}" must be ${CONCISE_FIELD_LIMIT} characters or fewer (got ${value.length}) — ` +
        `state where things stand, not how they got there`,
    });
  }
}

function requireEnum(obj, key, allowed, path, errors) {
  const value = obj[key];
  if (typeof value !== 'string' || !allowed.includes(value)) {
    errors.push({
      path: joinPath(path, key),
      message: `"${key}" must be one of: ${allowed.join(', ')} (got ${JSON.stringify(value)})`,
    });
    return false;
  }
  return true;
}

function validateDesignEntry(entry, path, errors) {
  if (!isPlainObject(entry)) {
    errors.push({ path, message: 'a "design" entry must be an object with "name" and "where"' });
    return;
  }
  requireString(entry, 'name', path, errors);
  requireString(entry, 'where', path, errors);
}

function validateAcceptance(acceptance, path, errors) {
  if (!isPlainObject(acceptance)) {
    errors.push({
      path,
      message: '"acceptance" is required and must be an object with "kind" and "record"',
    });
    return;
  }
  requireString(acceptance, 'kind', path, errors);

  const recordPath = joinPath(path, 'record');
  if (!isNullableString(acceptance.record)) {
    errors.push({ path: recordPath, message: '"record" must be a non-empty string or null' });
  }
}

function validateMilestone(milestone, path, errors) {
  if (!isPlainObject(milestone)) {
    errors.push({ path, message: 'a milestone must be an object' });
    return;
  }

  // Decision 17: id is the durable, unchanging identifier; label is the normalised display
  // form. Both are required and are allowed — expected — to differ.
  requireString(milestone, 'id', path, errors);
  requireString(milestone, 'label', path, errors);

  if (!isPositiveInteger(milestone.depth)) {
    errors.push({
      path: joinPath(path, 'depth'),
      message: `"depth" is required and must be a positive integer (got ${JSON.stringify(milestone.depth)})`,
    });
  }

  requireString(milestone, 'title', path, errors);
  requireEnum(milestone, 'status', MILESTONE_STATUSES, path, errors);
  requireString(milestone, 'plan', path, errors);

  // A planned milestone has none of these yet.
  if (!isNullablePositiveInteger(milestone.issue)) {
    errors.push({
      path: joinPath(path, 'issue'),
      message: `"issue" must be a positive integer or null (got ${JSON.stringify(milestone.issue)})`,
    });
  }
  if (!isNullablePositiveInteger(milestone.pr)) {
    errors.push({
      path: joinPath(path, 'pr'),
      message: `"pr" must be a positive integer or null (got ${JSON.stringify(milestone.pr)})`,
    });
  }

  validateAcceptance(milestone.acceptance, joinPath(path, 'acceptance'), errors);
  validateMilestoneDates(milestone, path, errors);
}

// M2.1, from #780. Two ADDITIVE fields — a milestone that carries neither validates exactly as it
// did, which is what lets `state.json` stay at version 1: a new optional key does not break a
// reader that understood the previous version.
//
// Both are stored facts, recorded when they happened, and both are `YYYY-MM-DD`. Nothing is
// derived from today — see src/dates.mjs for why that is the whole point rather than a detail.
function validateMilestoneDates(milestone, path, errors) {
  const wasGiven = (key) => milestone[key] !== undefined && milestone[key] !== null;

  for (const key of ['started', 'completed']) {
    if (milestone[key] === undefined || milestone[key] === null) continue;
    if (!isCalendarDate(milestone[key])) {
      errors.push({
        path: joinPath(path, key),
        message:
          `"${key}" must be a stored calendar day written YYYY-MM-DD, or null ` +
          `(got ${JSON.stringify(milestone[key])})`,
      });
    }
  }

  // A close date with no start date is a record with a hole in it: the page would show when the
  // milestone ended and be unable to say how long it took, which is the one thing the pair is for.
  if (wasGiven('completed') && !wasGiven('started')) {
    errors.push({
      path: joinPath(path, 'started'),
      message:
        `"started" is required once "completed" is recorded — a milestone cannot say when it ` +
        `closed without saying when it began`,
    });
  }

  if (
    wasGiven('started') &&
    wasGiven('completed') &&
    isCalendarDate(milestone.started) &&
    isCalendarDate(milestone.completed) &&
    milestone.completed < milestone.started
  ) {
    errors.push({
      path: joinPath(path, 'completed'),
      message:
        `"completed" (${JSON.stringify(milestone.completed)}) is before "started" ` +
        `(${JSON.stringify(milestone.started)}), so this milestone closed before it began`,
    });
  }
}

// Passing named-field validation says nothing about extra, unvalidated properties elsewhere on
// the object — a function, a Symbol, a circular reference — any of which throws inside
// structuredClone. The "never throws" contract is unconditional, so the clone itself must never
// escape as an exception: on failure it becomes an ordinary validation error at the top level.
function cloneValidated(obj) {
  try {
    return { ok: true, value: structuredClone(obj) };
  } catch (err) {
    return {
      ok: false,
      errors: [{ path: '', message: `could not clone the validated value: ${err.message}` }],
    };
  }
}

/**
 * Validate a workstream manifest (decision 14): the contract for
 * `docs/features/<workstream>/workstream.json`.
 *
 * @param {unknown} obj
 * @returns {{ ok: true, value: object } | { ok: false, errors: { path: string, message: string }[] }}
 */
export function validateWorkstream(obj) {
  if (!isPlainObject(obj)) {
    return { ok: false, errors: [{ path: '', message: 'a workstream manifest must be an object' }] };
  }

  const errors = [];

  requireString(obj, 'codename', '', errors);
  requireString(obj, 'what', '', errors);
  requireEnum(obj, 'stage', WORKSTREAM_STAGES, '', errors);
  requireConciseString(obj, 'position', '', errors);
  requireConciseString(obj, 'next', '', errors);
  requireString(obj, 'label', '', errors);

  // Decision 14-style nullable string, same rule `acceptance.record` uses below — but genuinely
  // OPTIONAL rather than a required-but-nullable key: a workstream that has never reached
  // development has nowhere to log yet, and every manifest written before this field existed
  // omits the key entirely, so omission has to validate as cleanly as `null` does.
  if (obj.deploymentLog !== undefined && !isNullableString(obj.deploymentLog)) {
    errors.push({ path: 'deploymentLog', message: '"deploymentLog" must be a non-empty string or null' });
  }

  if (!Array.isArray(obj.design)) {
    errors.push({ path: 'design', message: '"design" is required and must be an array' });
  } else {
    obj.design.forEach((entry, index) => validateDesignEntry(entry, `design[${index}]`, errors));
  }

  if (!Array.isArray(obj.milestones)) {
    errors.push({ path: 'milestones', message: '"milestones" is required and must be an array' });
  } else {
    obj.milestones.forEach((milestone, index) => validateMilestone(milestone, `milestones[${index}]`, errors));
    // A milestone's page is written at `<slug>/<id lowercased>/`, so `M1` and `m1` in one manifest
    // are the same URL and the same directory: whichever renders second silently overwrites the
    // first and the site shows one milestone where the record has two. Decision 32 says loudly.
    assertNoDuplicates(
      obj.milestones.map((milestone) => milestone?.id),
      (id) => (typeof id === 'string' ? id.toLowerCase() : id),
      'milestones',
      'milestone id',
      'two milestones would be written to the same page',
      errors,
    );
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return cloneValidated(obj);
}

/**
 * Push an error for any value that appears twice under `key`.
 *
 * Nothing in this generator dedupes silently: a name that collides is a record somebody has to
 * fix, and the alternative is a page, a bucket or a card that quietly stands for two things.
 */
function assertNoDuplicates(values, key, path, what, consequence, errors) {
  const seen = new Map();
  values.forEach((value, index) => {
    if (value === undefined || value === null) return;
    const normalised = key(value);
    const first = seen.get(normalised);
    if (first) {
      // Named against the FIRST spelling, not this one: "m1 is already used by M1" is the sentence
      // that tells a reader what to change, and "differ only in case" is invisible otherwise.
      errors.push({
        path: `${path}[${index}]`,
        message:
          `${what} ${JSON.stringify(value)} is already used by ${path}[${first.index}] ` +
          `(${JSON.stringify(first.value)})` +
          `${first.value !== value ? ', which differs only in case' : ''} — ${consequence}`,
      });
      return;
    }
    seen.set(normalised, { index, value });
  });
}

// A project's repo slug, "owner/name" — exactly one slash, no whitespace on either side.
const REPO_SLUG_PATTERN = /^[^\s/]+\/[^\s/]+$/;

/**
 * Validate a project's `atlas.config.json` (decision 40): the project's identity, its GitHub
 * repository, and the ordered list of workstream directories under `docs/features/`.
 *
 * @param {unknown} obj
 * @returns {{ ok: true, value: object } | { ok: false, errors: { path: string, message: string }[] }}
 */
export function validateConfig(obj) {
  if (!isPlainObject(obj)) {
    return { ok: false, errors: [{ path: '', message: 'atlas.config.json must be an object' }] };
  }

  const errors = [];

  requireString(obj, 'project', '', errors);

  if (!isNonEmptyString(obj.repo) || !REPO_SLUG_PATTERN.test(obj.repo)) {
    errors.push({
      path: 'repo',
      message: `"repo" is required and must be in "owner/name" format (got ${JSON.stringify(obj.repo)})`,
    });
  }

  if (!Array.isArray(obj.workstreams)) {
    errors.push({ path: 'workstreams', message: '"workstreams" is required and must be an array' });
  } else {
    obj.workstreams.forEach((entry, index) => {
      if (!isNonEmptyString(entry)) {
        errors.push({
          path: `workstreams[${index}]`,
          message: `a workstream directory name must be a non-empty string (got ${JSON.stringify(entry)})`,
        });
        return;
      }
      const wrong = whyNotADirectoryName(entry);
      if (wrong) {
        errors.push({
          path: `workstreams[${index}]`,
          message:
            `a workstream entry names ONE directory under docs/features/, not a path — ` +
            `${JSON.stringify(entry)} ${wrong} (decision 40)`,
        });
      }
    });
    // Two entries naming the same directory would be classified twice, ordered twice, and then
    // collapse into one card when the triage result is keyed by slug — a workstream silently
    // disappearing from the surface built to say what needs the owner.
    assertNoDuplicates(
      obj.workstreams,
      (slug) => slug,
      'workstreams',
      'workstream',
      'one of them would silently disappear from the site',
      errors,
    );
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return cloneValidated(obj);
}
