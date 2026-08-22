// The manifest and config contract every project consuming Atlas must satisfy.
//
// This module defines the shape of a workstream manifest (decision 14) and a project's
// `atlas.config.json`, and validates values against that shape. It holds no project content of
// its own (decision 40) — only the contract. Every validator here returns
// `{ ok: true, value }` or `{ ok: false, errors: [{ path, message }] }`, never throws, and never
// returns a partially-valid object.

// Decision 32: the status vocabulary is closed. An unknown value is rejected by name rather
// than rendered as a blank chip.
export const WORKSTREAM_STAGES = Object.freeze(['not-started', 'designing', 'planned', 'shipping']);
export const MILESTONE_STATUSES = Object.freeze(['done', 'next', 'gated', 'parked', 'unplanned']);

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
  requireString(obj, 'position', '', errors);
  requireString(obj, 'gate', '', errors);
  requireString(obj, 'label', '', errors);

  if (!Array.isArray(obj.design)) {
    errors.push({ path: 'design', message: '"design" is required and must be an array' });
  } else {
    obj.design.forEach((entry, index) => validateDesignEntry(entry, `design[${index}]`, errors));
  }

  if (!Array.isArray(obj.milestones)) {
    errors.push({ path: 'milestones', message: '"milestones" is required and must be an array' });
  } else {
    obj.milestones.forEach((milestone, index) => validateMilestone(milestone, `milestones[${index}]`, errors));
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: structuredClone(obj) };
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
      }
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: structuredClone(obj) };
}
