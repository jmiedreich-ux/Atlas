// A local CLI that turns an approved, unscaffolded design into a starter workstream.json and
// first milestone plan (Atlas M7).
//
// Never invoked from the website or from write-back — decision 35's two writable things (a
// register answer, an acceptance result) stay exactly two. This is a local tool, run against a
// real checkout the same way `node src/build.mjs` already is, its output committed through
// ordinary git.
//
// Decision 1: built from source, never maintained. Every free-text field this writes is an
// unmissable placeholder naming where the real content comes from — never a plausible guess.

import { existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PLACEHOLDER = (hint) => `<< M7 scaffold: replace this — ${hint} >>`;

function titleize(slug) {
  return slug
    .split('-')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
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

  const codename = titleize(slug);
  const featureDir = path.join(projectRoot, 'docs', 'features', slug);
  mkdirSync(featureDir, { recursive: true });

  const manifest = {
    codename,
    what: PLACEHOLDER(`what is ${codename}, in one sentence — see docs/design/approved/${slug}/`),
    stage: 'designing',
    position: PLACEHOLDER('where this stands right now'),
    gate: PLACEHOLDER('what is actually blocking work from starting, in one sentence'),
    label: `workstream:${slug}`,
    design: [{ name: `${slug}/approved design`, where: `docs/design/approved/${slug}/` }],
    milestones: [
      {
        id: 'M1',
        label: 'M1',
        depth: 1,
        title: PLACEHOLDER(`M1's real title — see docs/design/approved/${slug}/`),
        status: 'unplanned',
        plan: 'm1-plan.md',
        issue: null,
        pr: null,
        acceptance: { kind: 'demo-script', record: null },
      },
    ],
  };

  const manifestPath = path.join(featureDir, 'workstream.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  const planPath = path.join(featureDir, 'm1-plan.md');
  const plan = `# ${codename} Milestone 1 — ${PLACEHOLDER("this milestone's title")}

> This is a scaffold, not a plan. Every section below names what to fill in and from where.

## Goal

${PLACEHOLDER('one sentence — what does this milestone actually deliver')}

## Where it will land

${PLACEHOLDER('which repository, which files')}

## Spec

docs/design/approved/${slug}/ — read it before writing anything else in this file.
`;
  writeFileSync(planPath, plan);

  return { ok: true, written: [manifestPath, planPath] };
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
