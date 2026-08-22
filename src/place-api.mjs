#!/usr/bin/env node
// Put the write-back Function where a consuming workflow can name it as an Azure Static Web Apps
// `api_location` (decisions 5, 35 to 37).
//
// **Why a copy at all.** A deploy step names `api_location` relative to the caller's checkout, and
// the action's own directory is not part of it. The Function carries no credential — the GitHub
// App's installation lives in the Static Web App's application settings and nowhere else — so a
// copy inside the workspace exposes nothing.
//
// **Why this is a module and not a shell block in `action.yml`.** It removes a directory a caller
// named, which is the second destructive act in this generator, and the first one shipped a
// corpus-destroying hole (see the comment at the top of `src/outdir.mjs`). So it reuses that
// guard, exactly, rather than growing a weaker second one — and it lives somewhere tests can reach
// it, which a block of bash inside a YAML file is not.

import { cpSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertOutputDirIsSafe, canonicalise, containsLexically } from './outdir.mjs';

const GENERATOR_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_SOURCE = path.join(GENERATOR_ROOT, 'api');

/**
 * Copy the write-back Function to `apiDir`, replacing whatever is there.
 *
 * @param {string} projectRoot - the project being built, which on a runner is the workspace.
 * @param {string} apiDir - where the Function goes. An empty string places nothing.
 * @param {string} outDir - where the site is being written, so the two cannot be the same place.
 * @returns {string} the path the Function was placed at, **relative to `projectRoot`** and with
 *   forward slashes, or '' when `apiDir` was empty. Relative because that is what this value is
 *   for: `Azure/static-web-apps-deploy` runs in a container with the checkout mounted at
 *   `/github/workspace` and reads `api_location` as repository-relative, so an absolute path from
 *   the runner does not resolve inside it — and `app_location` beside it is relative too, so the
 *   two would not even have been in the same frame of reference.
 * @throws {Error} naming what the destination would have destroyed, or saying that it lies outside
 *   the workspace and so could never be deployed.
 */
export function placeApi(projectRoot, apiDir, outDir) {
  if (!apiDir) return '';

  const root = path.resolve(projectRoot);
  const destination = path.resolve(apiDir);

  // The same guard the output directory gets, and for the same reason: this call ends in an
  // `rmSync` over `destination`. It refuses the project, its records, its config, the generator's
  // own directories — `api/` among them, so Atlas cannot be asked to overwrite itself — and the
  // filesystem root.
  assertOutputDirIsSafe(root, destination, GENERATOR_ROOT);

  // And the one thing that guard does not know about: the site the build is writing beside this.
  // `build()` replaces the output directory wholesale, so a Function placed inside it would exist
  // only until the next build, and a build writing into the Function would take it with the site.
  const out = canonicalise(path.resolve(outDir));
  const api = canonicalise(destination);
  if (containsLexically(out, api) || containsLexically(api, out)) {
    throw new Error(
      `refusing to place the write-back Function at ${destination}: it overlaps the output ` +
        `directory ${path.resolve(outDir)}, which every build replaces wholesale. Give the ` +
        `Function a directory of its own.`,
    );
  }

  // The answer this returns has to be usable as an `api_location`, and that is a repository path.
  // A destination outside the workspace would be placed perfectly well and then be unusable, which
  // is a failure that surfaces as a deploy quietly shipping no API — so it is refused here, where
  // the message can say why.
  const relative = path.relative(root, destination).split(path.sep).join('/');
  if (relative === '' || relative.startsWith('../')) {
    throw new Error(
      `refusing to place the write-back Function at ${destination}: it is outside the project at ` +
        `${root}, and a Static Web Apps \`api_location\` is a path inside the checkout. Give it a ` +
        `directory within the project.`,
    );
  }

  rmSync(destination, { recursive: true, force: true });
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(API_SOURCE, destination, { recursive: true });

  return relative;
}

async function main(argv) {
  const [projectRoot, apiDir, outDir] = argv;
  if (!projectRoot || outDir === undefined) {
    console.error('atlas: usage: node src/place-api.mjs <project-root> <api-dir> <out-dir>');
    return 2;
  }

  try {
    const where = placeApi(projectRoot, apiDir, outDir);
    if (where === '') {
      console.log('atlas: api-dir is empty, so the write-back Function was not placed');
    } else {
      console.log(`atlas: placed the write-back Function at ${where}, relative to the project`);
    }
    // The action reads this to fill its `api-path` output.
    console.log(`::atlas-api-path::${where}`);
    return 0;
  } catch (error) {
    console.error(`atlas: ${error.message}`);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
