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
export const WORKSTREAM_STAGES = Object.freeze(['not-started', 'designing', 'planned', 'development', 'staging', 'release']);

// The subset of WORKSTREAM_STAGES that a transition record may hold: the three real deployment stages.
// A workstream is in one of six possible states, but only these three are deployment stages that can
// be recorded in a transition.
export const DEPLOYMENT_STAGES = Object.freeze(['development', 'staging', 'release']);

// `blocked`, not `gated` (#780): the word "gate" used to belong to the workstream's own field —
// since M4.2, that field is `next` — and what a milestone is recording is simply that it cannot
// start.
// The phone view's triage vocabulary already said `blocked`, so the product now has one word for
// this rather than two that nearly mean the same thing.
//
// This line is the one the M3 merge is most likely to get wrong. `src/schema.mjs` no longer holds
// the vocabulary — it re-exports this — so resolving that file in M3's favour, which is correct,
// leaves the rename to be carried across by hand to here.
export const MILESTONE_STATUSES = Object.freeze(['done', 'next', 'blocked', 'parked', 'unplanned']);

// The Static Web Apps role a WRITE requires (decisions 34 to 37, and 59 for `approve`).
// Deliberately not `reader`: being able to read the records is not being able to commit to them.
//
// It lives here because this module is the one place a value shared by the generator and the
// Function is allowed to live. `api/lib/principal.mjs` checks it on every request and `src/swa.mjs`
// puts it in the emitted `/api/*` route rule, and those are the door and the lock — two literals
// with an equality test between them is a site where one lets somebody through and the other
// refuses them.
export const WRITE_ROLE = 'author';

// Two values and no third: `waived`, `blocked` and `done` are judgements about a milestone's
// POSITION — the last two are literally milestone statuses, three lines above — not an acceptance
// RESULT, which is a narrower fact about one demo. A vocabulary that grows to hold them is a status
// dropdown by another name, and `handleAcceptance` (api/lib/handlers.mjs) still has none — this was
// never about which console owns the console-wide status dropdown (that reasoning, decision 35's,
// was withdrawn by decision 57 and decision 35 itself retired by decision 58); it is that an
// acceptance result and a milestone's position are two different facts, and this endpoint records
// only the first.
export const ACCEPTANCE_RESULTS = Object.freeze(['pass', 'fail']);

/** The directory a project's records live in (decision 40). Nothing outside it is writable. */
export const RECORDS_ROOT = 'docs';

/**
 * The manifest filename. `whyNotAWritableRecord` below still refuses `acceptance`/
 * `deployment-transition` from ever targeting one — that guard is unrelated to decision 35 and
 * stands on its own (a milestone's position and a deployment log entry are not manifest edits, and
 * neither endpoint's payload can name an arbitrary path in the first place). `approve` (decision 59)
 * DOES write a manifest, through an entirely different mechanism — `api/lib/approve.mjs` and
 * `createTreeClient`, never this function — because scaffolding a design's first milestone is
 * itself the action, not a record `acceptance.record`/`deploymentLog` could ever be made to name.
 */
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
export function whyNotAWritableRecord(path) {
  if (typeof path !== 'string' || path === '') return 'is not a path';

  // THE STRING THIS VALIDATES IS THE STRING THE CALLER USES. There is no trimming, no normalising
  // and no canonical value returned, because the first version of this rule validated
  // `record.trim()` while the handler went on to use `record` — so `" docs/x.md"` validated as
  // `docs/…` and was then requested as `%20docs/x.md`, and the stated invariant "Atlas writes under
  // docs/ and nowhere else" was false as written: the first segment could be `" docs"`.
  //
  // Returning a canonical value would have left the same trap for the next caller who forgot to
  // use it. Refusing an untrimmed path means the two strings cannot differ, because there is only
  // ever one of them. `String.prototype.trim` strips every Unicode whitespace character and the
  // byte-order mark, which is exactly the set that needs refusing here.
  if (path.trim() !== path) {
    return (
      'has leading or trailing whitespace, and Atlas writes to the path a manifest names rather ' +
      'than to a tidied-up version of it'
    );
  }
  if (path.trim() === '') return 'is not a path';

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
  // Case-insensitively: `WORKSTREAM.JSON` is the same file as `workstream.json` on a
  // case-insensitive checkout, and the rule exists to keep `acceptance`/`deployment-transition`
  // from ever being pointed at a manifest by name, rather than to keep one spelling of it out.
  if (segments[segments.length - 1].toLowerCase() === MANIFEST_FILENAME) {
    return (
      'is a workstream manifest, and this endpoint writes into the record a manifest names — it ' +
      'does not write the manifest itself'
    );
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

/**
 * The slug a loose file directly under `docs/design/proposed/` groups under, or `null` if it
 * cannot name one.
 *
 * A directory-shaped proposal (`docs/design/proposed/<slug>/`) was `approve`'s only shape until
 * now (decision 59); a real consuming project's proposals are almost never that \u2014 one `.md`
 * file, sometimes with sibling images or an HTML wireframe sharing its name, is the ordinary case.
 * Two files group together when this returns the same value for both:
 * `display-stale-signals.md`, `display-stale-signals.html` and `display-stale-signals-00.png` \u2026
 * `-06.png` all stem to `display-stale-signals` (nine files, one proposal); a file with no
 * matching sibling groups alone.
 *
 * Strips exactly one extension, then exactly one trailing `-` followed by one or two ASCII digits.
 * Deliberately narrow: `2024-report.md` stems to `2024-report` \u2014 the pattern is a trailing
 * `-NN`, and a four-digit run at the START of a name is not that \u2014 and a filename with two
 * numeric suffixes (`shot-01-02.png`) only loses the last one, because a doubled pattern like that
 * reads as part of the name, not an index.
 *
 * `README.md` is never a proposal \u2014 it is the index this directory's own SOP requires (a
 * consuming project's `docs/MILESTONE_EXECUTION.md`, step 2a) \u2014 so it is excluded by name
 * here, once, rather than left for every caller to remember.
 *
 * @param {string} filename - a basename, no directory component.
 * @returns {string | null}
 */
export function proposedFileStem(filename) {
  if (typeof filename !== 'string' || filename === '') return null;
  if (filename.toLowerCase() === 'readme.md') return null;
  const withoutExt = filename.replace(/\.[^./]+$/, '');
  if (withoutExt === '') return null;
  const stem = withoutExt.replace(/-\d{1,2}$/, '');
  if (stem === '' || whyNotADirectoryName(stem)) return null;
  return stem;
}
