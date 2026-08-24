// `planApproval` and `addWorkstreamToConfig` (api/lib/approve.mjs), in isolation — no GitHub, no
// filesystem. This is the tree-shaped counterpart of `src/scaffold.mjs`'s `checkPreconditions`:
// same three refusals, read from a flat tree listing instead of `existsSync`.

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
  blob('docs/design/approved/other-stream/decisions.md'),
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
  assert.equal(md.to, 'docs/design/approved/keystone/decisions.md');
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

test('planApproval: refuses a slug already under approved/, rather than merging into it', () => {
  assert.throws(
    () => planApproval({ entries: BASE_ENTRIES, slug: 'other-stream' }),
    (error) => error instanceof ApproveError && error.code === 'already-approved',
  );
});

test('planApproval: refuses a slug that already has a workstream.json', () => {
  const entries = [...BASE_ENTRIES, blob('docs/features/keystone/workstream.json')];
  assert.throws(
    () => planApproval({ entries, slug: 'keystone' }),
    (error) => error instanceof ApproveError && error.code === 'already-scaffolded',
  );
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
