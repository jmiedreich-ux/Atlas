// Deciding what one `approve` write actually changes, from a repository tree alone — no network,
// no filesystem. `handleApprove` (api/lib/handlers.mjs) reads the tree, calls `planApproval` here,
// and turns the result into git tree entries for `createTreeClient.createTree`.
//
// This is the git-tree counterpart of `src/scaffold.mjs`'s `checkPreconditions` — same three
// refusals, same order, but read from a `git/trees?recursive=1` listing instead of `existsSync`,
// because the Function never has a checkout to read from.

const PROPOSED_ROOT = 'docs/design/proposed';
const APPROVED_ROOT = 'docs/design/approved';
const MANIFEST_PATH = (slug) => `docs/features/${slug}/workstream.json`;

/** A failure with a code the endpoint turns into a status and a sentence. */
export class ApproveError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ApproveError';
    this.code = code;
  }
}

/**
 * Everything `approve` needs to turn one proposed design into a moved-and-scaffolded one, computed
 * from a flat recursive tree listing — never a partial one; see `readTree`'s truncation guard.
 *
 * @param {{ entries: { path: string, mode: string, type: string, sha: string }[], slug: string }} args
 * @returns {{
 *   moves: { from: string, to: string, mode: string, sha: string }[],
 *   configEntry: { path: string, mode: string, type: string, sha: string } | null,
 * }}
 * @throws {ApproveError} 'no-such-proposal' | 'already-approved' | 'already-scaffolded' | 'no-config'
 */
export function planApproval({ entries, slug }) {
  const proposedPrefix = `${PROPOSED_ROOT}/${slug}/`;
  const approvedPrefix = `${APPROVED_ROOT}/${slug}/`;
  const manifestPath = MANIFEST_PATH(slug);

  const blobs = entries.filter((entry) => entry.type === 'blob');

  if (blobs.some((entry) => entry.path === manifestPath)) {
    throw new ApproveError(
      `${manifestPath} already exists — approve scaffolds a design's FIRST milestone only; a ` +
        `workstream already on record is out of scope for it.`,
      'already-scaffolded',
    );
  }

  if (blobs.some((entry) => entry.path.startsWith(approvedPrefix))) {
    throw new ApproveError(
      `${APPROVED_ROOT}/${slug}/ already has files in it — approve moves a design out of ` +
        `proposed/ once; it does not merge into an approved design that already exists.`,
      'already-approved',
    );
  }

  const proposed = blobs.filter((entry) => entry.path.startsWith(proposedPrefix));
  if (proposed.length === 0) {
    throw new ApproveError(
      `${PROPOSED_ROOT}/${slug}/ has no files — there is nothing to approve.`,
      'no-such-proposal',
    );
  }

  const configEntry = entries.find((entry) => entry.path === 'atlas.config.json') ?? null;
  if (!configEntry) {
    throw new ApproveError('atlas.config.json is missing, so there is nowhere to register this slug.', 'no-config');
  }

  const moves = proposed.map((entry) => ({
    from: entry.path,
    to: `${approvedPrefix}${entry.path.slice(proposedPrefix.length)}`,
    mode: entry.mode,
    sha: entry.sha,
  }));

  return { moves, configEntry };
}

/**
 * `atlas.config.json`'s text with `slug` added to `workstreams`, or the same text back if it is
 * already there — mirrors `scaffold.mjs`'s `promoteInConfig`, idempotent for the same reason.
 *
 * @param {string} currentJsonText
 * @param {string} slug
 * @returns {string}
 * @throws {ApproveError} 'invalid-config'
 */
export function addWorkstreamToConfig(currentJsonText, slug) {
  let config;
  try {
    config = JSON.parse(currentJsonText);
  } catch (error) {
    throw new ApproveError(`atlas.config.json is not valid JSON (${error.message})`, 'invalid-config');
  }
  if (!Array.isArray(config.workstreams)) {
    throw new ApproveError('atlas.config.json has no "workstreams" array to add this slug to.', 'invalid-config');
  }
  if (!config.workstreams.includes(slug)) {
    config.workstreams = [...config.workstreams, slug];
  }
  return JSON.stringify(config, null, 2) + '\n';
}
