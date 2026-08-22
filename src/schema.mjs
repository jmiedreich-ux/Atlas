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
//
// `blocked`, not `gated` (#780): the word "gate" belongs to the workstream's own `gate` field —
// the thing the owner holds — and what a milestone is recording is simply that it cannot start.
// The phone view's triage vocabulary already said `blocked`, so the product now has one word for
// this rather than two that nearly mean the same thing.
export const MILESTONE_STATUSES = Object.freeze(['done', 'next', 'blocked', 'parked', 'unplanned']);

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
 * Why an `atlas.config.json` workstream entry is not a plain directory name, or `''` if it is.
 *
 * `src/config.mjs` joins each entry onto `docs/features/`, and until this existed it joined
 * whatever string it was given. Every one of these was executed against the real command line:
 *
 *   * `["beacon", "../features/beacon"]` — **exit 0, "built 34 pages"**. The traversal collapses
 *     back onto the first workstream's own directory, so one workstream silently has no page and
 *     `state.json` carries the slug `"../features/beacon"`. That is the failure the duplicate-slug
 *     check exists to prevent, reached by a spelling it cannot see.
 *   * `["beacon", "./beacon"]` — a raw Eleventy `Output conflict:` naming an absolute staging path
 *     on the build machine, which is decision 32's "name what is broken" and I8's one convention
 *     both missed at once.
 *   * `["../../outside-ws"]` — a raw `ENOENT`, and worse: `src/outdir.mjs` protects
 *     `<project>/docs`, so a workstream resolved to `<project>/outside-ws` is a path the build
 *     READS that the output guard's stated contract does not cover. The rule below is what makes
 *     that contract true rather than nearly true.
 *   * `["tide/../beacon"]` — a raw `ENOENT` naming a path inside the GENERATOR's theme directory.
 *
 * A dot-directory is rejected for a different reason: `filesUnder` in `src/build.mjs` skips
 * anything beginning with `.`, so a workstream living in one would validate, resolve, and then
 * have none of its records rendered.
 *
 * This tightens what `atlas.config.json` accepts, which is why it lands before the first tag: a
 * config that builds today must go on building, and every string this refuses is one that does not
 * build correctly now.
 *
 * @param {string} entry - already known to be a non-empty string.
 * @returns {string} a fragment completing "…, and it <reason>", or '' when the entry is fine.
 */
function whyNotADirectoryName(entry) {
  if (entry === '.' || entry === '..') return 'is a relative-path segment, not a directory name';
  if (/[/\\]/.test(entry)) return 'contains a path separator';
  if (entry.startsWith('.')) {
    return 'begins with a dot, and the records walk skips dot-directories — none of its records would render';
  }
  if (entry.trim() !== entry) return 'has leading or trailing whitespace';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(entry)) return 'contains a control character';
  return '';
}

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
