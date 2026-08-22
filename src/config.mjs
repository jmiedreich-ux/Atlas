// Loads a project that follows the Atlas convention (decision 40) and resolves its workstream
// manifests, in declaration order, against Task 1's schema.
//
// Every path here is resolved against the `projectRoot` a caller passes in — never against this
// module's own location — so the generator behaves identically from any checkout (decision 41).

import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { validateConfig, validateWorkstream } from './schema.mjs';

const CONFIG_FILENAME = 'atlas.config.json';
const WORKSTREAMS_DIRNAME = path.join('docs', 'features');
const MANIFEST_FILENAME = 'workstream.json';

function readJsonFile(absPath, describeWhat) {
  let raw;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`${describeWhat} not found: expected a file at ${absPath}`);
    }
    throw new Error(`could not read ${describeWhat} at ${absPath}: ${err.message}`);
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${describeWhat} at ${absPath} is not valid JSON: ${err.message}`);
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

  const raw = readJsonFile(configPath, 'atlas.config.json');

  const result = validateConfig(raw);
  if (!result.ok) {
    throw new Error(`${configPath} failed validation: ${describeValidationFailure(result)}`);
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

    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new Error(
        `workstream "${slug}" is declared in atlas.config.json but its directory does not exist: ${dir}`,
      );
    }

    const manifestPath = path.join(dir, MANIFEST_FILENAME);
    const raw = readJsonFile(manifestPath, `workstream manifest for "${slug}"`);

    const result = validateWorkstream(raw);
    if (!result.ok) {
      throw new Error(`${manifestPath} failed validation: ${describeValidationFailure(result)}`);
    }

    return { slug, dir, manifestPath, manifest: result.value };
  });
}
