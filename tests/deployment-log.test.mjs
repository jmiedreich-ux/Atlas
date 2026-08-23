// Appending deployment transitions to a JSON log.
//
// A deployment log is a JSON array of transition objects, each with a `stage` and optional `note`.
// This test suite verifies that transitions are appended correctly, preserving existing entries,
// and that absent optional fields (like `note`) are omitted rather than set to null.

import test from 'node:test';
import assert from 'node:assert/strict';

import { appendDeploymentTransition } from '../api/lib/records.mjs';

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
