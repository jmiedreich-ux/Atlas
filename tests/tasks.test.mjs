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
