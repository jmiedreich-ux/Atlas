import test from 'node:test';
import assert from 'node:assert/strict';

import { MILESTONE_STATUSES, validateWorkstream, validateConfig } from '../src/schema.mjs';

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

test('validateWorkstream: a milestone with status absent entirely is rejected', () => {
  const manifest = validManifest();
  delete manifest.milestones[0].status; // absent, not merely an unrecognised value
  const result = validateWorkstream(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'milestones[0].status'));
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

test('validateWorkstream: a milestone missing plan is rejected', () => {
  const manifest = validManifest();
  delete manifest.milestones[0].plan;
  const result = validateWorkstream(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'milestones[0].plan'));
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

test('validateWorkstream: a design entry missing name or where is rejected', () => {
  for (const field of ['name', 'where']) {
    const manifest = validManifest();
    delete manifest.design[0][field];
    const result = validateWorkstream(manifest);
    assert.equal(result.ok, false, `expected a design entry missing "${field}" to fail validation`);
    assert.ok(
      result.errors.some((e) => e.path === `design[0].${field}`),
      `expected an error at path "design[0].${field}", got: ${JSON.stringify(result.errors)}`,
    );
  }
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

test('validateWorkstream: an otherwise-valid manifest with an uncloneable extra property does not throw', () => {
  // Passing every named-field check says nothing about an unvalidated extra property. A
  // function cannot be structured-cloned, so this exercises the clone-on-success path without
  // going through any of the named checks above.
  const manifest = validManifest();
  manifest.extra = () => {};
  assert.doesNotThrow(() => validateWorkstream(manifest));
  const result = validateWorkstream(manifest);
  assert.equal(result.ok, false);
  assert.equal('value' in result, false);
  assert.ok(Array.isArray(result.errors));
  assert.ok(result.errors.length > 0);
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

test('validateConfig: an otherwise-valid config with an uncloneable extra property does not throw', () => {
  const config = validConfig();
  config.extra = () => {};
  assert.doesNotThrow(() => validateConfig(config));
  const result = validateConfig(config);
  assert.equal(result.ok, false);
  assert.equal('value' in result, false);
  assert.ok(Array.isArray(result.errors));
  assert.ok(result.errors.length > 0);
});

test('validateConfig: a failing result never carries a value', () => {
  const result = validateConfig({});
  assert.equal(result.ok, false);
  assert.equal('value' in result, false);
});

// Small builders over the two factories above, so the uniqueness cases below say only what makes
// them different from a valid manifest.
function ms(overrides) {
  return { ...validManifest().milestones[0], ...overrides };
}

function withMilestones(overrides) {
  return { ...validManifest(), ...overrides };
}

// --- decision 32: a name that collides is a record somebody has to fix ----------------------

test('validateConfig: the same workstream declared twice fails, naming both positions', () => {
  // `triageBySlug` in src/build.mjs keys the ordered cards by slug, so a duplicate collapses into
  // one card: the workstream is classified twice, ordered twice, and then one of them silently
  // disappears from the surface built to say what needs the owner.
  const result = validateConfig({
    project: 'Duplicated',
    repo: 'example-org/duplicated',
    workstreams: ['nova', 'pulsar', 'nova'],
  });

  assert.equal(result.ok, false);
  const message = result.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
  assert.match(message, /workstreams\[2\]/, message);
  assert.match(message, /workstreams\[0\]/, message);
  assert.match(message, /nova/, message);
});

test('validateConfig: distinct workstreams that merely look alike are fine', () => {
  const result = validateConfig({
    project: 'Fine',
    repo: 'example-org/fine',
    workstreams: ['nova', 'nova-2', 'supernova'],
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('validateWorkstream: two milestone ids that differ only in case fail', () => {
  // A milestone page is written at `<slug>/<id lowercased>/`, so `M1` and `m1` are one directory
  // and one URL: whichever renders second overwrites the first, and the site shows one milestone
  // where the record has two.
  const result = validateWorkstream(
    withMilestones({
      milestones: [
        ms({ id: 'M1', label: 'M1', depth: 1 }),
        ms({ id: 'm1', label: 'm1', depth: 2 }),
      ],
    }),
  );

  assert.equal(result.ok, false);
  const message = result.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
  assert.match(message, /milestones\[1\]/, message);
  assert.match(message, /milestones\[0\]/, message);
  assert.match(message, /case/i, message);
});

test('validateWorkstream: the same milestone id twice fails, whatever else differs', () => {
  const result = validateWorkstream(
    withMilestones({
      milestones: [
        ms({ id: 'M1', label: 'M1', depth: 1, title: 'One' }),
        ms({ id: 'M1', label: 'M1 again', depth: 2, title: 'Another' }),
      ],
    }),
  );
  assert.equal(result.ok, false);
  assert.match(
    result.errors.map((e) => e.message).join('; '),
    /same page|already used/i,
    JSON.stringify(result.errors),
  );
});

test('validateWorkstream: distinct milestone ids pass, including ones that share a prefix', () => {
  const result = validateWorkstream(
    withMilestones({
      milestones: [
        ms({ id: 'M1', label: 'M1', depth: 1 }),
        ms({ id: 'M1.1', label: 'M1.1', depth: 2 }),
        ms({ id: 'M10', label: 'M10', depth: 3 }),
      ],
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

// --- decision 40: a workstream entry is a directory NAME, not a path ------------------------

test('validateConfig: a workstream entry that climbs out of docs/features is rejected', () => {
  // Executed before this rule existed: `["beacon", "../features/beacon"]` built with EXIT 0 and
  // "built 34 pages". The second entry resolved back onto the first workstream's directory, so one
  // workstream silently had no page of its own and `state.json` carried the slug
  // `"../features/beacon"`. That is exactly what the duplicate-slug check exists to prevent,
  // reached by a different spelling — `path.join` collapses the traversal, so the two entries are
  // distinct strings naming one directory.
  const result = validateConfig({
    project: 'Traversing',
    repo: 'example-org/traversing',
    workstreams: ['beacon', '../features/beacon'],
  });

  assert.equal(result.ok, false);
  const failure = result.errors.find((e) => e.path === 'workstreams[1]');
  assert.ok(failure, JSON.stringify(result.errors));
  assert.match(failure.message, /not a path/i, failure.message);
  assert.ok(failure.message.includes('"../features/beacon"'), failure.message);
});

test('validateConfig: every shape that is a path rather than a name is rejected', () => {
  // Each of these was executed against the real CLI before the rule existed. None of them failed
  // in a way decision 32 would recognise: one built, and the other three surfaced a raw Eleventy
  // or Node error naming an absolute path on this machine — which is also I8's convention broken.
  const shapes = [
    ['../features/beacon', 'climbs out and lands back inside — built at exit 0'],
    ['./beacon', 'raw Eleventy "Output conflict:" naming an absolute staging path'],
    ['../../outside-ws', 'raw ENOENT, and the output guard cannot protect where it points'],
    ['tide/../beacon', 'raw ENOENT naming a path inside the generator\'s own theme directory'],
    ['nested/slug', 'a path, not a name'],
    ['..', 'the parent directory'],
    ['.', 'the workstreams directory itself'],
    ['.hidden', 'a dot-directory, which the records walk skips — its records would never render'],
    ['back\\slash', 'a Windows path separator'],
    ['/absolute', 'an absolute path'],
  ];

  for (const [slug, why] of shapes) {
    const result = validateConfig({
      project: 'Shapes',
      repo: 'example-org/shapes',
      workstreams: [slug],
    });
    assert.equal(result.ok, false, `${JSON.stringify(slug)} was accepted, and it is ${why}`);
    const failure = result.errors.find((e) => e.path === 'workstreams[0]');
    assert.ok(failure, `${JSON.stringify(slug)}: rejected, but not at its own position`);
    assert.ok(
      failure.message.includes(JSON.stringify(slug)),
      `${JSON.stringify(slug)}: the failure does not quote the entry — ${failure.message}`,
    );
  }
});

test('validateConfig: ordinary directory names are still accepted, punctuation included', () => {
  // The rule must not be so tight that it refuses names a project may legitimately have chosen.
  const fine = ['beacon', 'har-bor', 'har bor', 'tide_2', 'M1', 'a.b', 'workstream.v2', '2024-q3'];
  const result = validateConfig({
    project: 'Fine',
    repo: 'example-org/fine',
    workstreams: fine,
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.value.workstreams, fine);
});

// --- M2.1, from #780: `gated` becomes `blocked` -------------------------------------------------

test('schema: the closed milestone vocabulary says "blocked", and no longer says "gated"', () => {
  // #780: "Drop the word 'gated'." It describes a gate the owner holds, which is what the
  // workstream's own `gate` field is for; on a milestone the fact is simply that it cannot start.
  // The phone view already had a `blocked` triage state reading "Blocked", so this leaves one word
  // in the product rather than two that nearly mean the same thing.
  assert.deepEqual([...MILESTONE_STATUSES], ['done', 'next', 'blocked', 'parked', 'unplanned']);
});

test('schema: a manifest still saying "gated" is refused by name, not quietly accepted', () => {
  const manifest = validManifest();
  manifest.milestones[0].status = 'gated';

  const result = validateWorkstream(manifest);
  assert.equal(result.ok, false, 'the retired word was accepted');

  const message = result.errors.map((e) => `${e.path}: ${e.message}`).join('\n');
  assert.match(message, /"gated"/, 'the failure never quotes the value that is wrong');
  assert.match(message, /blocked/, 'the failure never names the word to use instead');
});

test('schema: "blocked" is accepted on a milestone', () => {
  const manifest = validManifest();
  manifest.milestones[0].status = 'blocked';

  const result = validateWorkstream(manifest);
  assert.equal(result.ok, true, `blocked was refused: ${JSON.stringify(result.errors)}`);
  assert.equal(result.value.milestones[0].status, 'blocked');
});
