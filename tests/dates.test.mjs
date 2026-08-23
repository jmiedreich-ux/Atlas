import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { daysBetween, formatDay, formatDayRange, formatDuration, isCalendarDate } from '../src/dates.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Every date below is invented for this test file. The generator holds no project content of its
// own (decision 40), and dates are content.
//
// The property the whole module exists to hold: NOTHING here reads the clock. #780 settled that
// a closed milestone carries both of its dates as stored facts, and that current and next carry a
// start date only, precisely so that no figure on the page is derived from today — which is what
// keeps two builds of one input byte-identical.

test('dates: a calendar date is four-two-two digits and a day that really exists', () => {
  assert.equal(isCalendarDate('2026-08-09'), true);
  assert.equal(isCalendarDate('2024-02-29'), true, '2024 is a leap year');

  assert.equal(isCalendarDate('2026-02-30'), false, 'February has no thirtieth');
  assert.equal(isCalendarDate('2025-02-29'), false, '2025 is not a leap year');
  assert.equal(isCalendarDate('2026-13-01'), false, 'there is no thirteenth month');
  assert.equal(isCalendarDate('2026-8-9'), false, 'unpadded is a different string and sorts wrong');
  assert.equal(isCalendarDate('2026-08-09T00:00:00Z'), false, 'a timestamp is not a calendar day');
  assert.equal(isCalendarDate(''), false);
  assert.equal(isCalendarDate(null), false);
  assert.equal(isCalendarDate(20260809), false);
});

test('dates: a day is formatted from its own digits, never through the local clock', () => {
  assert.equal(formatDay('2026-08-09'), '9 Aug 2026');
  assert.equal(formatDay('2026-01-01'), '1 Jan 2026');
  assert.equal(formatDay('2026-12-31'), '31 Dec 2026');

  // The failure this rules out: `new Date('2026-08-09')` parses as UTC midnight and then prints
  // as the 8th in any timezone west of Greenwich, so the site would say different things on two
  // machines building the same input. The month table is walked by index instead.
  assert.equal(formatDay('2026-08-01'), '1 Aug 2026', 'the first of a month must not slip backwards');
});

test('dates: the year is carried, because a project outlives one of them', () => {
  assert.notEqual(formatDay('2026-08-09'), formatDay('2027-08-09'));
});

test('dates: a span states its year once when both ends share it, and twice when they do not', () => {
  // The pair a closed milestone prints is the widest thing on the feature planning chart, and at
  // M2.1's geometry the widest of them reached out of its own column and under the neighbouring
  // feature's balloon. Stating the year once when both ends share it is what buys the room back —
  // and it costs nothing, because the PAIR still carries a year, which is what the note on
  // `formatDay` is actually about: "9 Aug" beside "9 Aug" is unactionable; "9 → 14 Aug 2026" is not.
  assert.equal(formatDayRange('2026-06-11', '2026-06-30'), '11 Jun → 30 Jun 2026');
  assert.equal(formatDayRange('2026-03-02', '2026-04-05'), '2 Mar → 5 Apr 2026');

  // Across a year boundary both are stated in full, because now the first one genuinely needs it.
  assert.equal(formatDayRange('2026-12-30', '2027-01-04'), '30 Dec 2026 → 4 Jan 2027');

  // A year is never absent from the whole span, whichever branch produced it.
  for (const [from, to] of [
    ['2026-06-11', '2026-06-30'],
    ['2026-12-30', '2027-01-04'],
  ]) {
    assert.match(formatDayRange(from, to), /\b\d{4}\b/, `${from}..${to} printed a span with no year in it`);
  }

  // Same shape as `formatDay` for a value that is not a stored day: empty, never "undefined".
  assert.equal(formatDayRange('not a day', '2026-06-30'), '');
  assert.equal(formatDayRange('2026-06-11', 'not a day'), '');
});

test('dates: how long a milestone took is arithmetic on the two stored days', () => {
  assert.equal(daysBetween('2026-08-09', '2026-08-09'), 0);
  assert.equal(daysBetween('2026-08-09', '2026-08-10'), 1);
  assert.equal(daysBetween('2026-08-09', '2026-08-22'), 13);

  // Across a month boundary, a year boundary and a leap day — the three places naive arithmetic
  // on the digits goes wrong.
  assert.equal(daysBetween('2026-01-31', '2026-02-01'), 1);
  assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1);
  assert.equal(daysBetween('2024-02-28', '2024-03-01'), 2, '2024 has a 29 February');
  assert.equal(daysBetween('2025-02-28', '2025-03-01'), 1, '2025 does not');
});

test('dates: a duration reads as English, and a same-day one does not read as zero', () => {
  assert.equal(formatDuration(0), 'same day');
  assert.equal(formatDuration(1), '1 day');
  assert.equal(formatDuration(2), '2 days');
  assert.equal(formatDuration(13), '13 days');
});

test('dates: nothing between a manifest and a page ever reads the clock', () => {
  // The property the byte-identical guarantee rests on, asserted where it can actually be broken.
  // Comparing two builds run seconds apart cannot catch a value derived from today — both runs
  // agree — and comparing against this year's digits is a guard that skips itself whenever the
  // records happen to be current. So: the source is read, and the two ways to ask what time it is
  // are not in it.
  //
  // `new Date(someNumber)` is fine and is used: it is arithmetic on a stored day. `new Date()`
  // with no argument, and `Date.now()`, are the clock.
  // EVERY module under src/, walked as a directory rather than named in a list. A hardcoded list
  // is the same "guard that cannot fail" this test was written to replace, one level up: a review
  // put `Date.now()` in `src/config.mjs` — which the list did not name — and the suite stayed
  // green.
  const srcDir = path.resolve(__dirname, '..', 'src');
  const sources = readdirSync(srcDir).filter((name) => name.endsWith('.mjs'));
  assert.ok(sources.length >= 8, `expected to scan the whole generator, saw ${sources.length} modules`);
  for (const name of sources) {
    const text = readFileSync(path.join(srcDir, name), 'utf8');
    assert.ok(!/\bDate\.now\s*\(/.test(text), `src/${name} reads the clock with Date.now()`);
    assert.ok(!/\bnew Date\s*\(\s*\)/.test(text), `src/${name} reads the clock with new Date()`);
    assert.ok(!/toISOString|toLocaleDateString|Intl\.DateTimeFormat/.test(text),
      `src/${name} formats a date through the host's own locale or timezone`);
  }

  for (const name of readdirSync(path.resolve(__dirname, '..', 'theme', '_includes'))) {
    const text = readFileSync(path.resolve(__dirname, '..', 'theme', '_includes', name), 'utf8');
    assert.ok(!/\bDate\b/.test(text), `theme/_includes/${name} reaches for a date of its own`);
  }
});
