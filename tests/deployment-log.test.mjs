// Appending deployment transitions to a JSON log.
//
// A deployment log is a JSON array of transition objects, each with a `stage` and optional `note`.
// This test suite verifies that transitions are appended correctly, preserving existing entries,
// and that absent optional fields (like `note`) are omitted rather than set to null.

import test from 'node:test';
import assert from 'node:assert/strict';

import { RecordError, appendDeploymentTransition } from '../api/lib/records.mjs';

test('appendDeploymentTransition adds one entry to an empty array', () => {
  const before = JSON.stringify([], null, 2);
  const after = appendDeploymentTransition(before, { stage: 'development' });
  assert.deepEqual(JSON.parse(after), [
    { stage: 'development' },
  ]);
});

test('appendDeploymentTransition preserves existing entries and adds one more', () => {
  const before = JSON.stringify([{ stage: 'development' }], null, 2);
  const after = appendDeploymentTransition(before, { stage: 'staging', note: 'smoke-tested' });
  assert.deepEqual(JSON.parse(after), [
    { stage: 'development' },
    { stage: 'staging', note: 'smoke-tested' },
  ]);
});

test('appendDeploymentTransition omits note when undefined', () => {
  const before = JSON.stringify([{ stage: 'development' }], null, 2);
  const after = appendDeploymentTransition(before, { stage: 'staging', note: undefined });
  assert.deepEqual(JSON.parse(after), [
    { stage: 'development' },
    { stage: 'staging' },
  ]);
});

test('appendDeploymentTransition omits note when null', () => {
  const before = JSON.stringify([{ stage: 'development' }], null, 2);
  const after = appendDeploymentTransition(before, { stage: 'staging', note: null });
  assert.deepEqual(JSON.parse(after), [
    { stage: 'development' },
    { stage: 'staging' },
  ]);
});

test('appendDeploymentTransition omits note when empty string', () => {
  const before = JSON.stringify([{ stage: 'development' }], null, 2);
  const after = appendDeploymentTransition(before, { stage: 'staging', note: '' });
  assert.deepEqual(JSON.parse(after), [
    { stage: 'development' },
    { stage: 'staging' },
  ]);
});

test('appendDeploymentTransition handles empty string or empty array as initial input', () => {
  const afterEmpty = appendDeploymentTransition('', { stage: 'development' });
  const afterArray = appendDeploymentTransition('[]', { stage: 'development' });
  assert.deepEqual(JSON.parse(afterEmpty), JSON.parse(afterArray));
  assert.deepEqual(JSON.parse(afterEmpty), [{ stage: 'development' }]);
});

// Amended for M8's Task 5 handler wiring: a real file handler now sits on top of this function
// for the first time, and its input is a committed file that can be tampered with or corrupted
// like any other record. Every other record function here (`answerQuestion`, `recordAcceptance`,
// via `assertWritable`) raises a `RecordError` on an invalid state rather than proceeding on a
// guess. Silently resetting a malformed log to `[]` would instead discard every prior transition
// with no error at all — the write would still succeed, just against a truncated log — so this
// is hardened to raise instead.
test('appendDeploymentTransition raises rather than silently discarding a malformed log', () => {
  assert.throws(
    () => appendDeploymentTransition('{not json', { stage: 'development' }),
    (error) => {
      assert.ok(error instanceof RecordError, 'not a RecordError');
      assert.equal(error.code, 'unreadable-deployment-log');
      assert.match(error.message, /not valid JSON/);
      return true;
    },
  );
});

test('appendDeploymentTransition still treats empty or whitespace-only text as a new, empty log', () => {
  // The one case malformed JSON must NOT cover: a log that has never been written yet. A missing
  // or blank file is a legitimate starting state, not corruption.
  for (const text of ['', '   ', '\n']) {
    const after = appendDeploymentTransition(text, { stage: 'development' });
    assert.deepEqual(JSON.parse(after), [{ stage: 'development' }]);
  }
});

test('appendDeploymentTransition preserves formatting with 2-space indent and trailing newline', () => {
  const before = JSON.stringify([{ stage: 'development' }], null, 2);
  const after = appendDeploymentTransition(before, { stage: 'staging' });

  // Check that it has 2-space indent
  const lines = after.split('\n');
  const indentedLines = lines.filter(line => line.startsWith('  '));
  assert.ok(indentedLines.length > 0, 'should have indented lines');

  // Check that the output ends with a newline
  assert.ok(after.endsWith('\n'), 'output should end with a newline');
});
