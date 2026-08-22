// Placing the write-back Function where a workflow can name it as `api_location`.
//
// This is a second destructive act on a caller-supplied path, and this repository has already
// shipped one hole in the first (`src/outdir.mjs`, and the comment at the top of it). So it reuses
// that guard rather than growing a weaker second one, and it lives in a module with tests rather
// than in a shell block inside `action.yml`, where nothing could reach it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { placeApi } from '../src/place-api.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARENA = path.join(REPO_ROOT, '.tmp-tests', 'place-api');

let sequence = 0;

function project() {
  const root = path.join(ARENA, `case-${(sequence += 1)}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(path.join(root, 'docs', 'features'), { recursive: true });
  writeFileSync(path.join(root, 'atlas.config.json'), '{}\n');
  writeFileSync(path.join(root, 'ROADMAP.md'), '# Roadmap\n');
  return root;
}

function refusal(root, apiDir, outDir) {
  try {
    placeApi(root, apiDir, outDir);
    return null;
  } catch (error) {
    return error.message;
  }
}

test('place-api: the deployable arrives whole, and is a Function app when it lands', () => {
  const root = project();
  const where = placeApi(root, path.join(root, '.atlas-api'), path.join(root, '.atlas-out'));

  assert.ok(existsSync(path.join(where, 'host.json')));
  assert.ok(existsSync(path.join(where, 'answer', 'function.json')));
  assert.ok(existsSync(path.join(where, 'acceptance', 'function.json')));
  assert.ok(existsSync(path.join(where, 'lib', 'handlers.mjs')));
  assert.equal(JSON.parse(readFileSync(path.join(where, 'package.json'), 'utf8')).type, 'module');
});

test('place-api: it replaces what was there, so a removed file does not survive the next run', () => {
  const root = project();
  const target = path.join(root, '.atlas-api');
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'left-over.mjs'), '// from a previous version of Atlas\n');

  placeApi(root, target, path.join(root, '.atlas-out'));
  assert.ok(!existsSync(path.join(target, 'left-over.mjs')), 'a stale file survived the placement');
});

test('place-api: it refuses to write over the output directory, in either direction', () => {
  const root = project();
  const out = path.join(root, '.atlas-out');

  assert.match(refusal(root, out, out), /output/i);
  assert.match(refusal(root, path.join(out, 'api'), out), /output/i);
  assert.match(refusal(root, path.dirname(out) === root ? root : out, out), /./);
});

test("place-api: it refuses every path the build reads — the guard is src/outdir.mjs's, not a second one", () => {
  const root = project();
  const out = path.join(root, '.atlas-out');

  for (const forbidden of [root, path.join(root, 'docs'), path.join(root, 'ROADMAP.md'), REPO_ROOT, path.join(REPO_ROOT, 'api')]) {
    assert.ok(refusal(root, forbidden, out), `the guard allowed ${forbidden}`);
  }
});

test('place-api: it refuses the filesystem root, which is the one that costs everything', () => {
  const root = project();
  assert.ok(refusal(root, path.parse(root).root, path.join(root, '.atlas-out')));
});

test('place-api: an empty destination places nothing and says so, rather than guessing one', () => {
  const root = project();
  assert.equal(placeApi(root, '', path.join(root, '.atlas-out')), '');
});
