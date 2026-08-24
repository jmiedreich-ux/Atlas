// Loads a project that follows the Atlas convention (decision 40) and resolves its workstream
// manifests, in declaration order, against Task 1's schema.
//
// Every path here is resolved against the `projectRoot` a caller passes in — never against this
// module's own location — so the generator behaves identically from any checkout (decision 41).

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { validateConfig, validateWorkstream } from './schema.mjs';

const CONFIG_FILENAME = 'atlas.config.json';
const WORKSTREAMS_DIRNAME = path.join('docs', 'features');
const MANIFEST_FILENAME = 'workstream.json';

/**
 * A repository-relative, slash-separated path — the ONE way any failure in this generator names a
 * file.
 *
 * Every module that can fail uses this, and `tests/build.test.mjs` enforces it. An absolute path
 * is worse than useless in a failure message: on a runner it is
 * `/home/runner/work/repo/repo/docs/...`, which tells the reader nothing they can act on and
 * nothing they can search their own checkout for, and it puts a build-machine path into output
 * that is supposed to be reproducible.
 *
 * @param {string} projectRoot - already absolute.
 * @param {string} absolute
 * @returns {string}
 */
export function repoRelative(projectRoot, absolute) {
  return path.relative(projectRoot, absolute).split(path.sep).join('/');
}

function readJsonFile(root, absPath, describeWhat) {
  const where = repoRelative(root, absPath);
  let raw;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`${describeWhat} not found: expected a file at ${where}`);
    }
    throw new Error(`could not read ${describeWhat} at ${where}: ${err.message}`);
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${describeWhat} at ${where} is not valid JSON: ${err.message}`);
  }
}

function describeValidationFailure(result) {
  return result.errors.map((e) => `${e.path || '(root)'}: ${e.message}`).join('; ');
}

/**
 * Load and validate a project's `atlas.config.json` (decision 40).
 *
 * @param {string} projectRoot - the project's root directory. Resolved to an absolute path;
 *   every other path this module produces is derived from this one, never from Atlas's own
 *   directory, so the same project builds identically from any checkout.
 * @returns {{
 *   project: string,
 *   repo: string,
 *   workstreams: string[],
 *   projectRoot: string,
 *   workstreamsRoot: string,
 *   configPath: string,
 * }}
 */
export function loadConfig(projectRoot) {
  const root = path.resolve(projectRoot);
  const configPath = path.join(root, CONFIG_FILENAME);

  const raw = readJsonFile(root, configPath, 'atlas.config.json');

  const result = validateConfig(raw);
  if (!result.ok) {
    throw new Error(
      `${repoRelative(root, configPath)} failed validation: ${describeValidationFailure(result)}`,
    );
  }

  return {
    project: result.value.project,
    repo: result.value.repo,
    workstreams: result.value.workstreams,
    projectRoot: root,
    workstreamsRoot: path.join(root, WORKSTREAMS_DIRNAME),
    configPath,
  };
}

/**
 * The feature directories that exist on disk and that `atlas.config.json` does not name.
 *
 * THE OTHER HALF OF DECISION 32. A config naming a directory that does not exist already fails the
 * build: it is a broken reference, and Atlas fails loudly. The reverse — a feature that has been
 * WRITTEN and never put on the sheet — was silent, and it is the same failure shape as a hidden
 * feature nobody can find: the work exists, the page does not show it, and nothing says so.
 *
 * It is a WARNING and never a failure, and that is a deliberate line rather than timidity.
 * Promoting an idea onto the sheet is two steps in that order — write the manifest, then name the
 * slug — so the state this reports is the ordinary intermediate state of doing it correctly.
 * Failing the build would mean the act of starting a promotion breaks the site.
 *
 * It never throws either. It runs on every build, and a diagnostic that can fail a build it was
 * added to improve is worse than the silence it replaces. A project with no `docs/features` at all
 * is legitimate — decision 40 asks for that directory only when there are features.
 *
 * Dot-directories are skipped: the records walk skips them too, so a manifest inside one would not
 * render even if it were named.
 *
 * @param {ReturnType<typeof loadConfig>} config
 * @returns {string[]} slugs, sorted, so two builds of one project report identically.
 */
export function unnamedFeatureDirs(config) {
  let entries;
  try {
    entries = readdirSync(config.workstreamsRoot, { withFileTypes: true });
  } catch (err) {
    return [];
  }

  const named = new Set(config.workstreams);
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !named.has(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Every slug directory under `docs/design/proposed/` that could be approved — the same shape
 * `scaffold.mjs`'s `checkPreconditions` (and `api/lib/approve.mjs`'s `planApproval`, its git-tree
 * counterpart for the website) requires: a directory holding at least one file, not yet scaffolded
 * (no `docs/features/<slug>/workstream.json`). There is no separate "already approved" state to
 * check any more — a design goes straight from `proposed/` to `docs/features/<slug>/`, scaffolded,
 * in one step (decision 59; the intermediate `docs/design/approved/` this used to also check was
 * retired — a consuming project's own design-before-implementation policy decides this now, not
 * Atlas).
 *
 * A loose file directly in `docs/design/proposed/` (no slug directory of its own) is never
 * approvable through this path — the same restriction the CLI has always had — so it is not listed
 * here either. This is a read used only to render the Feature Planning page's Upcoming Features
 * section (M9, decision 59); it never fails the build, the same posture `unnamedFeatureDirs` takes,
 * because a design still under review is the ordinary state of a project using this generator, not
 * a defect in it.
 *
 * @param {ReturnType<typeof loadConfig>} config
 * @returns {string[]} slugs, sorted, so two builds of one project report identically.
 */
export function proposedDesignDirs(config) {
  const proposedRoot = path.join(config.projectRoot, 'docs', 'design', 'proposed');
  const workstreamsRoot = config.workstreamsRoot;

  let entries;
  try {
    entries = readdirSync(proposedRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .filter((slug) => {
      const dir = path.join(proposedRoot, slug);
      const hasFiles = readdirSync(dir).length > 0;
      const alreadyScaffolded = existsSync(path.join(workstreamsRoot, slug, MANIFEST_FILENAME));
      return hasFiles && !alreadyScaffolded;
    })
    .sort();
}

/**
 * Resolve a loaded config's workstream directories into validated manifests, in the order the
 * config declared them (decision 20: no workstream's numbering, or position, is imposed on
 * another, so declaration order is preserved rather than re-sorted).
 *
 * A manifest that fails Task 1's schema, or a workstream directory that does not exist, throws
 * immediately and aborts the whole load — a silently-omitted workstream is exactly the drift
 * Atlas exists to prevent.
 *
 * @param {ReturnType<typeof loadConfig>} config
 * @returns {{ slug: string, dir: string, manifestPath: string, manifest: object }[]}
 */
export function resolveWorkstreams(config) {
  return config.workstreams.map((slug) => {
    const dir = path.join(config.workstreamsRoot, slug);

    const where = repoRelative(config.projectRoot, dir);

    if (!existsSync(dir)) {
      throw new Error(
        `workstream "${slug}" is declared in atlas.config.json but its directory does not exist: ${where}`,
      );
    }
    if (!statSync(dir).isDirectory()) {
      throw new Error(
        `workstream "${slug}" is declared in atlas.config.json but ${where} is not a directory`,
      );
    }

    const manifestPath = path.join(dir, MANIFEST_FILENAME);
    const raw = readJsonFile(config.projectRoot, manifestPath, `workstream manifest for "${slug}"`);

    const result = validateWorkstream(raw);
    if (!result.ok) {
      throw new Error(
        `${repoRelative(config.projectRoot, manifestPath)} failed validation: ` +
          describeValidationFailure(result),
      );
    }

    return { slug, dir, manifestPath, manifest: result.value };
  });
}
