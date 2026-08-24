// Deciding what one `approve` write actually changes, from a repository tree alone — no network,
// no filesystem. `handleApprove` (api/lib/handlers.mjs) reads the tree, calls `planApproval` here,
// and turns the result into git tree entries for `createTreeClient.createTree`.
//
// This is the git-tree counterpart of `src/scaffold.mjs`'s `checkPreconditions` — same refusals,
// same order, but read from a `git/trees?recursive=1` listing instead of `existsSync`, because the
// Function never has a checkout to read from.
//
// A proposed design used to land in an intermediate `docs/design/approved/<slug>/` before
// scaffolding folded it into `docs/features/<slug>/`. That split was retired (2026-08-24: a
// consuming project's own design-before-implementation policy now says approved design and
// milestone tracking share one directory) — `approve` moves a proposed design directly into
// `docs/features/<slug>/`.
//
// A proposal is either a directory (`docs/design/proposed/<slug>/`) or a loose-file group — every
// top-level file directly under `docs/design/proposed/` whose name stems to `slug`
// (`proposedFileStem`) — never both. `src/config.mjs`'s `proposedDesignDirs` lists both shapes the
// same way, because a real consuming project's proposals are almost never their own directory.

import { proposedFileStem } from './contract.mjs';

const PROPOSED_ROOT = 'docs/design/proposed';
const WORKSTREAMS_ROOT = 'docs/features';
const MANIFEST_PATH = (slug) => `${WORKSTREAMS_ROOT}/${slug}/workstream.json`;

/** A failure with a code the endpoint turns into a status and a sentence. */
export class ApproveError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ApproveError';
    this.code = code;
  }
}

/**
 * Everything `approve` needs to turn one proposed design into a moved-and-maybe-scaffolded one,
 * computed from a flat recursive tree listing — never a partial one; see `readTree`'s truncation
 * guard.
 *
 * A manifest already existing is not a refusal. A real consuming project can give a workstream a
 * manifest before `approve` ever runs against it — adopting the generator against an
 * already-underway feature, say — and that manifest can say, in its own words, that the design is
 * still sitting unapproved in `proposed/`. Refusing outright whenever a manifest exists (as this
 * once did) blocks exactly that case: a feature that already has tracking, whose design just never
 * actually landed. `manifestExists` tells the caller whether to also scaffold a starter manifest
 * and plan, or move the design in on its own and leave whatever tracking is already there
 * untouched.
 *
 * @param {{ entries: { path: string, mode: string, type: string, sha: string }[], slug: string }} args
 * @returns {{
 *   moves: { from: string, to: string, mode: string, sha: string }[],
 *   configEntry: { path: string, mode: string, type: string, sha: string } | null,
 *   manifestExists: boolean,
 * }}
 * @throws {ApproveError} 'no-such-proposal' | 'ambiguous-proposal' | 'name-collision' | 'no-config'
 */
export function planApproval({ entries, slug }) {
  const proposedPrefix = `${PROPOSED_ROOT}/${slug}/`;
  const featurePrefix = `${WORKSTREAMS_ROOT}/${slug}/`;
  const manifestPath = MANIFEST_PATH(slug);

  const blobs = entries.filter((entry) => entry.type === 'blob');
  const manifestExists = blobs.some((entry) => entry.path === manifestPath);

  const directoryShaped = blobs.filter((entry) => entry.path.startsWith(proposedPrefix));

  // A loose file directly under `docs/design/proposed/` — no further `/` past that prefix — whose
  // name stems to this slug (`proposedFileStem`). The ordinary shape a real proposal takes.
  const looseShaped = blobs.filter((entry) => {
    if (!entry.path.startsWith(`${PROPOSED_ROOT}/`)) return false;
    const rest = entry.path.slice(PROPOSED_ROOT.length + 1);
    if (rest.includes('/')) return false;
    return proposedFileStem(rest) === slug;
  });

  if (directoryShaped.length > 0 && looseShaped.length > 0) {
    throw new ApproveError(
      `${slug} names both a directory (${PROPOSED_ROOT}/${slug}/) and a group of loose files ` +
        `stemming to the same name — Atlas cannot tell which one this approval means. Rename one ` +
        `of them so the slugs no longer collide.`,
      'ambiguous-proposal',
    );
  }

  const proposed = directoryShaped.length > 0 ? directoryShaped : looseShaped;
  if (proposed.length === 0) {
    throw new ApproveError(
      `${PROPOSED_ROOT}/${slug}/ has no files, and no loose file under ${PROPOSED_ROOT}/ stems to ` +
        `${JSON.stringify(slug)} — there is nothing to approve.`,
      'no-such-proposal',
    );
  }

  // A directory-shaped move keeps everything past the slug (subfolders included); a loose-file
  // move is always flat — the file already sits directly under `PROPOSED_ROOT`, so its own
  // basename is all there is to keep.
  const moves = proposed.map((entry) => ({
    from: entry.path,
    to:
      directoryShaped.length > 0
        ? `${featurePrefix}${entry.path.slice(proposedPrefix.length)}`
        : `${featurePrefix}${entry.path.slice(PROPOSED_ROOT.length + 1)}`,
    mode: entry.mode,
    sha: entry.sha,
  }));

  // Design and tracking share one directory now (no more intermediate `approved/` stop), so a
  // proposed file can in principle land on top of something already in `docs/features/<slug>/` —
  // the manifest itself, an existing `open-questions.md`, a hand-placed note, whatever. This is
  // the one thing standing between a move and silently overwriting real, already-recorded content.
  const existingFeatureFiles = new Set(
    blobs.filter((entry) => entry.path.startsWith(featurePrefix)).map((entry) => entry.path),
  );
  const collision = moves.find((move) => existingFeatureFiles.has(move.to));
  if (collision) {
    throw new ApproveError(
      `${collision.to} already exists — approve will not overwrite a file already on record. ` +
        `Rename the file in ${proposedPrefix} or resolve the collision by hand first.`,
      'name-collision',
    );
  }

  const configEntry = entries.find((entry) => entry.path === 'atlas.config.json') ?? null;
  if (!configEntry) {
    throw new ApproveError('atlas.config.json is missing, so there is nowhere to register this slug.', 'no-config');
  }

  return { moves, configEntry, manifestExists };
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
