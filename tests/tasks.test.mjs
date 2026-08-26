import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTasks } from '../src/tasks.mjs';

test('parseTasks: reads an unchecked and a checked task, in document order', () => {
  const body = [
    '- [ ] First task',
    '- [x] Second task',
  ].join('\n');
  assert.deepEqual(parseTasks(body), [
    { id: null, text: 'First task', done: false, owner: null, location: null },
    { id: null, text: 'Second task', done: true, owner: null, location: null },
  ]);
});

test('parseTasks: the checkbox mark is case-insensitive', () => {
  const body = '- [X] Done with a capital X';
  assert.deepEqual(parseTasks(body), [
    { id: null, text: 'Done with a capital X', done: true, owner: null, location: null },
  ]);
});

test('parseTasks: an owner tag after an em-dash is parsed and stripped', () => {
  const body = '- [x] Write-back endpoint deployed — Claude';
  assert.deepEqual(parseTasks(body), [
    { id: null, text: 'Write-back endpoint deployed', done: true, owner: 'Claude', location: null },
  ]);
});

test('parseTasks: an owner tag after a plain hyphen is also parsed', () => {
  const body = '- [ ] Supply App credentials to the server - Claude';
  assert.deepEqual(parseTasks(body), [
    { id: null, text: 'Supply App credentials to the server', done: false, owner: 'Claude', location: null },
  ]);
});

test('parseTasks: a hyphen with no surrounding space is not mistaken for an owner tag', () => {
  // "Write-back" is one word. The owner tag convention requires whitespace before the dash.
  const body = '- [ ] Write-back endpoint deployed';
  assert.deepEqual(parseTasks(body), [
    { id: null, text: 'Write-back endpoint deployed', done: false, owner: null, location: null },
  ]);
});

test('parseTasks: a task with no owner tag is unassigned', () => {
  const body = '- [ ] Backfill migration';
  assert.deepEqual(parseTasks(body), [
    { id: null, text: 'Backfill migration', done: false, owner: null, location: null },
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
    { id: null, text: 'First real task', done: true, owner: null, location: null },
    { id: null, text: 'Second real task', done: false, owner: null, location: null },
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
    { id: null, text: 'Deploy - staging and prod', done: false, owner: 'Claude', location: null },
  ]);
});

test('parseTasks: two dashes in one line — the owner is the segment after the LAST one', () => {
  const body = '- [ ] Wire up A — B — Claude';
  assert.deepEqual(parseTasks(body), [
    { id: null, text: 'Wire up A — B', done: false, owner: 'Claude', location: null },
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
    { id: null, text: 'Rename foo', done: true, owner: 'bar', location: null },
  ]);
});

test('parseTasks: an en-dash also introduces an owner tag', () => {
  const body = '- [ ] Ship the release – Ada';
  assert.deepEqual(parseTasks(body), [
    { id: null, text: 'Ship the release', done: false, owner: 'Ada', location: null },
  ]);
});

test('parseTasks: sequential and flat — an indented sub-item is read as an ordinary top-level task', () => {
  const body = [
    '- [ ] Parent task',
    '  - [ ] Indented item',
  ].join('\n');
  assert.deepEqual(parseTasks(body), [
    { id: null, text: 'Parent task', done: false, owner: null, location: null },
    { id: null, text: 'Indented item', done: false, owner: null, location: null },
  ]);
});

// --- a task id (decision 62, draft): "T3 · text", the register-question id shape, a `·` required -

test('parseTasks: a leading id tag before a middle dot is read and stripped', () => {
  const body = '- [ ] T3 · Move dialog to the item panel';
  assert.deepEqual(parseTasks(body), [
    { id: 'T3', text: 'Move dialog to the item panel', done: false, owner: null, location: null },
  ]);
});

test('parseTasks: a task with no id tag still parses exactly as before — id is null, not a defect', () => {
  const body = '- [ ] Move dialog to the item panel';
  assert.deepEqual(parseTasks(body), [
    { id: null, text: 'Move dialog to the item panel', done: false, owner: null, location: null },
  ]);
});

test('parseTasks: an id-shaped word with no middle dot is ordinary text, not an id', () => {
  // "T3" alone, with no `·` after it, is not the id convention — it is just the first word of the
  // task. Whitespace is not the separator here (unlike a register heading's first-token rule);
  // only the middle dot is, precisely so a task that happens to start with something id-shaped
  // never gets misread.
  const body = '- [ ] T3 create the menu';
  assert.deepEqual(parseTasks(body), [
    { id: null, text: 'T3 create the menu', done: false, owner: null, location: null },
  ]);
});

test('parseTasks: letters with no digit before a middle dot is not a valid id shape', () => {
  // Mirrors headingId's own guard (api/lib/records.mjs) that a plain word like "Open" must not be
  // read as an id: the shape requires at least one digit, so "AB · text" stays ordinary text with
  // a literal middle dot in it, not id "AB".
  const body = '- [ ] AB · Ordinary text starting with two letters and a dot';
  assert.deepEqual(parseTasks(body), [
    { id: null, text: 'AB · Ordinary text starting with two letters and a dot', done: false, owner: null, location: null },
  ]);
});

test('parseTasks: an id tag and a trailing owner tag on the same line both parse', () => {
  const body = '- [x] T7 · Ship the release – Ada';
  assert.deepEqual(parseTasks(body), [
    { id: 'T7', text: 'Ship the release', done: true, owner: 'Ada', location: null },
  ]);
});

test('parseTasks: a compound, multi-segment packet id (real-world shape: CG-M1-01) is read and stripped', () => {
  const body = '- [ ] CG-M1-01 · Working install, dev, build, and browser-test commands recorded.';
  assert.deepEqual(parseTasks(body), [
    {
      id: 'CG-M1-01',
      text: 'Working install, dev, build, and browser-test commands recorded.',
      done: false,
      owner: null,
      location: null,
    },
  ]);
});

test('parseTasks: a compound id with no digit anywhere in it is rejected, same as a simple one', () => {
  // Mirrors the simple-shape "AB · text" rejection above, at compound shape too: "AB-CD" has
  // letters and a dash but no digit anywhere, so it is not a valid id under either shape.
  const body = '- [ ] AB-CD · Ordinary text with a compound-looking but digit-free prefix';
  assert.deepEqual(parseTasks(body), [
    {
      id: null,
      text: 'AB-CD · Ordinary text with a compound-looking but digit-free prefix',
      done: false,
      owner: null,
      location: null,
    },
  ]);
});

test('parseTasks: an id tag alone with the checkbox mark and done state all still work together', () => {
  const body = [
    '- [ ] T1 · First task',
    '- [x] T2 · Second task — Claude',
  ].join('\n');
  assert.deepEqual(parseTasks(body), [
    { id: 'T1', text: 'First task', done: false, owner: null, location: null },
    { id: 'T2', text: 'Second task', done: true, owner: 'Claude', location: null },
  ]);
});

// --- an optional cloud/local marker inside the owner tag itself: "— name (cloud)" / "(local)" ---

test('parseTasks: a trailing "(cloud)" inside the owner tag is read as location, stripped from the owner name', () => {
  const body = '- [ ] Ship the release — coordinator (cloud)';
  assert.deepEqual(parseTasks(body), [
    { id: null, text: 'Ship the release', done: false, owner: 'coordinator', location: 'cloud' },
  ]);
});

test('parseTasks: a trailing "(local)" inside the owner tag is read as location, stripped from the owner name', () => {
  const body = '- [ ] Ship the release — foundation (local)';
  assert.deepEqual(parseTasks(body), [
    { id: null, text: 'Ship the release', done: false, owner: 'foundation', location: 'local' },
  ]);
});

test('parseTasks: the location marker is case-insensitive', () => {
  const body = '- [ ] Ship the release — foundation (LOCAL)';
  assert.deepEqual(parseTasks(body), [
    { id: null, text: 'Ship the release', done: false, owner: 'foundation', location: 'local' },
  ]);
});

test('parseTasks: an owner tag with no location marker leaves location null, not guessed', () => {
  const body = '- [ ] Ship the release — Ada';
  assert.deepEqual(parseTasks(body), [
    { id: null, text: 'Ship the release', done: false, owner: 'Ada', location: null },
  ]);
});

test('parseTasks: no owner tag at all means no location either — the marker lives inside the owner tag, not on its own', () => {
  const body = '- [ ] Ship the release (cloud)';
  assert.deepEqual(parseTasks(body), [
    { id: null, text: 'Ship the release (cloud)', done: false, owner: null, location: null },
  ]);
});

test('parseTasks: a word that merely contains "cloud" is not mistaken for the marker without parentheses', () => {
  const body = '- [ ] Migrate to the cloud provider — Ada';
  assert.deepEqual(parseTasks(body), [
    { id: null, text: 'Migrate to the cloud provider', done: false, owner: 'Ada', location: null },
  ]);
});

// --- real issues found live in a real consuming project's milestone issue ---------------------

test('parseTasks: a bold-wrapped id (GitHub-flavoured "**T1** ·") is unwrapped and read', () => {
  const body = '- [ ] **T1** · Settle Q210–Q212 with the owner. No code first.';
  assert.deepEqual(parseTasks(body), [
    {
      id: 'T1',
      text: 'Settle Q210–Q212 with the owner. No code first.',
      done: false,
      owner: null,
      location: null,
    },
  ]);
});

test('parseTasks: bold elsewhere on the line (not wrapping the id) is left alone — a separate, cosmetic concern', () => {
  const body = '- [ ] **Delete forever** as the seventh item.';
  assert.deepEqual(parseTasks(body), [
    { id: null, text: '**Delete forever** as the seventh item.', done: false, owner: null, location: null },
  ]);
});

test('parseTasks: an ordinary sentence dash is not misread as an owner tag — the real bug in #868', () => {
  // "Migration 076 — ordered delete, one transaction, names what it discards." used to parse as
  // text "Migration 076" with the entire rest of the sentence as owner "ordered delete, one
  // transaction, names what it discards." — a comma-bearing, period-ending run no real owner tag
  // has ever looked like. The whole line now stays intact as the task's own text.
  const body = '- [ ] Migration 076 — ordered delete, one transaction, names what it discards.';
  assert.deepEqual(parseTasks(body), [
    {
      id: null,
      text: 'Migration 076 — ordered delete, one transaction, names what it discards.',
      done: false,
      owner: null,
      location: null,
    },
  ]);
});

test('parseTasks: a semicolon-bearing clause after a dash is not misread as an owner tag', () => {
  const body = '- [ ] `DeleteMenuAsync` — refuses on any `MenuScreenAssignments` row; refuses on stale revision; idempotent.';
  assert.deepEqual(parseTasks(body), [
    {
      id: null,
      text: '`DeleteMenuAsync` — refuses on any `MenuScreenAssignments` row; refuses on stale revision; idempotent.',
      done: false,
      owner: null,
      location: null,
    },
  ]);
});

test('parseTasks: a real owner tag still parses correctly right beside prose that has its own dash earlier in the line', () => {
  // The shape check applies to the CAPTURED (last) segment only — an earlier, legitimate prose
  // dash elsewhere in the line does not prevent a real trailing owner tag from being read.
  const body = '- [ ] Migration 076 — ordered delete, one transaction — Ada';
  assert.deepEqual(parseTasks(body), [
    { id: null, text: 'Migration 076 — ordered delete, one transaction', done: false, owner: 'Ada', location: null },
  ]);
});

test('parseTasks: a real owner tag with a location marker still parses correctly', () => {
  const body = '- [ ] Ship the release — foundation (local)';
  assert.deepEqual(parseTasks(body), [
    { id: null, text: 'Ship the release', done: false, owner: 'foundation', location: 'local' },
  ]);
});

test('parseTasks: an id tag, an owner tag, and a location marker all parse together on one line', () => {
  const body = '- [x] CG-M1-01 · Working install and build commands recorded. — coordinator (cloud)';
  assert.deepEqual(parseTasks(body), [
    {
      id: 'CG-M1-01',
      text: 'Working install and build commands recorded.',
      done: true,
      owner: 'coordinator',
      location: 'cloud',
    },
  ]);
});
