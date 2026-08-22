// The pieces of Atlas's contract that the managed Function and the generator must agree on,
// letter for letter — and the proof that they are one definition rather than two that look alike.
//
// `api/lib/contract.mjs` is the single home. It lives inside the Function's own directory because
// that directory is what Static Web Apps ships: an `api_location` is packaged on its own, so a
// module the Function imports from outside it would not survive the deploy. The generator imports
// it back out through `src/schema.mjs`, which is where a reader of this repository looks for a
// closed vocabulary.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ACCEPTANCE_RESULTS, whyNotADirectoryName } from '../api/lib/contract.mjs';
import * as schema from '../src/schema.mjs';

test('contract: the acceptance vocabulary is closed, frozen and exactly pass/fail', () => {
  assert.deepEqual([...ACCEPTANCE_RESULTS], ['pass', 'fail']);
  assert.ok(Object.isFrozen(ACCEPTANCE_RESULTS), 'the vocabulary can be edited at runtime');
});

test('contract: src/schema.mjs re-exports the SAME acceptance vocabulary, not a copy of it', () => {
  // Identity, not equality. Two arrays with equal contents are exactly the drift this test exists
  // to forbid: they pass a deepEqual on the day they are written and diverge silently after.
  assert.equal(schema.ACCEPTANCE_RESULTS, ACCEPTANCE_RESULTS);
});

test('contract: the generator validates workstream slugs with the SAME function the Function does', () => {
  assert.equal(schema.whyNotADirectoryName, whyNotADirectoryName);
});

test('contract: the slug rule refuses every spelling that could escape docs/features/', () => {
  // Each of these is a path the write endpoints must never reach. The rule is the one boundary
  // stopping a workstream name from becoming a path.
  const escapes = ['.', '..', 'a/b', 'a\\b', '../outside', './beacon', '.hidden', ' beacon', 'beacon '];
  for (const bad of escapes) {
    assert.notEqual(
      whyNotADirectoryName(bad),
      '',
      `${JSON.stringify(bad)} was accepted as a directory name`,
    );
  }
  const withControlChar = `bea${String.fromCharCode(1)}con`;
  assert.notEqual(whyNotADirectoryName(withControlChar), '', 'a control character was accepted');

  assert.equal(whyNotADirectoryName('beacon'), '', 'an ordinary slug was refused');
  assert.equal(whyNotADirectoryName('tide-2'), '', 'an ordinary slug was refused');
});

test('contract: a config carrying a path-shaped workstream still fails validation by that rule', () => {
  const result = schema.validateConfig({ project: 'P', repo: 'o/n', workstreams: ['../outside'] });
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /decision 40/);
});
