import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkPreconditions, scaffoldWorkstream } from '../src/scaffold.mjs';
import { validateWorkstream } from '../src/schema.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'scaffold');
const CONFIG_PATH = path.join(FIXTURE_ROOT, 'atlas.config.json');

function readConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

function cleanReadySlug() {
  const dir = path.join(FIXTURE_ROOT, 'docs', 'features', 'ready-slug');
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  const config = readConfig();
  if (config.workstreams.includes('ready-slug')) {
    config.workstreams = config.workstreams.filter((s) => s !== 'ready-slug');
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  }
}

test('checkPreconditions: refuses a slug still under proposed/, not approved/', () => {
  const result = checkPreconditions({ projectRoot: FIXTURE_ROOT, slug: 'still-proposed-slug' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /proposed\/.*does not|still in proposed/i);
});

test('checkPreconditions: refuses a slug with no approved design at all', () => {
  const result = checkPreconditions({ projectRoot: FIXTURE_ROOT, slug: 'no-such-slug' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /approved/i);
});

test('checkPreconditions: refuses a slug that already has a workstream.json', () => {
  const result = checkPreconditions({ projectRoot: FIXTURE_ROOT, slug: 'already-scaffolded-slug' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /already exists/i);
});

test('checkPreconditions: passes for an approved, unscaffolded slug', () => {
  const result = checkPreconditions({ projectRoot: FIXTURE_ROOT, slug: 'ready-slug' });
  assert.equal(result.ok, true);
});

test('scaffoldWorkstream: refuses the same way checkPreconditions does, and writes nothing', () => {
  const result = scaffoldWorkstream({ projectRoot: FIXTURE_ROOT, slug: 'still-proposed-slug' });
  assert.equal(result.ok, false);
  assert.ok(!existsSync(path.join(FIXTURE_ROOT, 'docs/features/still-proposed-slug')));
});

test('scaffoldWorkstream: writes a workstream.json the generator accepts', () => {
  cleanReadySlug();
  const result = scaffoldWorkstream({ projectRoot: FIXTURE_ROOT, slug: 'ready-slug' });
  assert.equal(result.ok, true);
  const manifestPath = path.join(FIXTURE_ROOT, 'docs/features/ready-slug/workstream.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const validated = validateWorkstream(manifest);
  assert.ok(validated.ok, `scaffolded manifest is not schema-valid: ${JSON.stringify(validated.errors)}`);
  assert.equal(manifest.stage, 'designing');
  assert.equal(manifest.milestones.length, 1);
  assert.equal(manifest.milestones[0].id, 'M1');
  assert.equal(manifest.milestones[0].status, 'unplanned');
  assert.match(manifest.milestones[0].title, /<<.*replace.*>>/i);
  assert.match(manifest.next, /<<.*replace.*>>/i);
  cleanReadySlug();
});

test("scaffoldWorkstream: writes a plan file at the path the manifest names", () => {
  cleanReadySlug();
  scaffoldWorkstream({ projectRoot: FIXTURE_ROOT, slug: 'ready-slug' });
  const planPath = path.join(FIXTURE_ROOT, 'docs/features/ready-slug/m1-plan.md');
  assert.ok(existsSync(planPath));
  const plan = readFileSync(planPath, 'utf8');
  assert.match(plan, /^# .+ Milestone 1/m);
  assert.match(plan, /## Goal/);
  assert.match(plan, /## Spec/);
  assert.match(plan, /docs\/design\/approved\/ready-slug/);
  cleanReadySlug();
});

test('scaffoldWorkstream: promotes the slug into atlas.config.json — otherwise it never renders', () => {
  cleanReadySlug();
  assert.ok(!readConfig().workstreams.includes('ready-slug'));
  const result = scaffoldWorkstream({ projectRoot: FIXTURE_ROOT, slug: 'ready-slug' });
  assert.equal(result.ok, true);
  assert.ok(readConfig().workstreams.includes('ready-slug'));
  cleanReadySlug();
});

test('scaffoldWorkstream: promoting the slug is idempotent — no duplicate entry on a second run', () => {
  cleanReadySlug();
  scaffoldWorkstream({ projectRoot: FIXTURE_ROOT, slug: 'ready-slug' });
  // A second attempt refuses (workstream.json now exists) but must not have duplicated the
  // config entry on the first call, and calling checkPreconditions/scaffoldWorkstream again must
  // not touch the config at all since it refuses before ever reaching that step.
  scaffoldWorkstream({ projectRoot: FIXTURE_ROOT, slug: 'ready-slug' });
  const occurrences = readConfig().workstreams.filter((s) => s === 'ready-slug').length;
  assert.equal(occurrences, 1);
  cleanReadySlug();
});

test('CLI: exit 0 and prints the written paths on success', () => {
  cleanReadySlug();
  const output = execFileSync('node', [path.join(REPO_ROOT, 'src/scaffold.mjs'), FIXTURE_ROOT, 'ready-slug'], {
    encoding: 'utf8',
  });
  assert.match(output, /atlas:.*ready-slug/);
  cleanReadySlug();
});

test('CLI: exit 1 and names the reason on a refused precondition', () => {
  assert.throws(
    () =>
      execFileSync('node', [path.join(REPO_ROOT, 'src/scaffold.mjs'), FIXTURE_ROOT, 'still-proposed-slug'], {
        encoding: 'utf8',
      }),
    (err) => err.status === 1 && /proposed/i.test(err.stderr ?? err.stdout ?? ''),
  );
});

test('CLI: exit 2 on missing arguments', () => {
  assert.throws(
    () => execFileSync('node', [path.join(REPO_ROOT, 'src/scaffold.mjs')], { encoding: 'utf8' }),
    (err) => err.status === 2,
  );
});
