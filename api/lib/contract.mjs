// The part of Atlas's contract that the managed Function and the generator must agree on, letter
// for letter: the closed vocabularies, and the rule that decides whether a string names one
// directory under `docs/features/` or is a path.
//
// **Why this module lives under `api/` and not `src/`.** Static Web Apps packages the directory
// given as `api_location` on its own — nothing outside it survives the deploy — so a Function that
// imported `../src/schema.mjs` would run in CI and fail in production. This module therefore lives
// inside the deployable and has no imports of its own, and `src/schema.mjs` imports it back out.
// There is exactly one definition of each of these values in the repository, which is the point:
// two lists that look alike pass a review on the day they are written and diverge in silence
// afterwards.
//
// Nothing here holds project content (decision 40), reads the clock, or touches the filesystem.

// Decision 32: every vocabulary is closed, and an unknown value is rejected by name rather than
// rendered — or written — as a blank.
export const WORKSTREAM_STAGES = Object.freeze(['not-started', 'designing', 'planned', 'shipping']);

// `blocked`, not `gated` (#780): the word "gate" belongs to the workstream's own `gate` field —
// the thing the owner holds — and what a milestone is recording is simply that it cannot start.
// The phone view's triage vocabulary already said `blocked`, so the product now has one word for
// this rather than two that nearly mean the same thing.
//
// This line is the one the M3 merge is most likely to get wrong. `src/schema.mjs` no longer holds
// the vocabulary — it re-exports this — so resolving that file in M3's favour, which is correct,
// leaves the rename to be carried across by hand to here.
export const MILESTONE_STATUSES = Object.freeze(['done', 'next', 'blocked', 'parked', 'unplanned']);

// Decision 35's second writable thing. Two values and no third: `waived`, `blocked` and `done` are
// judgements about a milestone's POSITION — the last two are literally milestone statuses, three
// lines above — and decision 35 assigns those to the project's own operations console rather than
// to Atlas. A vocabulary that grows to hold them is a status dropdown by another name.
export const ACCEPTANCE_RESULTS = Object.freeze(['pass', 'fail']);

/** The directory a project's records live in (decision 40). Nothing outside it is writable. */
export const RECORDS_ROOT = 'docs';

/** The manifest filename. Editing one is decision 35's first excluded thing. */
export const MANIFEST_FILENAME = 'workstream.json';

/**
 * Why a repository path may not be written to as a record, or `''` when it may.
 *
 * A milestone's `acceptance.record` (decision 14) is a path out of the project's own manifest, and
 * the write path follows it. Traversal was already refused before a request was built — but
 * traversal was never the whole question. A manifest naming `.github/workflows/deploy.yml` stays
 * inside the repository and is still a workflow file, and `action.yml`, `src/*.mjs`,
 * `package.json` and `atlas.config.json` were all reachable the same way.
 *
 * It needs repository write access to set up, so it is not remotely reachable. It is recorded and
 * closed anyway, because decision 35 is a question about what Atlas can be made to write, and
 * "anything in the repository" is the wrong answer to it whoever is asking.
 *
 * @param {unknown} repositoryRelative
 * @returns {string} a sentence completing "…, and it <reason>", or '' when the path is fine.
 */
export function whyNotAWritableRecord(repositoryRelative) {
  if (typeof repositoryRelative !== 'string' || repositoryRelative.trim() === '') {
    return 'is not a path';
  }
  const path = repositoryRelative.trim();
  if (path.includes('\\')) return 'contains a backslash, and a repository path uses forward slashes';
  if (path.startsWith('/')) return 'is absolute, and a repository path is not';
  if (path.endsWith('/')) return 'names a directory rather than a record';

  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return 'is not a plain repository-relative path';
  }
  if (segments[0] !== RECORDS_ROOT || segments.length < 2) {
    return `is outside ${RECORDS_ROOT}/, and Atlas only ever writes to a project's records`;
  }
  if (segments[segments.length - 1] === MANIFEST_FILENAME) {
    return 'is a workstream manifest, and decision 35 keeps manifests out of Atlas entirely';
  }
  return '';
}

/**
 * Why an `atlas.config.json` workstream entry — or a workstream named in a write request — is not
 * a plain directory name, or `''` if it is.
 *
 * `src/config.mjs` joins each entry onto `docs/features/`, and the write endpoints join it onto
 * `docs/features/<slug>/open-questions.md`, so this one function is the whole boundary between a
 * workstream name and an arbitrary path. Every one of these was executed against the real command
 * line before the rule existed:
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
 * @param {string} entry - already known to be a non-empty string.
 * @returns {string} a fragment completing "…, and it <reason>", or '' when the entry is fine.
 */
export function whyNotADirectoryName(entry) {
  if (entry === '.' || entry === '..') return 'is a relative-path segment, not a directory name';
  if (/[/\\]/.test(entry)) return 'contains a path separator';
  if (entry.startsWith('.')) {
    return (
      'begins with a dot, and the records walk skips dot-directories \u2014 none of its records ' +
      'would render'
    );
  }
  if (entry.trim() !== entry) return 'has leading or trailing whitespace';
  // A control character is tested by code point rather than by an escape in a regular
  // expression literal, so that no source file in this repository has to carry one.
  if (entry.split('').some((ch) => ch.codePointAt(0) < 0x20)) return 'contains a control character';
  return '';
}
