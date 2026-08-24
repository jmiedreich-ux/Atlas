// `planApproval` and `addWorkstreamToConfig` (api/lib/approve.mjs), in isolation — no GitHub, no
// filesystem. This is the tree-shaped counterpart of `src/scaffold.mjs`'s `checkPreconditions`,
// read from a flat tree listing instead of `existsSync` — but the two now deliberately diverge on
// one point: `scaffold.mjs` still refuses when a manifest already exists (its only job is writing
// one), while `planApproval` treats an existing manifest as "move the design in, don't scaffold
// again" rather than a refusal — see `planApproval`'s own header comment for why.
//
// A proposed design moves straight into `docs/features/<slug>/` now — there is no intermediate
// `docs/design/approved/<slug>/` stop (that split was retired, Vennusign `AGENTS.md`, amended
// 2026-08-24).

import test from 'node:test';
import assert from 'node:assert/strict';

import { ApproveError, addWorkstreamToConfig, planApproval } from '../api/lib/approve.mjs';

function blob(path, sha = `sha-${path}`) {
  return { path, mode: '100644', type: 'blob', sha };
}

const BASE_ENTRIES = [
  blob('atlas.config.json'),
  blob('docs/design/proposed/keystone/decisions.md'),
  blob('docs/design/proposed/keystone/decisions.html'),
  blob('docs/design/proposed/some-loose-file.md'), // not inside a slug directory
  blob('docs/features/other-stream/m1-plan.md'), // a real, already-scaffolded, unrelated feature
  { path: 'docs/design/proposed/keystone', mode: '040000', type: 'tree', sha: 'tree-sha' }, // the directory entry itself
];

test('planApproval: finds every file under proposed/<slug>/, and nothing outside it', () => {
  const result = planApproval({ entries: BASE_ENTRIES, slug: 'keystone' });
  assert.deepEqual(
    result.moves.map((m) => m.from).sort(),
    ['docs/design/proposed/keystone/decisions.html', 'docs/design/proposed/keystone/decisions.md'],
  );
});

test('planApproval: skips tree entries (directories) — only blobs move', () => {
  const result = planApproval({ entries: BASE_ENTRIES, slug: 'keystone' });
  assert.ok(!result.moves.some((m) => m.from === 'docs/design/proposed/keystone'));
});

test('planApproval: each move keeps the blob\'s own SHA and mode — a move reuses content, it does not re-upload', () => {
  const result = planApproval({ entries: BASE_ENTRIES, slug: 'keystone' });
  const md = result.moves.find((m) => m.from.endsWith('decisions.md'));
  assert.equal(md.sha, 'sha-docs/design/proposed/keystone/decisions.md');
  assert.equal(md.mode, '100644');
  assert.equal(md.to, 'docs/features/keystone/decisions.md');
});

test('planApproval: refuses a slug with nothing under proposed/', () => {
  assert.throws(
    () => planApproval({ entries: BASE_ENTRIES, slug: 'no-such-slug' }),
    (error) => error instanceof ApproveError && error.code === 'no-such-proposal',
  );
});

test('planApproval: a loose file with no slug directory is never approvable', () => {
  assert.throws(
    () => planApproval({ entries: BASE_ENTRIES, slug: 'some-loose-file' }),
    (error) => error instanceof ApproveError && error.code === 'no-such-proposal',
  );
});

test('planApproval: an unrelated already-scaffolded feature does not block a different slug', () => {
  // docs/features/other-stream/ existing is fine — it is a different slug entirely. Only a
  // collision on THIS slug's own destination paths should refuse (see the name-collision test
  // below).
  const result = planApproval({ entries: BASE_ENTRIES, slug: 'keystone' });
  assert.equal(result.moves.length, 2);
});

test('planApproval: refuses when a move would overwrite a file already in docs/features/<slug>/', () => {
  const entries = [...BASE_ENTRIES, blob('docs/features/keystone/decisions.md')];
  assert.throws(
    () => planApproval({ entries, slug: 'keystone' }),
    (error) => error instanceof ApproveError && error.code === 'name-collision',
  );
});

test('planApproval: a slug that already has a workstream.json still moves its design in — manifestExists is true, not a refusal', () => {
  // Real case, not hypothetical: keystone and platform-operations both had a workstream.json
  // seeded when Atlas was first adopted, long before `approve` existed, with their design still
  // sitting in proposed/. Refusing here would permanently block approving either of them.
  const entries = [...BASE_ENTRIES, blob('docs/features/keystone/workstream.json')];
  const result = planApproval({ entries, slug: 'keystone' });
  assert.equal(result.manifestExists, true);
  assert.deepEqual(
    result.moves.map((m) => m.from).sort(),
    ['docs/design/proposed/keystone/decisions.html', 'docs/design/proposed/keystone/decisions.md'],
  );
});

test('planApproval: manifestExists is false when there is nothing at docs/features/<slug>/workstream.json', () => {
  const result = planApproval({ entries: BASE_ENTRIES, slug: 'keystone' });
  assert.equal(result.manifestExists, false);
});

test('planApproval: refuses when atlas.config.json is missing entirely', () => {
  const entries = BASE_ENTRIES.filter((e) => e.path !== 'atlas.config.json');
  assert.throws(
    () => planApproval({ entries, slug: 'keystone' }),
    (error) => error instanceof ApproveError && error.code === 'no-config',
  );
});

test('planApproval: returns the config entry so the caller can read its blob', () => {
  const result = planApproval({ entries: BASE_ENTRIES, slug: 'keystone' });
  assert.equal(result.configEntry.path, 'atlas.config.json');
});

// --- addWorkstreamToConfig -------------------------------------------------------------------------

test('addWorkstreamToConfig: adds the slug, keeping the rest of the file', () => {
  const config = JSON.stringify({ project: 'X', repo: 'o/r', workstreams: ['a'] }, null, 2) + '\n';
  const result = JSON.parse(addWorkstreamToConfig(config, 'keystone'));
  assert.deepEqual(result.workstreams, ['a', 'keystone']);
  assert.equal(result.project, 'X');
});

test('addWorkstreamToConfig: is idempotent — no duplicate on a second call', () => {
  const config = JSON.stringify({ workstreams: ['keystone'] }, null, 2) + '\n';
  const result = JSON.parse(addWorkstreamToConfig(config, 'keystone'));
  assert.deepEqual(result.workstreams, ['keystone']);
});

test('addWorkstreamToConfig: refuses text that is not valid JSON', () => {
  assert.throws(
    () => addWorkstreamToConfig('{not json', 'keystone'),
    (error) => error instanceof ApproveError && error.code === 'invalid-config',
  );
});

test('addWorkstreamToConfig: refuses a config with no workstreams array', () => {
  assert.throws(
    () => addWorkstreamToConfig('{}', 'keystone'),
    (error) => error instanceof ApproveError && error.code === 'invalid-config',
  );
});
