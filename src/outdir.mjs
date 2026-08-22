// The output-directory guard: the one piece of Atlas that decides whether an `rmSync` over a
// caller-supplied path is allowed to happen.
//
// It lives in its own module rather than inside `src/build.mjs` for one reason: every mechanism
// below can be deleted without breaking a single build, and the only way to notice is a test that
// aims at that mechanism alone. Reached only through `build()`, the three checks are mutually
// redundant on the shapes a build test naturally uses, so each one survives its own deletion with
// a green suite. That is not a hypothetical — it was measured, on all three, and it is why this
// file exists and why `tests/outdir.test.mjs` is written the way it is.
//
// ---------------------------------------------------------------------------------------------
//
// The output directory is replaced wholesale by every build, so a page whose record was deleted
// does not live on forever. That is a destructive act on a path a caller supplied, so one rule
// governs it:
//
//   **nothing the build reads may overlap what the build replaces** — in either direction.
//
// The rule is checked against the things the build actually reads, one by one, rather than against
// the project and generator directories wholesale. That distinction is not pedantry; it is what
// separates the two cases below, which a coarser rule cannot tell apart:
//
//   * `atlas <project> <project>/docs` — the destructive one, and the one that actually happens
//     ("build into the docs folder"). Every record the build was about to render is deleted first,
//     and then the build fails anyway because it just removed its own inputs.
//   * `atlas <project> <project>/_site` — harmless, and the conventional invocation for a static
//     site generator. It is also what a composite action does: `atlas $GITHUB_WORKSPACE
//     $GITHUB_WORKSPACE/_site`. `_site` holds nothing the build reads, so replacing it costs
//     nothing. A rule phrased as "the output must not be inside the project" refuses this, which
//     would make Atlas unusable in the one shape decision 39 says it always runs in.
//
// **Two paths that are the same path can be spelled differently, and a lexical compare sees two
// different strings.** A guard that only compares strings is precise about the spellings it was
// shown and blind to every other one:
//
//   * **Case.** On APFS and on Windows, `<project>/DOCS` IS `<project>/docs`. A case-sensitive
//     `startsWith` does not see it, and the whole corpus is read, rendered and then deleted with
//     exit 0. macOS is a normal developer machine; so is Windows.
//   * **Symlinks in an ancestor position.** `<arena>/plink -> <project>`, then
//     `atlas <project> <arena>/plink/docs`. Lexically those share nothing.
//   * **Symlinks in the final position.** `<project>/docs/out -> /elsewhere`, then
//     `atlas <project> <project>/docs/out`. This one is the subtlest and it shipped: resolving the
//     output path through `realpathSync` turns it into `/elsewhere`, which overlaps nothing — but
//     `rmSync(out, { recursive: true })` unlinks **the link itself**, and the link is a file inside
//     the corpus. `docs/` went 23 files to 65 on the next build, which then ingested them.
//   * **Hard links.** Two names for one file, with two different real paths. `realpathSync` cannot
//     collapse them, because neither is more real than the other.
//
// So there are three checks, and each is here because it catches something the other two do not.
//
//   1. `containsByInode` — the filesystem's own answer. Walks the **literal** (`path.resolve`d,
//      never symlink-resolved) ancestors of the output path and asks `dev`+`ino` whether any of
//      them IS a read path. `statSync` follows symlinks and the filesystem knows its own case
//      rules, so one comparison closes case-folding, a symlinked ancestor, a symlinked final
//      component and a hard link at once. Walking the *literal* ancestors is the whole point: the
//      resolved path of `<project>/docs/out -> /elsewhere` has no ancestor inside the project, so
//      a walk over the resolved form is exactly the walk that missed it.
//   2. `containsLexically` over **canonical** spellings, output inside a read path. This is what
//      still answers when a read path does not EXIST — `dev`/`ino` needs both paths to be real,
//      and this guard runs before anything is loaded, so a project mid-setup with no `docs/` yet
//      still reaches it. Through a symlinked ancestor that is the only check that fires.
//   3. `containsLexically` over canonical spellings, a read path inside the output. The other
//      direction, and a different failure: `atlas <project> <project>` or `atlas <project> /`,
//      where the output would take the input with it.
//
// Each of the three has a test aimed at a shape only it refuses. Delete any one and that test
// goes red.

import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The deepest existing ancestor of `target`, resolved through symlinks, with the not-yet-existing
 * segments re-appended.
 *
 * `realpathSync` on the whole path throws for an output directory that has not been created yet,
 * which is the normal case, so it is applied to the deepest part that does exist.
 *
 * @param {string} target
 * @returns {string} an absolute path.
 */
export function canonicalise(target) {
  const remainder = [];
  let current = path.resolve(target);

  for (;;) {
    try {
      return path.join(realpathSync(current), ...remainder);
    } catch {
      const parent = path.dirname(current);
      // The filesystem root does not exist as far as realpath is concerned: give up and use what
      // the caller wrote, which is still better than nothing.
      if (parent === current) return path.resolve(target);
      remainder.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Whether two paths are the same file or directory as far as the filesystem is concerned —
 * case-folding, hard links and all. A path that does not exist is nothing, and is not the same as
 * anything.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function isSameFile(a, b) {
  try {
    const left = statSync(a);
    const right = statSync(b);
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}

/**
 * Whether `child` is `parent` or sits beneath it, comparing the strings only.
 *
 * Both arguments must already be absolute and spelled the same way — this is the lexical half of
 * the guard and makes no filesystem call of its own.
 *
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
export function containsLexically(parent, child) {
  if (child === parent) return true;
  // The filesystem root already ends in a separator, and appending a second one produces a prefix
  // (`//`) that nothing matches — which made `atlas <project> /` pass this check. A directory that
  // contains everything is exactly the one an output guard must not wave through.
  const withSeparator = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return child.startsWith(withSeparator);
}

/**
 * Whether `target` is, or sits beneath, a directory the filesystem says is `source` — asked of the
 * filesystem rather than of the strings.
 *
 * The walk is over `target`'s own literal ancestors, never over its resolved form: a final
 * component that is a symlink out of the project resolves to somewhere harmless, while the link it
 * replaces is a file inside the corpus that `rmSync` would unlink.
 *
 * @param {string} source - an existing path the build reads.
 * @param {string} target - the path the build would replace.
 * @returns {boolean}
 */
export function containsByInode(source, target) {
  for (let probe = path.resolve(target); ; probe = path.dirname(probe)) {
    if (isSameFile(probe, source)) return true;
    if (path.dirname(probe) === probe) return false;
  }
}

/**
 * The staging directory a build writes into before swapping it into place.
 *
 * A sibling of the output directory, so the swap is a rename within one filesystem rather than a
 * copy across two. It is named here rather than in `build.mjs` because it is a second path the
 * build removes, and every path the build removes goes through this module.
 *
 * @param {string} outDir
 * @returns {string} an absolute path.
 */
export function stagingDirFor(outDir) {
  return `${path.resolve(outDir)}.atlas-staging`;
}

/**
 * Every path the build reads, as [absolute path, how to name it to a caller] pairs.
 *
 * The project's side of the convention is decision 40's three fixed names. The generator's side is
 * named file by file rather than as "the whole generator repository", so that `<generator>/.out` —
 * the ordinary local invocation, and this suite's own scratch directory — keeps working. It is
 * named file by file, though, and not just as `theme/`: `src/`, `.eleventy.js`, `package.json` and
 * `node_modules/` are all read by a build, and a guard whose contract says "every path the build
 * reads" while omitting the generator's own code is not keeping it.
 *
 * `tests/` and `fixture/` are deliberately absent. Neither is read by a build — when `fixture/` is
 * the project being built it is covered by the project's own three entries — and adding them would
 * be the "whole repository" rule this list exists instead of.
 *
 * @param {string} projectRoot - already absolute.
 * @param {string} generatorRoot - already absolute.
 */
function readPaths(projectRoot, generatorRoot) {
  return [
    [path.join(projectRoot, 'atlas.config.json'), "the project's config"],
    [path.join(projectRoot, 'ROADMAP.md'), "the project's roadmap"],
    [path.join(projectRoot, 'docs'), "the project's records"],
    [path.join(generatorRoot, 'theme'), "Atlas's own theme"],
    [path.join(generatorRoot, 'src'), "Atlas's own code"],
    [path.join(generatorRoot, '.eleventy.js'), "Atlas's own Eleventy config"],
    [path.join(generatorRoot, 'package.json'), "Atlas's own package manifest"],
    [path.join(generatorRoot, 'node_modules'), "Atlas's own dependencies"],
  ];
}

/**
 * Refuse to build into a directory whose replacement would destroy something the build reads.
 *
 * Checks the output directory AND the staging directory beside it, because the build removes both.
 *
 * @param {string} projectRoot - the project being built. Resolved here.
 * @param {string} outDir - where the site would be written. Resolved here.
 * @param {string} generatorRoot - Atlas's own checkout. Resolved here.
 * @throws {Error} naming the output path and which read path it collides with.
 */
export function assertOutputDirIsSafe(projectRoot, outDir, generatorRoot) {
  const project = path.resolve(projectRoot);
  const generator = path.resolve(generatorRoot);
  const sources = readPaths(project, generator);

  // The build removes two paths — the output directory and `<out>.atlas-staging` beside it — but
  // only one of them needs checking here, and running the same three checks over both would add a
  // mechanism no test can aim at. The staging directory is a SIBLING of the output directory, so
  // it has the same ancestors; its own name cannot be a read path, because no read path ends in
  // `.atlas-staging`; and if a path is already there under that name, `assertStagingDirIsFree`
  // refuses outright rather than removing it. Between them those three facts leave nothing for a
  // fourth check to catch. Measured, not assumed: with the staging path added to this loop, every
  // mutation of it survived a green suite.
  {
    const target = path.resolve(outDir);
    const canonicalTarget = canonicalise(target);

    const refuse = (reason) => {
      throw new Error(`refusing to build into ${path.resolve(outDir)}: ${reason}`);
    };

    for (const [rawSource, name] of sources) {
      const canonicalSource = canonicalise(rawSource);

      // 1. The filesystem's own answer, over the target's literal ancestors.
      if (containsByInode(rawSource, target)) {
        refuse(
          isSameFile(target, rawSource)
            ? `that is ${name} (${rawSource}), and the build replaces its output directory`
            : insideMessage(name, rawSource),
        );
      }

      // 2. The lexical answer over canonical spellings, which is what still answers when a read
      //    path does not exist yet and `dev`/`ino` has nothing to compare.
      if (containsLexically(canonicalSource, canonicalTarget)) {
        refuse(
          canonicalSource === canonicalTarget
            ? `that is ${name} (${rawSource}), and the build replaces its output directory`
            : insideMessage(name, rawSource),
        );
      }

      // 3. The other direction: `atlas <project> <project>`, or `atlas <project> /` — the output
      //    would take the input with it.
      if (containsLexically(canonicalTarget, canonicalSource)) {
        refuse(`it contains ${name} (${rawSource}), and the build replaces its output directory`);
      }
    }
  }
}

function insideMessage(name, rawSource) {
  return (
    `it is inside ${name} (${rawSource}), and the build replaces its output directory — ` +
    `every file under it would be deleted before it could be read`
  );
}

/**
 * Refuse to start a build whose staging directory is already there.
 *
 * `<out>.atlas-staging` is removed and recreated by every build, and until now it was removed
 * without anything looking at it. Two shapes leave one behind, and neither should be papered over:
 * a build that was killed between its first write and its swap, and a second build running into
 * the same output directory right now. Deleting it silently makes the first invisible and lets the
 * second corrupt the first's output. Decision 32 says say so.
 *
 * The remedy is one `rm -rf` and it is named in the message, so this costs a caller nothing they
 * cannot fix in a second.
 *
 * @param {string} outDir
 * @param {(p: string) => boolean} exists - injected so a test does not have to create a directory
 *   at a path the guard would refuse for a different reason.
 * @throws {Error} naming the staging directory.
 */
export function assertStagingDirIsFree(outDir, exists) {
  const staging = stagingDirFor(outDir);
  if (!exists(staging)) return;

  throw new Error(
    `refusing to build into ${path.resolve(outDir)}: ${staging} is already there. That is either ` +
      `a build into this same output directory running right now — two of them would overwrite ` +
      `each other's pages and swap a mixture into place — or what a build killed part-way through ` +
      `left behind. Remove it and run again.`,
  );
}
