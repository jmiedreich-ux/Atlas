import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTasks } from '../src/tasks.mjs';

test('parseTasks: reads an unchecked and a checked task, in document order', () => {
  const body = [
    '- [ ] First task',
    '- [x] Second task',
  ].join('\n');
  assert.deepEqual(parseTasks(body), [
    { text: 'First task', done: false, owner: null },
    { text: 'Second task', done: true, owner: null },
  ]);
});

test('parseTasks: the checkbox mark is case-insensitive', () => {
  const body = '- [X] Done with a capital X';
  assert.deepEqual(parseTasks(body), [
    { text: 'Done with a capital X', done: true, owner: null },
  ]);
});

test('parseTasks: an owner tag after an em-dash is parsed and stripped', () => {
  const body = '- [x] Write-back endpoint deployed — Claude';
  assert.deepEqual(parseTasks(body), [
    { text: 'Write-back endpoint deployed', done: true, owner: 'Claude' },
  ]);
});

test('parseTasks: an owner tag after a plain hyphen is also parsed', () => {
  const body = '- [ ] Supply App credentials to the server - Claude';
  assert.deepEqual(parseTasks(body), [
    { text: 'Supply App credentials to the server', done: false, owner: 'Claude' },
  ]);
});

test('parseTasks: a hyphen with no surrounding space is not mistaken for an owner tag', () => {
  // "Write-back" is one word. The owner tag convention requires whitespace before the dash.
  const body = '- [ ] Write-back endpoint deployed';
  assert.deepEqual(parseTasks(body), [
    { text: 'Write-back endpoint deployed', done: false, owner: null },
  ]);
});

test('parseTasks: a task with no owner tag is unassigned', () => {
  const body = '- [ ] Backfill migration';
  assert.deepEqual(parseTasks(body), [
    { text: 'Backfill migration', done: false, owner: null },
  ]);
});

test('parseTasks: non-checklist lines are ignored, in a real issue body', () => {
  const body = [
    '## Sub-tasks',
    '',
    'Some prose about this milestone.',
    '',
    '- [x] First real task',
    '- Not a checklist item, just a bullet',
    '- [ ] Second real task',
    '',
    '> A blockquote, also not a task',
  ].join('\n');
  assert.deepEqual(parseTasks(body), [
    { text: 'First real task', done: true, owner: null },
    { text: 'Second real task', done: false, owner: null },
  ]);
});

test('parseTasks: null, undefined and an empty string all yield no tasks', () => {
  assert.deepEqual(parseTasks(null), []);
  assert.deepEqual(parseTasks(undefined), []);
  assert.deepEqual(parseTasks(''), []);
});

// --- the owner tag is the LAST dash-delimited segment, not the first (final branch review) ------

test('parseTasks: the owner tag is the trailing dash, even when the task text has an earlier one', () => {
  const body = '- [ ] Deploy - staging and prod — Claude';
  assert.deepEqual(parseTasks(body), [
    { text: 'Deploy - staging and prod', done: false, owner: 'Claude' },
  ]);
});

test('parseTasks: two dashes in one line — the owner is the segment after the LAST one', () => {
  const body = '- [ ] Wire up A — B — Claude';
  assert.deepEqual(parseTasks(body), [
    { text: 'Wire up A — B', done: false, owner: 'Claude' },
  ]);
});

test('parseTasks: a single trailing hyphen is read as an owner tag even when it reads like plain text', () => {
  // Genuinely ambiguous: "bar" could be an owner name or the last word of the task. The parser has
  // no way to tell a name from an ordinary word, and it is not asked to — the convention is
  // purely positional (whitespace, dash, whitespace, then the rest of the line), so a single
  // trailing " - word" always reads as an owner tag, exactly as a single trailing " - Claude"
  // does. This is the natural, honest output of the position-only rule; there is no separate case
  // for "looks like a name" to fall back to.
  const body = '- [x] Rename foo - bar';
  assert.deepEqual(parseTasks(body), [
    { text: 'Rename foo', done: true, owner: 'bar' },
  ]);
});

test('parseTasks: an en-dash also introduces an owner tag', () => {
  const body = '- [ ] Ship the release – Ada';
  assert.deepEqual(parseTasks(body), [
    { text: 'Ship the release', done: false, owner: 'Ada' },
  ]);
});

test('parseTasks: sequential and flat — an indented sub-item is read as an ordinary top-level task', () => {
  const body = [
    '- [ ] Parent task',
    '  - [ ] Indented item',
  ].join('\n');
  assert.deepEqual(parseTasks(body), [
    { text: 'Parent task', done: false, owner: null },
    { text: 'Indented item', done: false, owner: null },
  ]);
});
