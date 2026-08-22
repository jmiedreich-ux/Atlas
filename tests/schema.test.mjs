import test from 'node:test';
import assert from 'node:assert/strict';

import { validateWorkstream, validateConfig } from '../src/schema.mjs';

// All fixture data below is invented for this test file only — the generator holds no
// project content of its own (decision 40).

function validManifest() {
  return {
    codename: 'Nova',
    what: 'A sample workstream used only to exercise the schema',
    stage: 'planned',
    position: 'Designed, not approved',
    gate: 'Owner sign-off before build',
    label: 'workstream:nova',
    design: [{ name: 'nova/Overview v1', where: 'design-project' }],
    milestones: [
      {
        id: 'M1',
        label: 'M1',
        depth: 1,
        title: 'Foundation contract',
        status: 'next',
        plan: 'm1-plan.md',
        issue: null,
        pr: null,
        acceptance: { kind: 'demo-script', record: null },
      },
    ],
  };
}

function validConfig() {
  return {
    project: 'Nova Project',
    repo: 'example-org/nova',
    workstreams: ['nova', 'atlas-demo'],
  };
}

// --- validateWorkstream ---------------------------------------------------

test('validateWorkstream: a well-formed manifest validates', () => {
  const manifest = validManifest();
  const result = validateWorkstream(manifest);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, manifest);
});

test('validateWorkstream: an unknown stage is rejected by name', () => {
  const manifest = validManifest();
  manifest.stage = 'blocked'; // not in the closed vocabulary
  const result = validateWorkstream(manifest);
  assert.equal(result.ok, false);
  const stageError = result.errors.find((e) => e.path === 'stage');
  assert.ok(stageError, 'expected an error at path "stage"');
  assert.match(stageError.message, /blocked/);
});

test('validateWorkstream: an unknown milestone status is rejected by name', () => {
  const manifest = validManifest();
  manifest.milestones[0].status = 'wontfix'; // not in the closed vocabulary
  const result = validateWorkstream(manifest);
  assert.equal(result.ok, false);
  const statusError = result.errors.find((e) => e.path === 'milestones[0].status');
  assert.ok(statusError, 'expected an error at path "milestones[0].status"');
  assert.match(statusError.message, /wontfix/);
});

test('validateWorkstream: a milestone missing title is rejected', () => {
  const manifest = validManifest();
  delete manifest.milestones[0].title;
  const result = validateWorkstream(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'milestones[0].title'));
});

test('validateWorkstream: a milestone missing depth is rejected', () => {
  const manifest = validManifest();
  delete manifest.milestones[0].depth;
  const result = validateWorkstream(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'milestones[0].depth'));
});

test('validateWorkstream: id and label are both required and may differ', () => {
  const manifest = validManifest();
  // Decision 17: historical ids are preserved even when the display label normalises.
  manifest.milestones[0].id = 'M6a';
  manifest.milestones[0].label = 'M6';
  const result = validateWorkstream(manifest);
  assert.equal(result.ok, true);
  assert.equal(result.value.milestones[0].id, 'M6a');
  assert.equal(result.value.milestones[0].label, 'M6');
});

test('validateWorkstream: a milestone missing id is rejected', () => {
  const manifest = validManifest();
  delete manifest.milestones[0].id;
  const result = validateWorkstream(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'milestones[0].id'));
});

test('validateWorkstream: a milestone missing label is rejected', () => {
  const manifest = validManifest();
  delete manifest.milestones[0].label;
  const result = validateWorkstream(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'milestones[0].label'));
});

test('validateWorkstream: issue, pr and acceptance.record are nullable', () => {
  const manifest = validManifest();
  manifest.milestones[0].issue = null;
  manifest.milestones[0].pr = null;
  manifest.milestones[0].acceptance = { kind: 'demo-script', record: null };
  const result = validateWorkstream(manifest);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('validateWorkstream: issue, pr and acceptance.record accept real values too', () => {
  const manifest = validManifest();
  manifest.milestones[0].issue = 42;
  manifest.milestones[0].pr = 7;
  manifest.milestones[0].acceptance = { kind: 'demo-script', record: 'docs/features/nova/m1-demo.md' };
  const result = validateWorkstream(manifest);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('validateWorkstream: acceptance missing entirely is rejected', () => {
  const manifest = validManifest();
  delete manifest.milestones[0].acceptance;
  const result = validateWorkstream(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'milestones[0].acceptance'));
});

test('validateWorkstream: acceptance missing kind is rejected', () => {
  const manifest = validManifest();
  manifest.milestones[0].acceptance = { record: null };
  const result = validateWorkstream(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'milestones[0].acceptance.kind'));
});

test('validateWorkstream: every error names the path that failed', () => {
  const manifest = validManifest();
  delete manifest.codename;
  manifest.stage = 'not-a-real-stage';
  const result = validateWorkstream(manifest);
  assert.equal(result.ok, false);
  for (const error of result.errors) {
    assert.equal(typeof error.path, 'string');
    assert.equal(typeof error.message, 'string');
    assert.ok(error.message.length > 0);
  }
  const paths = result.errors.map((e) => e.path);
  assert.ok(paths.includes('codename'));
  assert.ok(paths.includes('stage'));
});

test('validateWorkstream: never throws on non-object input', () => {
  for (const bad of [null, undefined, 42, 'a string', ['array'], true]) {
    assert.doesNotThrow(() => validateWorkstream(bad));
    const result = validateWorkstream(bad);
    assert.equal(result.ok, false);
    assert.ok(Array.isArray(result.errors));
    assert.ok(result.errors.length > 0);
  }
});

test('validateWorkstream: a failing result never carries a value', () => {
  const result = validateWorkstream({});
  assert.equal(result.ok, false);
  assert.equal('value' in result, false);
});

test('validateWorkstream: rejects a manifest missing required top-level fields', () => {
  for (const field of ['codename', 'what', 'stage', 'position', 'gate', 'label', 'design', 'milestones']) {
    const manifest = validManifest();
    delete manifest[field];
    const result = validateWorkstream(manifest);
    assert.equal(result.ok, false, `expected missing "${field}" to fail validation`);
    assert.ok(
      result.errors.some((e) => e.path === field),
      `expected an error at path "${field}", got: ${JSON.stringify(result.errors)}`,
    );
  }
});

// --- validateConfig --------------------------------------------------------

test('validateConfig: a well-formed config validates', () => {
  const config = validConfig();
  const result = validateConfig(config);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, config);
});

test('validateConfig: missing project is rejected', () => {
  const config = validConfig();
  delete config.project;
  const result = validateConfig(config);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'project'));
});

test('validateConfig: a malformed repo is rejected by name', () => {
  const config = validConfig();
  config.repo = 'not-a-valid-repo-slug';
  const result = validateConfig(config);
  assert.equal(result.ok, false);
  const repoError = result.errors.find((e) => e.path === 'repo');
  assert.ok(repoError);
  assert.match(repoError.message, /not-a-valid-repo-slug/);
});

test('validateConfig: workstreams must be an array of non-empty strings', () => {
  const config = validConfig();
  config.workstreams = ['nova', '', 42];
  const result = validateConfig(config);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'workstreams[1]'));
  assert.ok(result.errors.some((e) => e.path === 'workstreams[2]'));
});

test('validateConfig: workstreams missing entirely is rejected', () => {
  const config = validConfig();
  delete config.workstreams;
  const result = validateConfig(config);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'workstreams'));
});

test('validateConfig: never throws on non-object input', () => {
  for (const bad of [null, undefined, 42, 'a string', ['array'], true]) {
    assert.doesNotThrow(() => validateConfig(bad));
    const result = validateConfig(bad);
    assert.equal(result.ok, false);
    assert.ok(Array.isArray(result.errors));
    assert.ok(result.errors.length > 0);
  }
});

test('validateConfig: a failing result never carries a value', () => {
  const result = validateConfig({});
  assert.equal(result.ok, false);
  assert.equal('value' in result, false);
});
