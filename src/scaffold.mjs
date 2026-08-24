// A local CLI that turns an approved, unscaffolded design into a starter workstream.json and
// first milestone plan (Atlas M7).
//
// A second caller does the same thing from the website now — `handleApprove` in
// `api/lib/handlers.mjs` (M9, decision 59) — which is why the manifest/plan text below moved to
// `api/lib/manifest-template.mjs`: one template, two callers, so a future edit to the starter
// content cannot fix one and silently miss the other. This file still owns everything specific to
// running locally against a real checkout: reading `docs/design/` off disk, writing files, and
// `atlas.config.json`'s update, none of which the API path does the same way (it reads from and
// writes to GitHub directly, in one commit — see `api/lib/approve.mjs`).
//
// Decision 1: built from source, never maintained. Every free-text field this writes is an
// unmissable placeholder naming where the real content comes from — never a plausible guess.

import { existsSync, readdirSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildManifestText, buildPlanText } from '../api/lib/manifest-template.mjs';

// Writing the two starter files is not enough to make the feature TRACKED — decision 1's whole
// point — until `atlas.config.json` names it. A directory `resolveWorkstreams` never iterates is
// exactly `unnamedFeatureDirs`' warning case (src/build.mjs), so scaffolding stops one step short
// of the milestone's own goal ("a design becomes a tracked feature") if it leaves this undone.
function promoteInConfig({ projectRoot, slug }) {
  const configPath = path.join(projectRoot, 'atlas.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!config.workstreams.includes(slug)) {
    config.workstreams = [...config.workstreams, slug];
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  }
  return configPath;
}

/**
 * Whether an approved-but-unscaffolded design exists for `slug`, and nothing already scaffolded
 * is in the way. Never throws; every refusal names exactly which precondition failed.
 *
 * @param {{ projectRoot: string, slug: string }} args
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkPreconditions({ projectRoot, slug }) {
  const approvedDir = path.join(projectRoot, 'docs', 'design', 'approved', slug);
  const proposedDir = path.join(projectRoot, 'docs', 'design', 'proposed', slug);
  const manifestPath = path.join(projectRoot, 'docs', 'features', slug, 'workstream.json');

  if (existsSync(manifestPath)) {
    return {
      ok: false,
      reason:
        `docs/features/${slug}/workstream.json already exists — this tool scaffolds a ` +
        `feature's FIRST milestone only; a workstream already on record is out of scope for it.`,
    };
  }

  const approvedExists = existsSync(approvedDir) && readdirSync(approvedDir).length > 0;
  if (!approvedExists) {
    if (existsSync(proposedDir)) {
      return {
        ok: false,
        reason:
          `docs/design/proposed/${slug}/ exists but docs/design/approved/${slug}/ does not — ` +
          `the design is still in proposed/. See docs/MILESTONE_EXECUTION.md step 3: ` +
          `implementation is not authorized until it lands in approved/.`,
      };
    }
    return {
      ok: false,
      reason:
        `docs/design/approved/${slug}/ does not exist or is empty — nothing to scaffold from. ` +
        `A design authority has to be approved and landed there first.`,
    };
  }

  return { ok: true };
}

/**
 * Write a starter workstream.json and first milestone plan for `slug`, if `checkPreconditions`
 * allows it. Refuses (writing nothing) the same way `checkPreconditions` does.
 *
 * @param {{ projectRoot: string, slug: string }} args
 * @returns {{ ok: true, written: string[] } | { ok: false, reason: string }}
 */
export function scaffoldWorkstream({ projectRoot, slug }) {
  const check = checkPreconditions({ projectRoot, slug });
  if (!check.ok) return check;

  const featureDir = path.join(projectRoot, 'docs', 'features', slug);
  mkdirSync(featureDir, { recursive: true });

  const manifestPath = path.join(featureDir, 'workstream.json');
  writeFileSync(manifestPath, buildManifestText(slug));

  const planPath = path.join(featureDir, 'm1-plan.md');
  writeFileSync(planPath, buildPlanText(slug));

  const configPath = promoteInConfig({ projectRoot, slug });

  return { ok: true, written: [manifestPath, planPath, configPath] };
}

export function parseArgv(argv) {
  return { projectRoot: argv[0], slug: argv[1] };
}

export async function main(argv) {
  const { projectRoot, slug } = parseArgv(argv);
  if (!projectRoot || !slug) {
    console.error('atlas: usage: node src/scaffold.mjs <project-root> <workstream-slug>');
    return 2;
  }
  const result = scaffoldWorkstream({ projectRoot, slug });
  if (!result.ok) {
    console.error(`atlas: scaffold refused — ${result.reason}`);
    return 1;
  }
  console.log(`atlas: scaffolded ${slug} — wrote ${result.written.join(', ')}`);
  return 0;
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
