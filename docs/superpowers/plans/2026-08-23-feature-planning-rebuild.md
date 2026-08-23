# Feature Planning Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the #780 SVG ribbon chart and rebuild Feature Planning (desktop) as an accordion
of features that expands to a milestone spine, and "What needs you" (mobile) as triage grouped by
blocking state — with milestone task lists finally parsed from the GitHub issues that already
carry them.

**Architecture:** Two new pure modules (`src/tasks.mjs` parses a checklist from an issue body;
`src/github.mjs` grows a second fetch, `fetchIssueBodies`, for issues regardless of open/closed
state) feed a third pure addition (`src/depth.mjs` grows `spineDetail`, deciding how much of each
milestone's task list to show). `src/build.mjs` wires all three into `assembleSite` so every page
renders from one assembled model, same as today. `src/chart.mjs` and its coordinate geometry are
deleted outright. Two Nunjucks templates are rewritten (`depth.njk`, `mobile.njk`); `order.js`'s
already-pure reorder/hide logic is kept and its DOM-repainting half is rewritten twice — once for
feature rows, once for task rows — against real HTML instead of SVG transforms.

**Tech Stack:** Node.js (`node --test`), Nunjucks templates via `@11ty/eleventy`, no runtime
dependency beyond decision 9's fixed two (Eleventy + its Nunjucks). No drag library — Pointer
Events, as `order.js` already does and explains why (unifies mouse/touch/pen in one code path;
native HTML5 drag-and-drop has poor touch support and would be a second interaction model).

**Spec:** `docs/superpowers/specs/2026-08-23-feature-planning-rebuild-design.md`

## Global Constraints

* Decision 1 — built from source, never maintained. No new hand-authored data; the only new
  source is a milestone's own GitHub issue body, already linked via `milestone.issue`.
* Decision 9 — exactly two runtime dependencies (`@11ty/eleventy` and its own Nunjucks). No new
  package for parsing, drag, or anything else in this plan.
* Decision 32 — fail loudly on a broken reference, except `src/github.mjs`, which is the
  generator's one stated tolerated-failure module. `fetchIssueBodies` follows the same tolerance
  `fetchProjectIssues` already has: a per-issue failure logs a warning prefixed `atlas: ` and
  degrades to `null` for that issue only, never throws, never fails the build.
* Decision 40 — no layout names a person, and the generator holds no project content. `owner`
  values are agent identities in practice (`Claude`, `ChatGPT`) and the parser never validates
  identity, so this is out of scope for every task below — noted once here rather than repeated.
* `owner` is the one closed-vocabulary exception in this plan: validated only as "non-empty string
  or null," never checked against an enum. This is deliberate (spec: "for now it's Claude or
  ChatGPT, whatever we name them later").
* No page in this rebuild renders `started`/`completed` dates or duration. The schema fields stay;
  no task in this plan removes them.
* Every new/changed test lives in this repo's existing `node --test` / `node:assert/strict` style
  (see `tests/github.test.mjs`, `tests/order.test.mjs`, `tests/theme.test.mjs` — no Jest, no
  Mocha, no `describe` blocks, flat `test(name, async () => {...})`).
* `tests/theme.test.mjs`'s Nunjucks-direct rendering harness (`env.render('depth.njk', {...})`,
  the `assemble()`/`entry()`/`milestone()`/`validated()` helpers) is the pattern every template
  test in this plan follows — not a full Eleventy build, not a browser.

---

## File structure

**Created:**
* `src/tasks.mjs` — `parseTasks(issueBody)`, the checklist parser. Single responsibility: text in,
  task objects out.
* `tests/tasks.test.mjs`

**Modified:**
* `src/github.mjs` — add `fetchIssueBodies`.
* `src/depth.mjs` — add `spineDetail`.
* `src/build.mjs` — wire `fetchIssueBodies` + `parseTasks` + `spineDetail` into `assembleSite`;
  remove `computeChart`/`chart.mjs` import and the depth page's `chart`/`features` data, replace
  with `workstreams: site.workstreams`.
* `src/triage.mjs` — remove `triageCards` (dead once the per-feature modal is gone).
* `theme/_includes/depth.njk` — full rewrite: accordion (2a) + nested spine (2b).
* `theme/_includes/mobile.njk` — full rewrite: triage grouped by state (1c).
* `theme/order.js` — remove the modal-opening block (`openModal`, `openedFrom`, the
  `data-feature-modal` dialog wiring); adapt `wire()`'s DOM-repaint half from SVG `transform` to
  real row reordering; add a second, parallel wiring function for task-row reordering inside an
  expanded milestone (new export, same pure helpers reused).
* `theme/tokens.css` — new rules for `.feature-list`, `.feature-row`, `.feature-spine`,
  `.milestone-node`, `.task-list`, `.triage-section` (desktop + mobile), replacing every
  chart-specific rule (`.ribbon-*`, `.lane-*`, `.balloon-*`, `.dot`, `.chart-scroll` etc. — audit
  and remove alongside their markup).
* `tests/github.test.mjs` — add `fetchIssueBodies` coverage.
* `tests/theme.test.mjs` — rebuild `renderDepth`/`renderMobile`/`assemble` for the new data shape;
  replace every chart-specific assertion with accordion/spine/triage assertions.
* `tests/order.test.mjs` — add coverage for the task-row reorder wiring's pure helpers (reuses
  existing exports; only new call sites need new tests, not new logic).
* `tests/triage.test.mjs` — remove `triageCards` coverage.
* `tests/depth.test.mjs` — add `spineDetail` coverage.

**Deleted:**
* `src/chart.mjs`
* `tests/chart.test.mjs`

---

### Task 1: `src/tasks.mjs` — the checklist parser

**Files:**
- Create: `src/tasks.mjs`
- Test: `tests/tasks.test.mjs`

**Interfaces:**
- Produces: `parseTasks(issueBody: string | null | undefined) => { text: string, done: boolean, owner: string | null }[]`. Every later task that touches milestone tasks (Task 3, Task 6, template tests) imports this exact signature.

- [ ] **Step 1: Write the failing tests**

```javascript
// tests/tasks.test.mjs
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/tasks.test.mjs`
Expected: FAIL — `Cannot find module '../src/tasks.mjs'`

- [ ] **Step 3: Write the implementation**

```javascript
// src/tasks.mjs
// Parses the GitHub task-list checklist already inside a milestone's linked issue body into the
// flat, sequential task list the feature-planning spine renders (design doc: "Task lists: source
// and parsing"). This is the only new data source the rebuild introduces — the checklist already
// exists; Atlas previously rendered it as literal `- [x]` text instead of parsing it.
//
// Deliberately no hierarchy: an indented sub-item reads as an ordinary top-level line, because the
// owner has said sub-tasks, if they ever appear, "would all just get listed sequentially."

// A line may end with an owner tag: an em-dash or a plain hyphen, preceded by whitespace, followed
// by a name. Whitespace before the dash is what keeps this from misfiring on a hyphenated word
// inside the task text itself ("Write-back" has no space before its hyphen, so it never matches).
const OWNER_TAG = /\s+[—-]\s*(\S.*)$/;

// GitHub task-list syntax: "- [ ] text" or "- [x] text", any leading indentation, case-insensitive
// mark. Anything else on a line — prose, a heading, an ordinary bullet with no checkbox — is not a
// task and is ignored.
const TASK_LINE = /^-\s*\[([ xX])\]\s+(.+)$/;

/**
 * @param {string | null | undefined} issueBody
 * @returns {{ text: string, done: boolean, owner: string | null }[]}
 */
export function parseTasks(issueBody) {
  if (typeof issueBody !== 'string') return [];

  const tasks = [];
  for (const rawLine of issueBody.split('\n')) {
    const match = TASK_LINE.exec(rawLine.trim());
    if (!match) continue;

    const done = match[1].toLowerCase() === 'x';
    let text = match[2].trim();
    let owner = null;

    const ownerMatch = OWNER_TAG.exec(text);
    if (ownerMatch) {
      owner = ownerMatch[1].trim();
      text = text.slice(0, ownerMatch.index).trim();
    }
    if (text.length === 0) continue;

    tasks.push({ text, done, owner });
  }
  return tasks;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/tasks.test.mjs`
Expected: PASS, all 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tasks.mjs tests/tasks.test.mjs
git commit -m "feat: parse a milestone's task checklist from its issue body"
```

---

### Task 2: `src/github.mjs` — `fetchIssueBodies`

**Files:**
- Modify: `src/github.mjs`
- Test: `tests/github.test.mjs`

**Interfaces:**
- Consumes: nothing new from earlier tasks.
- Produces: `fetchIssueBodies({ repo: string, issueNumbers: number[], token?: string, fetchImpl?: typeof fetch }) => Promise<Map<number, string | null>>`. Task 3 calls this exactly.

- [ ] **Step 1: Write the failing tests**

Append to `tests/github.test.mjs` (same file, same fixtures already imported at the top —
`fetchImplReturning`, `withSilencedWarn`, `REPO` are already defined above; add `fetchIssueBodies`
to the existing import line):

```javascript
// Change the existing import line at the top of the file from:
//   import { fetchProjectIssues } from '../src/github.mjs';
// to:
import { fetchIssueBodies, fetchProjectIssues } from '../src/github.mjs';

// --- fetchIssueBodies ------------------------------------------------------

function fetchImplForIssues(bodiesByNumber) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const match = /\/issues\/(\d+)$/.exec(String(url));
    const number = match ? Number(match[1]) : null;
    if (number === null || !(number in bodiesByNumber)) {
      return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    }
    return { ok: true, status: 200, json: async () => ({ number, body: bodiesByNumber[number] }) };
  };
  impl.calls = calls;
  return impl;
}

test('fetchIssueBodies: fetches one issue per distinct number and maps number to body', async () => {
  const fetchImpl = fetchImplForIssues({ 101: 'body one', 102: 'body two' });
  const result = await fetchIssueBodies({ repo: REPO, issueNumbers: [101, 102], fetchImpl });

  assert.equal(result.get(101), 'body one');
  assert.equal(result.get(102), 'body two');
});

test('fetchIssueBodies: duplicate issue numbers are fetched once', async () => {
  const fetchImpl = fetchImplForIssues({ 101: 'body one' });
  await fetchIssueBodies({ repo: REPO, issueNumbers: [101, 101, 101], fetchImpl });

  assert.equal(fetchImpl.calls.length, 1);
});

test('fetchIssueBodies: requests the single-issue endpoint, not the list endpoint', async () => {
  const fetchImpl = fetchImplForIssues({ 101: 'body one' });
  await fetchIssueBodies({ repo: REPO, issueNumbers: [101], fetchImpl });

  assert.match(fetchImpl.calls[0], /\/repos\/atlas-fixtures\/lighthouse\/issues\/101$/);
});

test('fetchIssueBodies: an empty issueNumbers list makes no request and resolves to an empty map', async () => {
  const fetchImpl = fetchImplForIssues({});
  const result = await fetchIssueBodies({ repo: REPO, issueNumbers: [], fetchImpl });

  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(result.size, 0);
});

test('fetchIssueBodies: sends an Authorization header when a token is given, omits it otherwise', async () => {
  const calls = [];
  const withToken = async (url, options) => {
    calls.push(options);
    return { ok: true, status: 200, json: async () => ({ number: 101, body: 'x' }) };
  };
  await fetchIssueBodies({ repo: REPO, issueNumbers: [101], token: 'secret-token', fetchImpl: withToken });
  assert.ok(
    Object.entries(calls[0].headers).some(
      ([k, v]) => k.toLowerCase() === 'authorization' && String(v).includes('secret-token'),
    ),
  );
});

test('fetchIssueBodies: a non-OK response for one issue yields null for that issue only, and warns', async () => {
  await withSilencedWarn(async (warnCalls) => {
    const fetchImpl = fetchImplForIssues({ 101: 'body one' }); // 102 will 404
    const result = await fetchIssueBodies({ repo: REPO, issueNumbers: [101, 102], fetchImpl });

    assert.equal(result.get(101), 'body one');
    assert.equal(result.get(102), null);
    assert.ok(warnCalls.length >= 1, 'expected a warning for the failed issue');
    const message = warnCalls[warnCalls.length - 1].join(' ');
    assert.match(message, /^atlas: /);
    assert.ok(message.includes('102'), `warning should name the failed issue number: ${message}`);
  });
});

test('fetchIssueBodies: a network failure for one issue yields null for that issue only, and warns', async () => {
  await withSilencedWarn(async (warnCalls) => {
    const fetchImpl = async (url) => {
      if (String(url).endsWith('/101')) return { ok: true, status: 200, json: async () => ({ number: 101, body: 'ok' }) };
      throw new Error('network unreachable');
    };
    const result = await fetchIssueBodies({ repo: REPO, issueNumbers: [101, 999], fetchImpl });

    assert.equal(result.get(101), 'ok');
    assert.equal(result.get(999), null);
    assert.ok(warnCalls.some((call) => call.join(' ').includes('999')));
  });
});

test('fetchIssueBodies: an issue whose body is not a string maps to null', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ number: 101, body: null }) });
  const result = await fetchIssueBodies({ repo: REPO, issueNumbers: [101], fetchImpl });
  assert.equal(result.get(101), null);
});

test('fetchIssueBodies: never rejects, whatever the fetch does', async () => {
  await withSilencedWarn(async () => {
    const fetchImpl = async () => {
      throw new Error('boom');
    };
    await assert.doesNotReject(fetchIssueBodies({ repo: REPO, issueNumbers: [1, 2, 3], fetchImpl }));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/github.test.mjs`
Expected: FAIL — `fetchIssueBodies is not a function` / import error.

- [ ] **Step 3: Write the implementation**

Add to `src/github.mjs`, after `fetchProjectIssues` (keep every existing export and function
exactly as-is — this is additive):

```javascript
function warnIssueFetch(repo, number, detail) {
  console.warn(`atlas: could not fetch issue #${number} for ${repo}: ${detail} — its tasks will be empty`);
}

/**
 * Fetch the body of every distinct issue number given, regardless of open/closed state — unlike
 * `fetchProjectIssues`, which only ever sees OPEN issues. A milestone marked `done` almost always
 * has a *closed* issue, and its checklist has to come from somewhere.
 *
 * One request per distinct issue number, run concurrently. Bounded by how many milestones this
 * project has (a few dozen at most), not by the open backlog — this is a different shape of
 * request from `fetchProjectIssues`'s single list call on purpose.
 *
 * Decision 32's stated tolerated-failure module extends to this call the same way it already
 * covers the list fetch: a network error or non-OK response for one issue logs a warning and maps
 * that issue to `null`, never rejects, never fails the build.
 *
 * @param {object} opts
 * @param {string} opts.repo - `owner/name`.
 * @param {number[]} opts.issueNumbers - may contain duplicates; each distinct number is fetched once.
 * @param {string} [opts.token]
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<Map<number, string | null>>} every distinct number given, mapped to its
 *   issue's `body`, or `null` on any failure for that issue.
 */
export async function fetchIssueBodies({ repo, issueNumbers, token, fetchImpl = fetch }) {
  const unique = [...new Set(issueNumbers)];
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const entries = await Promise.all(
    unique.map(async (number) => {
      const url = `${GITHUB_API_ROOT}/repos/${repo}/issues/${number}`;
      try {
        const response = await fetchImpl(url, { headers });
        if (!response.ok) {
          warnIssueFetch(repo, number, `GitHub responded ${response.status}`);
          return [number, null];
        }
        const item = await response.json();
        return [number, typeof item.body === 'string' ? item.body : null];
      } catch (err) {
        warnIssueFetch(repo, number, err.message);
        return [number, null];
      }
    }),
  );

  return new Map(entries);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/github.test.mjs`
Expected: PASS, all tests including the new `fetchIssueBodies` block.

- [ ] **Step 5: Commit**

```bash
git add src/github.mjs tests/github.test.mjs
git commit -m "feat: fetch a milestone's issue body regardless of open/closed state"
```

---

### Task 3: `src/depth.mjs` — `spineDetail`

**Files:**
- Modify: `src/depth.mjs`
- Test: `tests/depth.test.mjs`

**Interfaces:**
- Consumes: nothing new from earlier tasks (operates on `milestone.status`, already in the schema).
- Produces: `spineDetail(milestones: object[]) => ('full'|'full-muted'|'count'|'none')[]`, same
  length and order as the input. Task 4 (build.mjs wiring) and Task 6 (spine template) both
  consume this exact return shape.

This decides how much of a milestone's task list the spine shows — computed here, in the same
module that already decides ladder position and "the tip," rather than in the template. The
existing architecture's own reasoning applies unchanged: "a layout that computes a position is a
layout no test without a browser can check" (`src/chart.mjs`'s header comment, before its
retirement in Task 5) — this is that same principle applied to a different computed fact.

- [ ] **Step 1: Write the failing tests**

```javascript
// Append to tests/depth.test.mjs. Add `spineDetail` to the existing import from '../src/depth.mjs'.

import { computeLadder, spineDetail } from '../src/depth.mjs'; // merge with existing import line

test('spineDetail: the current (next) milestone is full, everything before it is none if done', () => {
  const milestones = [
    { status: 'done' },
    { status: 'done' },
    { status: 'next' },
  ];
  assert.deepEqual(spineDetail(milestones), ['none', 'none', 'full']);
});

test('spineDetail: the milestone immediately after current, if unplanned, is full-muted', () => {
  const milestones = [
    { status: 'done' },
    { status: 'next' },
    { status: 'unplanned' },
  ];
  assert.deepEqual(spineDetail(milestones), ['none', 'full', 'full-muted']);
});

test('spineDetail: anything further out than the muted one is count', () => {
  const milestones = [
    { status: 'next' },
    { status: 'unplanned' },
    { status: 'unplanned' },
  ];
  assert.deepEqual(spineDetail(milestones), ['full', 'full-muted', 'count']);
});

test('spineDetail: a parked milestone is none, even if it would otherwise be the muted preview', () => {
  const milestones = [
    { status: 'next' },
    { status: 'parked' },
  ];
  assert.deepEqual(spineDetail(milestones), ['full', 'none']);
});

test('spineDetail: a blocked milestone right after current is count, not full-muted (only unplanned earns the preview)', () => {
  const milestones = [
    { status: 'next' },
    { status: 'blocked' },
    { status: 'unplanned' },
  ];
  assert.deepEqual(spineDetail(milestones), ['full', 'count', 'full-muted']);
});

test('spineDetail: no current milestone at all — every milestone is done, parked or count', () => {
  const milestones = [
    { status: 'done' },
    { status: 'done' },
  ];
  assert.deepEqual(spineDetail(milestones), ['none', 'none']);
});

test('spineDetail: no current milestone and nothing done either — everything not done/parked is count', () => {
  const milestones = [{ status: 'unplanned' }, { status: 'blocked' }];
  assert.deepEqual(spineDetail(milestones), ['count', 'count']);
});

test('spineDetail: an empty milestone list returns an empty array', () => {
  assert.deepEqual(spineDetail([]), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/depth.test.mjs`
Expected: FAIL — `spineDetail is not a function`.

- [ ] **Step 3: Write the implementation**

Add to `src/depth.mjs`, after `computeLadder` (additive — every existing export stays):

```javascript
/**
 * How much of each milestone's task list the spine (surface 1, expanded — design doc "Surface 1,
 * expanded: the milestone spine") shows.
 *
 *   'none'       — done or parked: a closed milestone's task history is not re-litigated here.
 *   'full'       — the current milestone (status 'next'; at most one per feature).
 *   'full-muted' — the first 'unplanned' milestone AFTER the current one, if any: the "what's
 *                  coming" preview, shown but visually dimmed.
 *   'count'      — anything else with tasks on record: collapses to a task count, not a list.
 *
 * @param {{ status: string }[]} milestones - a manifest's milestones, in depth order.
 * @returns {('full'|'full-muted'|'count'|'none')[]} one entry per milestone, same order.
 */
export function spineDetail(milestones) {
  const currentIndex = milestones.findIndex((m) => m.status === 'next');
  const previewIndex =
    currentIndex === -1
      ? -1
      : milestones.findIndex((m, i) => i > currentIndex && m.status === 'unplanned');

  return milestones.map((m, index) => {
    if (m.status === 'done' || m.status === 'parked') return 'none';
    if (index === currentIndex) return 'full';
    if (index === previewIndex) return 'full-muted';
    return 'count';
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/depth.test.mjs`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add src/depth.mjs tests/depth.test.mjs
git commit -m "feat: decide how much of a milestone's task list the spine shows"
```

---

### Task 4: Wire tasks + spine detail into `assembleSite`; retire `chart.mjs` and `triageCards`

**Files:**
- Modify: `src/build.mjs`
- Modify: `src/triage.mjs` (remove `triageCards`)
- Modify: `tests/triage.test.mjs` (remove `triageCards` coverage)
- Delete: `src/chart.mjs`
- Delete: `tests/chart.test.mjs`

**Interfaces:**
- Consumes: `parseTasks` (Task 1), `fetchIssueBodies` (Task 2), `spineDetail` (Task 3).
- Produces: every `stream.milestones[].manifest` object gains `tasks: {text,done,owner}[]` and
  every `stream.milestones[]` entry gains `spineDetail: 'full'|'full-muted'|'count'|'none'`
  (paired 1:1 with `stream.manifest.milestones` by index — Task 6's template reads both). The
  depth page's Eleventy data drops `chart`/`features`, gains `workstreams: site.workstreams`
  (Task 5 and Task 6 both consume this key directly).

This is the biggest single-task diff in the plan because it touches the wiring in three places at
once (import list, `assembleSite`, `planPages`) plus two full-file deletions — but each change is
mechanical, not exploratory, which is why it stays one task rather than three: a reviewer either
accepts the whole wiring or none of it, there's no meaningful midpoint.

- [ ] **Step 1: Write the failing test**

`tests/build.test.mjs` already builds the fixture end-to-end (`--offline`) and reads `state.json`
and rendered pages; the existing pattern there is the one to extend. Add:

```javascript
// Append to tests/build.test.mjs, in the same file/style as its existing "run the real build and
// read what it wrote" tests (look at an existing test in that file for the exact build-invocation
// helper already in use — reuse it rather than re-deriving one).

test('build: a milestone with a real issue number still builds offline with an empty task list', async () => {
  // --offline never calls fetchIssueBodies (same convention as the existing issues fetch), so a
  // milestone whose issue is set still builds — just with no tasks, not a build failure.
  const result = await runBuild(); // reuse whatever helper this file's existing tests call
  assert.ok(result.exitCode === 0 || result.exitCode === undefined, 'offline build must still succeed');
});
```

(If `tests/build.test.mjs` has no existing "run the fixture build and assert exit code" helper,
write the smallest one that shells out to `node src/build.mjs fixture <tmp-out> --offline --quiet`
and asserts a zero exit code — match whatever subprocess-invocation style the rest of that file
already uses rather than introducing a new one.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/build.test.mjs`
Expected: FAIL only if the wiring below is wrong — since offline mode's contract (no network call)
is unchanged, this test mostly guards against a typo breaking the build entirely. If it passes
immediately, that's fine; proceed to Step 3's implementation and re-run in Step 4 to be sure.

- [ ] **Step 3: Wire it up**

In `src/build.mjs`, change the import block (around line 40-49):

```javascript
// Before:
import { computeChart } from './chart.mjs';
import { computeLadder, assertLadderResolves } from './depth.mjs';
import { emptyBuckets, fetchProjectIssues } from './github.mjs';
// ...
import { orderByTriage, triageCards } from './triage.mjs';

// After:
import { computeLadder, assertLadderResolves, spineDetail } from './depth.mjs';
import { emptyBuckets, fetchIssueBodies, fetchProjectIssues } from './github.mjs';
import { parseTasks } from './tasks.mjs';
// ...
import { orderByTriage } from './triage.mjs';
```

In `assembleSite` (around line 260-353), after the existing `issues` fetch and before `documents`:

```javascript
  // Every milestone's own linked issue, regardless of open/closed state — `fetchProjectIssues`
  // above only ever sees OPEN issues, so a `done` milestone's (almost always closed) issue would
  // never arrive through it. Collected across every workstream so this is one call, not one per
  // milestone rendered.
  const milestoneIssueNumbers = resolved.flatMap((stream) =>
    stream.manifest.milestones.map((m) => m.issue).filter((n) => n !== null),
  );
  const taskBodies = offline
    ? new Map()
    : await fetchIssueBodies({ repo: config.repo, issueNumbers: milestoneIssueNumbers, token, fetchImpl });
```

Then, inside the existing `milestones: stream.manifest.milestones.map((milestone) => { ... })`
block (around line 299-319), add two fields to the object that block already returns:

```javascript
      milestones: stream.manifest.milestones.map((milestone) => {
        const planPath = `${relDir}/${milestone.plan}`;
        const segment = milestone.id.toLowerCase();
        return {
          manifest: {
            ...milestone,
            // Computed only, never written back (design doc: "Data model summary" — this is not
            // a schema field, it is attached here the same way `url`/`planUrl` already are).
            tasks: milestone.issue !== null ? parseTasks(taskBodies.get(milestone.issue) ?? null) : [],
          },
          url: milestoneUrl(stream.slug, milestone.id),
          permalink: `/workstream/${stream.slug}/${segment}/index.html`,
          planPath,
          planSource: path.join(stream.dir, milestone.plan),
          planUrl: documentUrlByPath.get(planPath) ?? null,
          recordUrl: milestone.acceptance.record
            ? documentUrlByPath.get(milestone.acceptance.record) ?? null
            : null,
          hrefBase: relDir,
        };
      }),
```

(Note: `manifest` now holds a *copy* of `milestone` with `tasks` added, rather than the original
object reference — every existing reader of `stream.milestones[].manifest` keeps working
unchanged, since every original field is still there.)

Immediately after that `.map(...)` call closes (still inside the same `unclassified` entry, so
`stream.milestones` is available), attach the per-milestone spine detail as a same-shaped sibling
array:

```javascript
      spineDetail: spineDetail(stream.manifest.milestones),
```

So one `unclassified` entry now looks like:

```javascript
  const unclassified = resolved.map((stream, index) => {
    const relDir = relPath(config.projectRoot, stream.dir);
    return {
      ...stream,
      relDir,
      relManifestPath: relPath(config.projectRoot, stream.manifestPath),
      url: workstreamUrl(stream.slug),
      column: ladder.columns[index],
      issues: issues.byLabel.get(stream.manifest.label) ?? [],
      milestones: stream.manifest.milestones.map((milestone) => { /* as above */ }),
      spineDetail: spineDetail(stream.manifest.milestones),
    };
  });
```

Now in `planPages` (around line 400-423), replace the depth page's data:

```javascript
  pages.push({
    name: 'depth',
    extend: 'depth.njk',
    data: {
      ...shell,
      permalink: '/index.html',
      title: 'Feature planning',
      workstreams: site.workstreams,
    },
  });
```

(`site.workstreams` already carries `triage` per decision 27's classification, attached later in
`assembleSite` at the existing `const workstreams = unclassified.map(...)` line — unchanged by
this task.)

- [ ] **Step 4: Delete `src/chart.mjs` and `tests/chart.test.mjs`**

```bash
git rm src/chart.mjs tests/chart.test.mjs
```

- [ ] **Step 5: Remove `triageCards` from `src/triage.mjs`**

Delete the whole `triageCards` function and its docblock (design doc: the per-feature modal it
served is retired in Task 7; nothing else calls it after Step 3 above). Leave `classifyTriage`,
`TRIAGE_ORDER`, and `orderByTriage` exactly as they are.

In `tests/triage.test.mjs`, remove every test that imports or calls `triageCards` (search the file
for `triageCards` and delete those `test(...)` blocks; leave `classifyTriage`/`orderByTriage`
coverage untouched).

- [ ] **Step 6: Run the full suite to see what else references the deleted module**

Run: `node --test`
Expected: FAIL in `tests/theme.test.mjs` (it imports `computeChart`/`triageCards` and calls
`renderDepth` with the old shape) and possibly `tests/build.test.mjs` if it asserts anything
chart-specific. This is expected and exactly what Task 5/6 fix — do not fix `theme.test.mjs` in
this task; it is Task 5 and Task 6's job, working against the real new template. Confirm here only
that the *build* itself (not the template tests) succeeds:

Run: `node src/build.mjs fixture /tmp/atlas-task4-check --offline --quiet`
Expected: exits 0. (`depth.njk` will fail to render meaningfully until Task 5, but Eleventy will
either render an empty/broken page or the task's own new `tests/build.test.mjs` addition from
Step 1 catches a hard failure — a soft rendering gap is expected and fine at this point; a
non-zero exit is not.)

- [ ] **Step 7: Commit**

```bash
git add src/build.mjs src/triage.mjs tests/build.test.mjs tests/triage.test.mjs
git commit -m "feat: wire task parsing and spine detail into the build; retire chart.mjs and triageCards"
```

---

### Task 5: `theme/_includes/depth.njk` — the accordion (2a), collapsed state

**Files:**
- Modify: `theme/_includes/depth.njk` (full rewrite)
- Modify: `theme/tokens.css` (remove chart-specific rules, add accordion rules)
- Modify: `tests/theme.test.mjs` (rebuild `renderDepth`/`assemble`, replace chart assertions)

**Interfaces:**
- Consumes: `workstreams` data key from Task 4 (each entry: `slug`, `manifest.codename`,
  `manifest.stage`, `column.covered`/`completedCount`/`milestoneCount`/`tipLabel`, `manifest.gate`,
  `triage`, plus `milestones`/`spineDetail` which Task 6 consumes — this task only needs the
  collapsed-row fields).
- Produces: the DOM hooks Task 7 (drag/reorder) queries: `[data-feature-list]` (container),
  `[data-slug]` (each row), `[data-row-handle]` (the draggable/clickable header inside a row,
  carrying `data-name` for announcements), `[data-order-said]`, `[data-hidden-bar]`.

This task ships the collapsed accordion only — expand/collapse and the spine are Task 6. A
collapsed-only page is independently testable and reviewable: every row renders, nothing is
draggable yet (Task 7 wires that), nothing expands yet (Task 6 wires that).

- [ ] **Step 1: Update the test harness in `tests/theme.test.mjs`**

Replace the imports (remove `CHART`, `computeChart`, `triageCards`; nothing else changes):

```javascript
// Before:
import { CHART, computeChart } from '../src/chart.mjs';
import { TRIAGE_ORDER, orderByTriage, triageCards } from '../src/triage.mjs';

// After:
import { TRIAGE_ORDER, orderByTriage } from '../src/triage.mjs';
```

Replace `assemble()` and `renderDepth()` (the functions defined around lines 121-151):

```javascript
// The shape src/build.mjs hands the layouts, matching Task 4's wiring exactly: each workstream
// carrying its own ladder column and triage state, its milestones already enriched with `tasks`
// on the manifest and a sibling `spineDetail` array.
function assemble(entries) {
  const ladder = computeLadder(entries);
  const triaged = orderByTriage(entries.map((stream, index) => ({ ...stream, column: ladder.columns[index] })));
  const triageBySlug = new Map(triaged.map((s) => [s.slug, s.triage]));

  return entries.map((stream, index) => ({
    ...stream,
    url: workstreamUrl(stream.slug),
    column: ladder.columns[index],
    triage: triageBySlug.get(stream.slug),
    milestones: stream.manifest.milestones.map((entry) => ({
      manifest: { ...entry, tasks: entry.tasks ?? [] },
      url: milestoneUrl(stream.slug, entry.id),
      planUrl: null,
      recordUrl: null,
      hrefBase: `docs/features/${stream.slug}`,
    })),
    spineDetail: spineDetail(stream.manifest.milestones),
  }));
}

function renderDepth(entries) {
  return env.render('depth.njk', {
    ...site,
    title: 'Feature planning',
    workstreams: assemble(entries),
  });
}
```

Add `spineDetail` to the existing `import { computeLadder } from '../src/depth.mjs';` line.

Replace `renderMobile` too (needed later in Task 8, but touch it now since it also calls
`assemble`):

```javascript
function renderMobile(entries) {
  return env.render('mobile.njk', {
    ...site,
    title: 'What needs you',
    triaged: orderByTriage(assemble(entries)),
  });
}
```

Now delete every existing test in `tests/theme.test.mjs` whose name or body references the retired
chart: search for `chart`, `ribbon`, `balloon`, `.dot`, `ladder gutter`, `wrapText`, `CHART.` and
remove those `test(...)` blocks. Leave every test about `mobile.njk`, `workstream.njk`,
`milestone.njk`, `library.njk`, `document.njk`, and the `decision 40` / contrast / token tests
untouched — this task and Task 6/8 replace only what's chart-specific.

- [ ] **Step 2: Write the failing tests for the collapsed accordion**

Add to `tests/theme.test.mjs`:

```javascript
test('planning: one row per workstream, each carrying its own slug', () => {
  for (const stream of workstreams) {
    assert.match(depthHtml, new RegExp(`data-slug="${stream.slug}"`));
  }
});

test('planning: a row shows its codename, stage chip, and triage chip', () => {
  const stream = workstreams[0];
  const rowMatch = new RegExp(
    `data-slug="${stream.slug}"[\\s\\S]*?</li>`,
  ).exec(depthHtml);
  assert.ok(rowMatch, `no row found for ${stream.slug}`);
  const row = rowMatch[0];
  assert.ok(row.includes(stream.manifest.codename), 'row is missing its own codename');
  assert.match(row, new RegExp(`data-stage="${stream.manifest.stage}"`));
});

test('planning: a row carries a milestone progress strip sized to its own milestone count', () => {
  const withMilestones = workstreams.find((s) => s.manifest.milestones.length > 0);
  assert.ok(withMilestones, 'fixture has no workstream with milestones to test against');
  const rowMatch = new RegExp(`data-slug="${withMilestones.slug}"[\\s\\S]*?</li>`).exec(depthHtml);
  const segCount = (rowMatch[0].match(/class="strip-seg/g) || []).length;
  assert.equal(segCount, withMilestones.manifest.milestones.length);
});

test('planning: no dates or duration render anywhere on this page', () => {
  // The design doc's core rule for this rebuild. formatDay/formatDayRange output looks like real
  // dates (e.g. "23 Aug 2026"); a milestone month name is the cheapest reliable signal one leaked.
  const MONTHS = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/;
  assert.doesNotMatch(depthHtml, MONTHS, 'a date rendered on the feature-planning page');
});

test('planning: the per-feature triage modal is gone — no dialog, no data-feature-modal', () => {
  assert.doesNotMatch(depthHtml, /data-feature-modal/);
  assert.doesNotMatch(depthHtml, /<dialog/);
});

test('planning: the drag/hide DOM hooks are present for order.js to wire', () => {
  assert.match(depthHtml, /data-feature-list/);
  assert.match(depthHtml, /data-row-handle/);
  assert.match(depthHtml, /data-order-said/);
  assert.match(depthHtml, /data-hidden-bar/);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/theme.test.mjs`
Expected: FAIL — `depth.njk` still renders the old SVG chart against data it no longer receives.

- [ ] **Step 4: Rewrite `theme/_includes/depth.njk`**

```jinja
{#- Atlas — surface one: feature planning (the accordion, #780's successor).

  Not a drawing. Each feature is a collapsed row; opening one reveals its milestone spine
  (theme/_includes/depth.njk's own expand block, wired by theme/order.js). No dates, no duration —
  the design doc for this rebuild is explicit that the milestone is the axis here, not a calendar.

  Data this layout expects — `workstreams`, in the order the config declares, each:
    slug, manifest { codename, stage, gate, milestones: [{ id, label, depth, title, status, tasks }] }
    column   — computeLadder's own entry: covered[], completedCount, milestoneCount, tipLabel
    triage   — src/triage.mjs's classifyTriage result
    milestones — url/planUrl/recordUrl-enriched, `.manifest` mirrors `manifest.milestones[i]`
    spineDetail — one 'full'|'full-muted'|'count'|'none' per milestone, same order
-#}
{% extends "base.njk" %}
{% import "base.njk" as ui %}

{% block bodyClass %}page page-planning{% endblock %}

{% block content %}
<h1>Feature planning</h1>
<p class="lede">Expand a feature to see what it's doing right now.</p>

<div class="planning-controls">
<p class="controls-note">Your order and any hidden features are <strong>remembered on this device only</strong> — they do not follow you to another browser, or to your phone.</p>
<div class="hidden-bar" data-hidden-bar hidden></div>
<p class="order-said" data-order-said role="status" aria-live="polite"></p>
</div>

<ul class="feature-list" data-feature-list>
{%- for stream in workstreams %}
<li class="feature-row" data-slug="{{ stream.slug }}">
<div
  class="feature-row-head"
  data-row-handle
  tabindex="0"
  role="button"
  aria-expanded="false"
  aria-controls="spine-{{ stream.slug }}"
  data-name="{{ stream.manifest.codename }}"
  aria-describedby="row-note"
>
<span class="disclosure" aria-hidden="true">▸</span>
<span class="feature-name">{{ stream.manifest.codename }}</span>
{{ ui.chip('stage', stream.manifest.stage) }}
{%- if stream.column.milestoneCount %}
<span class="milestone-strip" role="img" aria-label="{{ stream.column.completedCount }} of {{ stream.column.milestoneCount }} milestones complete">
{%- for filled in stream.column.covered %}<span class="strip-seg{% if filled %} is-filled{% endif %}"></span>{% endfor -%}
</span>
{%- endif %}
{%- if stream.column.tipLabel or stream.manifest.gate %}
<span class="feature-next">{{ stream.column.tipLabel or stream.manifest.gate }}</span>
{%- endif %}
{{ ui.chip('triage', stream.triage) }}
</div>
<div class="feature-spine" id="spine-{{ stream.slug }}" data-feature-spine hidden>
{#- Task 6 fills this in. Left as an empty, correctly-hidden panel here so this task's own
    tests (and the drag wiring in Task 7, which only touches .feature-row-head) are true
    independent of what Task 6 adds. -#}
</div>
</li>
{%- endfor %}
</ul>

<p class="visually-hidden" id="row-note">Drag a feature's header to put the features in the order you want, or focus one and press the left and right arrow keys to move it. Press Enter or Space to open it. Press H to hide a feature; hidden features can be brought back from the controls above the list.</p>
{% endblock %}

{% block bodyScripts %}
<script type="module" src="/order.js"></script>
{% endblock %}
```

Note the `data-stage="..."` attribute the test in Step 2 checks: it comes from the existing
`chip()` macro in `base.njk`, which already emits `data-{{ kind }}="{{ value }}"` — calling
`ui.chip('stage', stream.manifest.stage)` produces `data-stage="shipping"` etc. with no template
change needed there.

- [ ] **Step 5: Remove the chart-specific CSS from `theme/tokens.css`**

Delete the whole "surface one: the feature planning drawing" section (everything from the
`/* --- surface one: the feature planning drawing --- */` comment through the last
`.ribbon-*`/`.balloon-*`/`.chip-box`/`.milestone-dot`/`.lane-*`/`.chart-scroll` rule — grep
`theme/tokens.css` for `.ribbon`, `.lane-`, `.balloon`, `.chart-scroll`, `.dot`, `.skip-` and
remove each rule found; leave `.chip`/`.chip-*` rules alone, they're shared with every other
surface via the `chip()` macro).

Add new rules for the collapsed accordion (extend, don't replace, the existing `--sky-*` token
set already defined at the top of the file):

```css
/* --- surface one: feature planning, the accordion ------------------------------------------- */

.feature-list {
  display: flex;
  flex-direction: column;
  gap: var(--sky-space-2);
  list-style: none;
  margin: var(--sky-space-5) 0 0;
  padding: 0;
}

.feature-row {
  border: 1px solid var(--sky-color-border);
  border-radius: var(--sky-radius-md);
  background: var(--sky-card-background);
}

.feature-row-head {
  align-items: center;
  cursor: grab;
  display: flex;
  gap: var(--sky-space-3);
  padding: var(--sky-space-3) var(--sky-space-4);
  touch-action: none;
}

.feature-row-head:focus-visible {
  outline: var(--sky-focus-ring);
  outline-offset: -2px;
}

.feature-row.is-dragging .feature-row-head {
  cursor: grabbing;
}

.disclosure {
  color: var(--sky-text-muted);
  font-size: 0.8rem;
  transition: transform 0.15s ease;
  width: 0.8em;
}

.feature-row-head[aria-expanded="true"] .disclosure {
  transform: rotate(90deg);
}

.feature-name {
  font-weight: 600;
}

.milestone-strip {
  display: flex;
  gap: 2px;
}

.strip-seg {
  background: var(--sky-color-border-control);
  border-radius: 1px;
  height: 8px;
  width: 8px;
}

.strip-seg.is-filled {
  background: var(--atlas-tone-done, var(--sky-color-primary));
}

.feature-next {
  color: var(--sky-text-secondary);
  flex: 1;
  font-size: 0.85rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.feature-spine[hidden] {
  display: none;
}

.feature-spine {
  border-top: 1px solid var(--sky-color-border);
  padding: var(--sky-space-4);
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test tests/theme.test.mjs`
Expected: PASS for every test added in Step 2. Other `theme.test.mjs` tests referencing `mobile`/
`workstream`/`milestone`/`library`/`document` pages should still pass unchanged; `decision 40`
tests should still pass since nothing in this markup names a project or a person.

- [ ] **Step 7: Build the fixture and confirm it doesn't crash**

Run: `node src/build.mjs fixture /tmp/atlas-task5-check --offline --quiet`
Expected: exits 0, `atlas: built N pages...`.

- [ ] **Step 8: Commit**

```bash
git add theme/_includes/depth.njk theme/tokens.css tests/theme.test.mjs
git commit -m "feat: rebuild feature planning as a collapsed accordion (2a)"
```

---

### Task 6: The milestone spine (2b), nested inside an expanded row

**Files:**
- Modify: `theme/_includes/depth.njk` (fill in `.feature-spine`)
- Modify: `theme/tokens.css` (spine + task-list rules)
- Modify: `tests/theme.test.mjs`

**Interfaces:**
- Consumes: `stream.milestones[i]` paired with `stream.spineDetail[i]` (Task 4's wiring — same
  index, same order) and `stream.manifest.milestones[i].tasks` (Task 1's output, attached in Task 4).
- Produces: `[data-milestone-node]`, `[data-task-list]`, `[data-task]` — the hooks Task 7's second
  wiring function (task-row drag/reorder) queries.

- [ ] **Step 1: Write the failing tests**

```javascript
test('spine: a done milestone collapses to one line — no task checklist', () => {
  const stream = workstreams.find((s) => s.manifest.milestones.some((m) => m.status === 'done'));
  assert.ok(stream, 'fixture needs a workstream with a done milestone');
  const milestone = stream.manifest.milestones.find((m) => m.status === 'done');
  const nodeMatch = new RegExp(
    `data-milestone-node="${stream.slug}-${milestone.id}"[\\s\\S]*?</div>\\s*</div>`,
  ).exec(depthHtml);
  assert.ok(nodeMatch, `no spine node rendered for ${stream.slug}/${milestone.id}`);
  assert.doesNotMatch(nodeMatch[0], /data-task-list/, 'a done milestone must not render a task list');
});

test('spine: every milestone node shows its own real label, always', () => {
  const stream = workstreams.find((s) => s.manifest.milestones.length > 0);
  const spineBlock = new RegExp(`id="spine-${stream.slug}"[\\s\\S]*?</div>\\s*</li>`).exec(depthHtml)[0];
  for (const milestone of stream.manifest.milestones) {
    assert.ok(spineBlock.includes(milestone.label), `milestone ${milestone.id}'s own label is not on its node`);
  }
});

test('spine: the current milestone renders its full task list, unmuted', () => {
  const stream = workstreams.find((s) => s.manifest.milestones.some((m) => m.status === 'next' && m.tasks && m.tasks.length));
  if (!stream) return; // fixture may not have this shape; Task 4's build.test.mjs covers the parse itself
  const milestone = stream.manifest.milestones.find((m) => m.status === 'next');
  const nodeMatch = new RegExp(`data-milestone-node="${stream.slug}-${milestone.id}"[\\s\\S]*?data-task-list[\\s\\S]*?</ul>`).exec(depthHtml);
  assert.ok(nodeMatch, 'current milestone did not render a task list');
  assert.doesNotMatch(nodeMatch[0], /class="task-list is-muted"/, 'the current milestone\'s task list must not be muted');
});

test('spine: a task line shows its owner, or "Unassigned" when it has none', () => {
  const stream = workstreams.find((s) => s.manifest.milestones.some((m) => (m.tasks || []).length));
  if (!stream) return;
  const milestone = stream.manifest.milestones.find((m) => (m.tasks || []).length);
  const html = depthHtml;
  for (const t of milestone.tasks) {
    const label = t.owner || 'Unassigned';
    assert.ok(html.includes(label), `task "${t.text}" should show owner label "${label}"`);
  }
});

test('spine: a done task is struck through', () => {
  const stream = workstreams.find((s) => s.manifest.milestones.some((m) => (m.tasks || []).some((t) => t.done)));
  if (!stream) return;
  assert.match(depthHtml, /class="task-line is-done"/);
});
```

(These tests read `assert.doesNotMatch`/conditional `if (!stream) return` because the shipped
Atlas fixture may not yet contain a milestone with a populated `tasks` array — the fixture data
itself is a separate concern from this task's job of rendering `tasks` correctly *when present*.
If the fixture's existing milestones all have empty `tasks` today, this task's tests still prove
the done/no-list rule and the label rule via real fixture data, and the task-list-specific
assertions self-skip rather than false-fail on fixture data this task doesn't own. Do not invent
fixture data in this task — that's out of scope; Task 9 or a follow-up fixture update is where
real task-bearing fixture milestones would be added, if ever needed for a fuller demo.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/theme.test.mjs`
Expected: FAIL — `.feature-spine` is currently empty from Task 5.

- [ ] **Step 3: Fill in the spine block in `theme/_includes/depth.njk`**

Replace the placeholder comment inside `.feature-spine` (from Task 5) with:

```jinja
<div class="feature-spine" id="spine-{{ stream.slug }}" data-feature-spine hidden>
{%- if stream.milestones.length == 0 %}
<p class="spine-empty">No milestones on record yet.</p>
{%- else %}
<ol class="milestone-spine">
{%- for milestone in stream.milestones %}
{%- set detail = stream.spineDetail[loop.index0] %}
<li class="milestone-node tone-{{ milestone.manifest.status }}" data-milestone-node="{{ stream.slug }}-{{ milestone.manifest.id }}">
<span class="milestone-icon" aria-hidden="true"></span>
<div class="milestone-body">
<div class="milestone-head">
<span class="milestone-label">{{ milestone.manifest.label }}</span>
<span class="milestone-title">{{ milestone.manifest.title }}</span>
{{ ui.chip('status', milestone.manifest.status) }}
</div>
{%- if detail == 'full' or detail == 'full-muted' %}
{%- if milestone.manifest.tasks.length %}
<ul class="task-list{% if detail == 'full-muted' %} is-muted{% endif %}" data-task-list data-milestone="{{ stream.slug }}-{{ milestone.manifest.id }}">
{%- for t in milestone.manifest.tasks %}
<li class="task-line{% if t.done %} is-done{% endif %}" data-task data-task-index="{{ loop.index0 }}">
<span class="task-check" aria-hidden="true">{% if t.done %}✓{% else %}○{% endif %}</span>
<span class="task-text">{{ t.text }}</span>
<span class="task-owner">{{ t.owner or 'Unassigned' }}</span>
</li>
{%- endfor %}
</ul>
{%- endif %}
{%- elif detail == 'count' and milestone.manifest.tasks.length %}
<p class="milestone-task-count">{{ milestone.manifest.tasks.length }} sub-task{{ 's' if milestone.manifest.tasks.length != 1 else '' }}</p>
{%- endif %}
</div>
</li>
{%- endfor %}
</ol>
{%- endif %}
</div>
```

`ui.chip('status', milestone.manifest.status)` reuses the existing `chipLabel` macro's entries for
`done`/`next`/`parked`/`unplanned` (already in `base.njk`); `blocked` is also already in that map.
No new chip vocabulary needed — this is the same macro every other status chip on the site uses.

- [ ] **Step 4: Add spine CSS to `theme/tokens.css`**

```css
.milestone-spine {
  border-left: 2px solid var(--sky-color-border);
  list-style: none;
  margin: 0;
  padding: 0 0 0 var(--sky-space-4);
}

.milestone-node {
  padding: var(--sky-space-2) 0 var(--sky-space-2) var(--sky-space-4);
  position: relative;
}

.milestone-icon {
  background: var(--sky-color-border-control);
  border-radius: 50%;
  height: 10px;
  left: calc(-1 * var(--sky-space-4) - 5px);
  position: absolute;
  top: var(--sky-space-2);
  width: 10px;
}

.milestone-node.tone-done .milestone-icon {
  background: var(--atlas-tone-done, var(--sky-color-primary));
}

.milestone-node.tone-next .milestone-icon {
  background: var(--sky-card-background);
  border: 2px solid var(--atlas-tone-live, var(--sky-color-primary));
}

.milestone-node.tone-parked .milestone-icon {
  background: var(--sky-danger-text);
}

.milestone-head {
  align-items: baseline;
  display: flex;
  gap: var(--sky-space-2);
}

.milestone-label {
  font-family: var(--atlas-font-mono, monospace);
  font-size: 0.75rem;
  font-weight: 600;
}

.milestone-title {
  font-weight: 600;
}

.task-list {
  list-style: none;
  margin: var(--sky-space-2) 0 0;
  padding: 0;
}

.task-list.is-muted {
  opacity: 0.65;
}

.task-line {
  align-items: baseline;
  display: flex;
  gap: var(--sky-space-2);
  padding: 2px 0;
}

.task-line.is-done .task-text {
  color: var(--sky-text-muted);
  text-decoration: line-through;
}

.task-owner {
  color: var(--sky-text-muted);
  font-size: 0.8rem;
  margin-left: auto;
}

.milestone-task-count {
  color: var(--sky-text-muted);
  font-size: 0.85rem;
  margin: var(--sky-space-1) 0 0;
}
```

(If `--atlas-font-mono`/`--atlas-tone-live` don't already exist as tokens, check
`theme/tokens.css`'s existing `--atlas-*` block for the actual names in use — reuse whatever the
retired chart's own tone tokens were called rather than inventing new ones; they're color tokens,
not chart-geometry, so they very likely survive Task 5's chart-CSS removal untouched.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/theme.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add theme/_includes/depth.njk theme/tokens.css tests/theme.test.mjs
git commit -m "feat: the milestone spine (2b), nested inside an expanded feature row"
```

---

### Task 7: `theme/order.js` — reorder/hide against real rows; retire the modal wiring

**Files:**
- Modify: `theme/order.js`
- Modify: `tests/order.test.mjs`

**Interfaces:**
- Consumes: `[data-feature-list]`, `[data-slug]`, `[data-row-handle]`, `[data-order-said]`,
  `[data-hidden-bar]` (Task 5's markup).
- Produces: expand/collapse toggling on click (`aria-expanded`, un-hiding `.feature-spine`) —
  Task 6's spine becomes visible through this task's click handling, not a separate script.

Every pure function already exported (`orderSlugs`, `moveSlug`, `announce`, `partitionHidden`,
`toggleHidden`, `announceHidden`, `readHidden`, `writeHidden`, `readOrder`, `writeOrder`) is
untouched — none of them ever touched SVG. Only `wire()`'s DOM-repaint half, `layout`/`dropIndex`'s
pixel math, and the whole modal-opening block change.

- [ ] **Step 1: Write the failing tests**

`theme/order.js`'s event plumbing has no browser in this test environment (stated in the module's
own header comment) — `tests/order.test.mjs` only exercises the pure exports. Add tests for the
two exports whose *signature* changes (`layout`, `dropIndex` move from horizontal `pitch` to
vertical `rowHeight` — same shape, renamed parameter, so existing call sites in tests need the
rename, not new logic):

```javascript
// tests/order.test.mjs — the existing `layout`/`dropIndex` tests already there use a `pitch`
// parameter name only in the test's own local variable naming, not in an assertion on the name
// itself; if they do reference `pitch` in an assertion message only, that's cosmetic and doesn't
// need to change. Add:

test('dropIndex: a downward drag past half the row height moves to the next row', () => {
  assert.equal(dropIndex(0, 30, 52, 4), 1); // 30 > 52/2, rounds up to index 1
});

test('dropIndex: a small drag within half a row height snaps back to the same row', () => {
  assert.equal(dropIndex(0, 10, 52, 4), 0);
});
```

(`dropIndex`'s existing implementation — `Math.round((from) + dx / pitch)` clamped — already
behaves correctly for a renamed-but-equivalent `rowHeight` parameter; these two tests just confirm
the rounding-at-the-midpoint behavior explicitly for the vertical case, since the design doc calls
for the same "distance-based, not pixel-perfect" feel the horizontal drag had.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/order.test.mjs`
Expected: PASS already, if `dropIndex`'s math is unchanged (it is — see Step 3). This step exists
to confirm before touching `wire()` that the pure layer needs no logic change, only the DOM layer
does. If these two new tests already pass against the untouched module, proceed straight to Step 3.

- [ ] **Step 3: Rewrite `wire()`'s DOM half in `theme/order.js`**

Delete entirely: the whole modal-opening block (`let openedFrom = null;` through the closing of
the `for (const dialog of doc.querySelectorAll('[data-feature-modal]'))` loop — roughly the
"the feature's own triage, as a modal" section) and every call to `openModal`.

Replace the `wire()` function's selectors and repaint logic:

```javascript
function wire(doc, storage) {
  const container = doc.querySelector('[data-feature-list]');
  if (!container) return;

  const rows = new Map();
  for (const node of container.querySelectorAll('[data-slug]')) {
    rows.set(node.getAttribute('data-slug'), node);
  }
  const generated = [...rows.keys()];
  if (generated.length < 2) return;

  // The row height IS the drag unit here — there is no SVG column pitch any more. Measured from
  // the first row's own rendered height rather than hard-coded, so it tracks whatever the
  // stylesheet actually does at any viewport width.
  const rowHeight = rows.values().next().value.getBoundingClientRect().height || 1;

  const said = doc.querySelector('[data-order-said]');
  const hiddenBar = doc.querySelector('[data-hidden-bar]');
  let order = orderSlugs(generated, readOrder(storage));
  let hidden = partitionHidden(order, readHidden(storage)).hidden;

  const nameOf = (slug) => rows.get(slug)?.querySelector('[data-row-handle]')?.getAttribute('data-name') || slug;

  function renderHiddenBar() {
    if (!hiddenBar) return;
    hiddenBar.textContent = '';
    if (hidden.length === 0) {
      hiddenBar.setAttribute('hidden', '');
      return;
    }
    hiddenBar.removeAttribute('hidden');

    const label = doc.createElement('span');
    label.className = 'hidden-bar-label';
    label.textContent = hidden.length === 1 ? '1 feature hidden:' : `${hidden.length} features hidden:`;
    hiddenBar.appendChild(label);

    for (const slug of hidden) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'hidden-restore';
      button.setAttribute('data-restore', slug);
      button.textContent = `Show ${nameOf(slug)}`;
      hiddenBar.appendChild(button);
    }
    if (hidden.length > 1) {
      const all = doc.createElement('button');
      all.type = 'button';
      all.className = 'hidden-restore';
      all.setAttribute('data-restore-all', '');
      all.textContent = 'Show all';
      hiddenBar.appendChild(all);
    }
  }

  function render() {
    const { visible } = partitionHidden(order, hidden);
    for (const [slug, node] of rows) {
      if (visible.includes(slug)) {
        node.removeAttribute('hidden');
      } else {
        node.setAttribute('hidden', '');
      }
    }
    // Reordering real DOM children IS the repaint — no transform, no pixel math for the settled
    // state. Only a live drag (see pointermove below) needs a visual nudge before it lands.
    for (const slug of order) container.appendChild(rows.get(slug));
    renderHiddenBar();
  }

  function commit(next) {
    order = next;
    writeOrder(storage, order);
    render();
  }

  function commitHidden(next, focusSlug) {
    hidden = partitionHidden(order, next).hidden;
    writeHidden(storage, hidden.length ? hidden : null);
    render();
    const landing = focusSlug
      ? hiddenBar?.querySelector(`[data-restore="${focusSlug}"]`) ||
        rows.get(focusSlug)?.querySelector('[data-row-handle]')
      : null;
    if (landing && typeof landing.focus === 'function') landing.focus();
  }

  function toggleExpand(handle) {
    const expanded = handle.getAttribute('aria-expanded') === 'true';
    const spine = doc.getElementById(handle.getAttribute('aria-controls'));
    handle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    if (spine) {
      if (expanded) spine.setAttribute('hidden', '');
      else spine.removeAttribute('hidden');
    }
  }

  render();

  for (const [slug, node] of rows) {
    const handle = node.querySelector('[data-row-handle]');
    if (!handle) continue;

    handle.addEventListener('keydown', (event) => {
      if (event.key === 'h' || event.key === 'H') {
        event.preventDefault();
        commitHidden(toggleHidden(hidden, slug), slug);
        if (said) said.textContent = announceHidden(nameOf(slug), hidden.length);
        return;
      }
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        toggleExpand(handle);
        return;
      }
      // Vertical list: up/down move a row, matching arrow-key semantics to the actual layout
      // direction (the SVG version used left/right, because lanes sat side by side).
      const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
      if (delta === 0) return;
      event.preventDefault();
      commit(moveSlug(order, slug, delta));
      handle.focus();
      if (said) said.textContent = announce(order, slug, handle.getAttribute('data-name') || slug);
    });

    let startY = null;
    let startIndex = 0;

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      startY = event.clientY;
      startIndex = order.indexOf(slug);
      node.classList.add('is-dragging');
      try {
        handle.setPointerCapture(event.pointerId);
      } catch (err) {
        // Not every pointer can be captured; move/up still fire on the handle.
      }
    });

    handle.addEventListener('pointermove', (event) => {
      if (startY === null) return;
      const dy = event.clientY - startY;
      // A live visual nudge only — the settled position always comes from `render()`'s DOM
      // reorder. No scale correction needed here: real pixels, not a scaled SVG viewBox.
      node.style.transform = `translateY(${dy}px)`;
    });

    function end(event) {
      if (startY === null) return;
      const dy = event.clientY - startY;
      startY = null;
      node.classList.remove('is-dragging');
      node.style.removeProperty('transform');

      if (Math.abs(dy) < CLICK_SLOP) {
        toggleExpand(handle);
        return;
      }

      const to = dropIndex(startIndex, dy, rowHeight, order.length);
      commit(moveSlug(order, slug, to - order.indexOf(slug)));
    }

    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  if (hiddenBar) {
    hiddenBar.addEventListener('click', (event) => {
      const target = event.target?.closest?.('[data-restore], [data-restore-all]');
      if (!target) return;
      if (target.hasAttribute('data-restore-all')) {
        commitHidden([], hidden[0]);
        return;
      }
      const slug = target.getAttribute('data-restore');
      commitHidden(toggleHidden(hidden, slug), slug);
      if (said) said.textContent = `${nameOf(slug)} is back on the list.`;
    });
  }
}
```

Note: `CLICK_SLOP` (still `4`, in real pixels now rather than SVG user units — see the module's
top-level `export const CLICK_SLOP = 4;`, unchanged) governs the same drag-vs-click
disambiguation, now resolving to "toggle expand" instead of "open a modal." The `data-order-reset`
button and its whole block from the original `wire()` are **not** ported — that control was
already removed from the template in the prior live-feedback round (the owner: "you can remove
back to the generated order, I don't know that"); do not reintroduce it here.

- [ ] **Step 4: Update the module header comment**

The existing top-of-file comment references "`src/chart.mjs` draws every lane about its own
origin... reordering is arithmetic on one number per lane" — update this paragraph to describe the
current mechanism (real DOM rows, `container.appendChild` order, no chart geometry) rather than
leaving a comment describing deleted code.

- [ ] **Step 5: Run the full order test file**

Run: `node --test tests/order.test.mjs`
Expected: PASS — every existing pure-function test still holds (none of those functions changed
behavior, only `wire()`'s internals and the two callers `layout`/`dropIndex` — check whether
`layout` is still called anywhere in the new `wire()`; if not, per YAGNI, remove its now-dead call
site usage from `render()` — but keep the export itself, since Task 8 reuses `dropIndex`'s pattern
for task rows and a reviewer may want `layout` for a future page; if genuinely unused by both
Task 7 and Task 8, remove `layout`'s export and its test, since a codebase with no dead code is
this project's own stated standard — check Task 8 first before deciding).

- [ ] **Step 6: Commit**

```bash
git add theme/order.js tests/order.test.mjs
git commit -m "feat: reorder/hide/expand against real DOM rows; retire the SVG-lane and modal wiring"
```

---

### Task 8: Task-row reordering inside an expanded milestone

**Files:**
- Modify: `theme/order.js` (new exported wiring function, reusing existing pure helpers)
- Modify: `tests/order.test.mjs`

**Interfaces:**
- Consumes: `[data-task-list]`, `[data-task]`, `[data-task-index]` (Task 6's markup).
- Produces: a second, independent `localStorage` key namespaced per milestone, so reordering one
  milestone's tasks never touches another's.

Per the design doc: "a per-device display preference only... dragging never writes back to
GitHub." The parsed task order (Task 1's output) is the record; this task only changes what order
they're *displayed* in, on this device.

- [ ] **Step 1: Write the failing tests**

```javascript
// tests/order.test.mjs — add alongside the existing pure-function tests.

import { taskOrderKey, orderTaskIndices } from '../theme/order.js'; // add to existing import block

test('taskOrderKey: namespaced per milestone, so two milestones never collide', () => {
  assert.equal(taskOrderKey('beacon-M1'), 'atlas-task-order:beacon-M1');
  assert.notEqual(taskOrderKey('beacon-M1'), taskOrderKey('beacon-M2'));
});

test('orderTaskIndices: with nothing stored, tasks render in their parsed (original) order', () => {
  assert.deepEqual(orderTaskIndices(3, null), [0, 1, 2]);
});

test('orderTaskIndices: a stored permutation is honoured', () => {
  assert.deepEqual(orderTaskIndices(3, [2, 0, 1]), [2, 0, 1]);
});

test('orderTaskIndices: a stored order missing an index still shows every task — the missing one goes to the end', () => {
  assert.deepEqual(orderTaskIndices(3, [1]), [1, 0, 2]);
});

test('orderTaskIndices: a stored index out of range for the current task count is dropped, not thrown', () => {
  assert.deepEqual(orderTaskIndices(2, [5, 0, 1]), [0, 1]);
});

test('orderTaskIndices: a stored value that is not an array of numbers is treated as no stored order', () => {
  assert.deepEqual(orderTaskIndices(2, 'not an array'), [0, 1]);
  assert.deepEqual(orderTaskIndices(2, ['a', 'b']), [0, 1]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/order.test.mjs`
Expected: FAIL — `taskOrderKey`/`orderTaskIndices` don't exist yet.

- [ ] **Step 3: Implement the pure helpers, then the DOM wiring**

Add near the top of `theme/order.js`, beside `ORDER_KEY`/`HIDDEN_KEY`:

```javascript
/**
 * The localStorage key a milestone's task order is remembered under. Namespaced per milestone
 * (the same `{slug}-{milestoneId}` id Task 6's `data-task-list` carries) so reordering one
 * milestone's tasks can never collide with, or be mistaken for, another's.
 *
 * @param {string} milestoneKey
 * @returns {string}
 */
export function taskOrderKey(milestoneKey) {
  return `atlas-task-order:${milestoneKey}`;
}

/**
 * Which original task indices to render, and in what order — the task-row equivalent of
 * `orderSlugs`, operating on positions (0..count-1) instead of slugs, since a task has no stable
 * identity of its own beyond its position in the parsed checklist.
 *
 * Same three guarantees as `orderSlugs`: an index the stored order doesn't know about (the
 * checklist grew) goes to the end in original order; a stored index no longer valid (the
 * checklist shrank) is dropped; a stored value that isn't a list of numbers is no stored order.
 *
 * @param {number} count - how many tasks this milestone has right now.
 * @param {unknown} stored - whatever came out of storage.
 * @returns {number[]} every index 0..count-1, exactly once.
 */
export function orderTaskIndices(count, stored) {
  const known = new Set(Array.from({ length: count }, (_, i) => i));
  const taken = new Set();
  const result = [];

  if (Array.isArray(stored)) {
    for (const index of stored) {
      if (typeof index !== 'number' || !known.has(index) || taken.has(index)) continue;
      taken.add(index);
      result.push(index);
    }
  }
  for (const index of known) {
    if (!taken.has(index)) result.push(index);
  }
  return result;
}
```

Add the DOM wiring as a second, independent function, called alongside `wire()` at the bottom of
the file:

```javascript
function wireTaskLists(doc, storage) {
  for (const list of doc.querySelectorAll('[data-task-list]')) {
    const milestoneKey = list.getAttribute('data-milestone');
    if (!milestoneKey) continue;

    const items = [...list.querySelectorAll('[data-task]')];
    if (items.length < 2) continue;
    const rowHeight = items[0].getBoundingClientRect().height || 1;

    function readStored() {
      try {
        const raw = storage?.getItem(taskOrderKey(milestoneKey));
        return typeof raw === 'string' ? JSON.parse(raw) : null;
      } catch (err) {
        return null;
      }
    }
    function writeStored(order) {
      try {
        if (order === null) storage?.removeItem(taskOrderKey(milestoneKey));
        else storage?.setItem(taskOrderKey(milestoneKey), JSON.stringify(order));
      } catch (err) {
        // Nothing to persist to; the order still holds for this page view.
      }
    }

    let order = orderTaskIndices(items.length, readStored());

    function render() {
      for (const index of order) list.appendChild(items[index]);
    }
    function commit(next) {
      order = next;
      writeStored(order);
      render();
    }

    render();

    items.forEach((item, originalIndex) => {
      item.setAttribute('tabindex', '0');
      let startY = null;
      let startPos = 0;

      item.addEventListener('pointerdown', (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        startY = event.clientY;
        startPos = order.indexOf(originalIndex);
        item.classList.add('is-dragging');
        try {
          item.setPointerCapture(event.pointerId);
        } catch (err) {
          // Not every pointer can be captured.
        }
      });
      item.addEventListener('pointermove', (event) => {
        if (startY === null) return;
        item.style.transform = `translateY(${event.clientY - startY}px)`;
      });
      function end(event) {
        if (startY === null) return;
        const dy = event.clientY - startY;
        startY = null;
        item.classList.remove('is-dragging');
        item.style.removeProperty('transform');
        if (Math.abs(dy) < CLICK_SLOP) {
          render(); // snap back — a click on a task row does nothing else
          return;
        }
        const to = dropIndex(startPos, dy, rowHeight, order.length);
        commit(moveSlug(order.map(String), String(originalIndex), to - order.indexOf(originalIndex)).map(Number));
      }
      item.addEventListener('pointerup', end);
      item.addEventListener('pointercancel', end);

      item.addEventListener('keydown', (event) => {
        const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
        if (delta === 0) return;
        event.preventDefault();
        commit(moveSlug(order.map(String), String(originalIndex), delta).map(Number));
        item.focus();
      });
    });
  }
}
```

(`moveSlug` operates on strings by its existing signature — `order.map(String)`/`.map(Number)`
reuses it for numeric indices rather than duplicating its logic for a second type. This is a
reuse-over-reinvention call, not a hack: `moveSlug`'s algorithm is type-agnostic array-splicing:
the string round-trip is the cheapest way to reuse a tested function without changing its
signature for one caller.)

Wire it up at the bottom of the file, beside the existing `wire(document, storage)` call:

```javascript
if (typeof document !== 'undefined') {
  let storage = null;
  try {
    storage = window.localStorage;
  } catch (err) {
    // Blocked site data. Everything below still works; it simply forgets between visits.
  }
  wire(document, storage);
  wireTaskLists(document, storage);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/order.test.mjs`
Expected: PASS, including the six new tests from Step 1.

- [ ] **Step 5: Decide `layout`'s fate (deferred from Task 7 Step 5)**

Grep `theme/order.js` for remaining calls to `layout(`. If none exist after Task 7 and Task 8 (both
use direct DOM reordering instead), remove the `layout` export and its test from
`tests/order.test.mjs` — dead code left behind is exactly what this codebase's own conventions
(and this plan's Global Constraints) forbid. Run `node --test tests/order.test.mjs` again after
removing it to confirm nothing else depended on it.

- [ ] **Step 6: Commit**

```bash
git add theme/order.js tests/order.test.mjs
git commit -m "feat: task rows within an expanded milestone are also draggable to reorder"
```

---

### Task 9: `theme/_includes/mobile.njk` — triage grouped by blocking state (1c)

**Files:**
- Modify: `theme/_includes/mobile.njk` (full rewrite)
- Modify: `theme/tokens.css`
- Modify: `tests/theme.test.mjs`

**Interfaces:**
- Consumes: `triaged` (unchanged shape — `orderByTriage`'s output, already grouped by state in
  sequence; Task 5 already updated `renderMobile` to call it with the new `assemble()`).
- Produces: nothing downstream depends on this template beyond what already existed (`triaged` is
  the same data mobile always received).

- [ ] **Step 1: Write the failing tests**

```javascript
test('triage: five section headers, in TRIAGE_ORDER sequence, each with a real count', () => {
  const LABELS = {
    'awaiting-decision': 'Waiting on you',
    moving: 'Moving',
    blocked: 'Blocked',
    designing: 'Designing',
    'not-started': 'Not started',
  };
  const present = TRIAGE_ORDER.filter((state) => workstreams.some((s) => s.triage === state));
  let lastIndex = -1;
  for (const state of present) {
    const count = workstreams.filter((s) => s.triage === state).length;
    const headingRe = new RegExp(`${LABELS[state]}[\\s\\S]{0,40}${count}`);
    const index = mobileHtml.search(headingRe);
    assert.ok(index !== -1, `no section header found for "${LABELS[state]}" with count ${count}`);
    assert.ok(index > lastIndex, `sections are out of TRIAGE_ORDER sequence at "${LABELS[state]}"`);
    lastIndex = index;
  }
});

test('triage: a state with zero workstreams gets no section at all', () => {
  // Every fixture state that has zero matching workstreams must not have a heading in the output.
  const LABELS = {
    'awaiting-decision': 'Waiting on you',
    moving: 'Moving',
    blocked: 'Blocked',
    designing: 'Designing',
    'not-started': 'Not started',
  };
  for (const state of TRIAGE_ORDER) {
    const count = workstreams.filter((s) => orderByTriage(assemble(workstreams)).find((w) => w.slug === s.slug)?.triage === state).length;
    if (count === 0) {
      assert.doesNotMatch(mobileHtml, new RegExp(`>${LABELS[state]}<`), `an empty section rendered for ${state}`);
    }
  }
});

test('triage: 1a is fully gone — no status-board table shape on this page', () => {
  assert.doesNotMatch(mobileHtml, /<table/);
});

test('triage: each card still says what, position and gate, same as before this rebuild', () => {
  for (const stream of workstreams) {
    assert.ok(mobileHtml.includes(stream.manifest.what), `${stream.slug}'s "what" is missing`);
    assert.ok(mobileHtml.includes(stream.manifest.gate), `${stream.slug}'s gate is missing`);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/theme.test.mjs`
Expected: FAIL — the current `mobile.njk` renders one flat list, no section headers.

- [ ] **Step 3: Rewrite `theme/_includes/mobile.njk`**

```jinja
{#- Atlas — surface two: triage on a phone (decision 27), grouped by state (design doc: 1c).

  Presentation only. src/triage.mjs still decides everything: which state a workstream is in, and
  the order both this page and state.json read. This layout adds section headers over groups that
  were always contiguous in `triaged` — it classifies nothing and sorts nothing.

  Data this layout expects:
    triaged — orderByTriage(...)'s output, already in state order.
    project, repo, title — see base.njk
-#}
{% extends "base.njk" %}
{% import "base.njk" as ui %}

{% block bodyClass %}page page-mobile{% endblock %}

{% set SECTION_LABEL = {
  "awaiting-decision": "Waiting on you",
  "moving": "Moving",
  "blocked": "Blocked",
  "designing": "Designing",
  "not-started": "Not started"
} %}

{% block content %}
<h1>What needs you</h1>
<p class="lede">Grouped by what's blocking, not by feature. Every card ends on the gate that is holding it.</p>

{%- set currentState = "" %}
{%- for stream in triaged %}
{%- if stream.triage != currentState %}
{%- if not loop.first %}</ul>{% endif %}
{%- set currentState = stream.triage %}
{%- set sectionCount = triaged | selectattr("triage", "equalto", currentState) | list | length %}
<h2 class="triage-heading">{{ SECTION_LABEL[currentState] }} <span class="triage-count">{{ sectionCount }}</span></h2>
<ul class="card-list">
{%- endif %}
<li>
<article class="card" data-workstream="{{ stream.manifest.codename }}" data-triage="{{ stream.triage }}">
<header class="card-head">
<h3><a href="{{ stream.url }}">{{ stream.manifest.codename }}</a></h3>
</header>
<p class="card-what">{{ stream.manifest.what }}</p>
<p class="card-position">{{ stream.manifest.position }}</p>
{% if stream.column.milestoneCount %}
<div class="track" role="img" aria-label="{{ stream.column.completedCount }} of {{ stream.column.milestoneCount }} milestones complete">
{% for filled in stream.column.covered %}<span class="track-seg{% if filled %} is-filled{% endif %}"></span>{% endfor %}
</div>
<p class="track-count"><span class="num">{{ stream.column.completedCount }}</span> of <span class="num">{{ stream.column.milestoneCount }}</span> milestones complete</p>
{% else %}
<p class="track-count empty">No milestones on record yet</p>
{% endif %}
{% if stream.column.tipLabel %}<p class="card-next">Next: {{ stream.column.tipLabel }}</p>{% endif %}
<p class="card-gate"><span class="card-gate-label">Gate</span>{{ stream.manifest.gate }}</p>
</article>
</li>
{%- if loop.last %}</ul>{% endif %}
{%- endfor %}
{% endblock %}
```

Note the section-boundary detection: Nunjucks can't mutate an outer-scope variable inside a `for`
loop in the general case, but `{% set %}` *reassignment* of a simple scalar at the top level of the
loop body (not inside a nested `{% if %}` block writing to an already-declared outer name) works in
Nunjucks — this is the same pattern to verify against the actual Nunjucks version pinned in
`package.json` before relying on it. If `{% set currentState = stream.triage %}` does NOT persist
across loop iterations in this Eleventy/Nunjucks version (test this first with a one-line scratch
template before writing the real one), use the alternative, guaranteed-safe approach instead:
precompute the grouped structure in the test/build data itself rather than in the template —
i.e., have `renderMobile`'s caller (in practice, `src/build.mjs`'s `planPages`, alongside
`triaged: site.triaged`) also pass a pre-grouped `triageSections: [{ state, label, count,
workstreams }]` array (grouped via plain JS `TRIAGE_ORDER.map(state => ({...}))`, mirroring how
`src/triage.mjs`'s own `orderByTriage` already groups), and loop over THAT in the template with a
plain nested `{% for section in triageSections %}` / `{% for stream in section.workstreams %}` —
which avoids the whole Nunjucks-scoping question entirely and is the safer default if there is any
doubt. Prefer this precomputed-grouping approach unless the scratch-template test above proves the
inline `{% set %}` pattern reliable — precomputing in JS also keeps grouping logic testable without
a template engine, consistent with this plan's Global Constraints and the rest of this codebase's
own architecture (compute in JS, render in the template).

- [ ] **Step 4: Add triage-section CSS to `theme/tokens.css`**

```css
.triage-heading {
  align-items: baseline;
  display: flex;
  gap: var(--sky-space-2);
  margin: var(--sky-space-6) 0 var(--sky-space-3);
}

.triage-heading:first-of-type {
  margin-top: var(--sky-space-4);
}

.triage-count {
  color: var(--sky-text-muted);
  font-size: 0.85rem;
  font-weight: 400;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/theme.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add theme/_includes/mobile.njk theme/tokens.css tests/theme.test.mjs
git commit -m "feat: rebuild What needs you as triage grouped by blocking state (1c)"
```

---

### Task 10: Full-suite verification and fixture build

**Files:**
- None created or modified — this task is verification only.

**Interfaces:**
- Consumes: everything from Tasks 1-9.
- Produces: nothing new; this is the plan's final gate before the whole-branch review.

- [ ] **Step 1: Run the complete test suite**

Run: `node --test`
Expected: every test passes — 0 failures. Pay particular attention to `tests/build.test.mjs`,
`tests/state.test.mjs`, and `tests/swa.test.mjs`, none of which any earlier task in this plan
touched directly, but all of which read `site.ladder`/`site.workstreams` shapes this plan's Task 4
changed the composition of (added fields, never removed any) — a failure there means a field this
plan added collided with an existing one, which Task 4's "additive only" design should prevent,
but only a real run proves it.

- [ ] **Step 2: Build the real fixture and inspect the output**

```bash
rm -rf .atlas-out
node src/build.mjs fixture .atlas-out --offline --quiet
```

Expected: `atlas: built N pages and copied M files into .atlas-out`, exit 0. Serve `.atlas-out`
over HTTP (never `file://` — a root-absolute `/tokens.css` breaks under `file://`) and check with
a real browser (Playwright Chromium is available in this environment):

* `/index.html` — the accordion renders, one row per fixture feature, no dates/duration anywhere.
* Click a row — it expands, shows the spine, `aria-expanded` flips to `true`.
* Drag a row (or use arrow keys while focused) — order changes and persists across a reload.
* Press `H` on a focused row — it hides; the "hidden" strip above the list names it and offers a
  way back.
* `/mobile/index.html` — section headers group cards by state, in `TRIAGE_ORDER` sequence, no
  empty sections.

If the fixture has no milestone with a populated `tasks` array to visually confirm the spine's
task-list rendering end-to-end, that is expected (Task 6 noted this) — confirm instead via the
`node --test` coverage from Task 1/Task 6, which does cover it with invented data.

- [ ] **Step 3: Run the impeccable skill's mechanical detector against every changed UI file**

```bash
node .agents/skills/impeccable/scripts/detect.mjs --json \
  theme/_includes/depth.njk theme/_includes/mobile.njk theme/order.js theme/tokens.css
```

(Path to `impeccable` is in the Vennusign repo, not this Atlas worktree — resolve its actual
absolute path the same way it was invoked in this project's prior UI-feedback round, since it is
being run *against* Atlas's files while its own script lives elsewhere.)

Fix anything flagged that is inside code this plan touched; a pre-existing flag in code this plan
did not touch (e.g. the `.doc blockquote` left-rule flagged as a false-positive "side-tab" pattern
in the prior round) is out of scope here.

- [ ] **Step 4: Final check — no dead imports, no dead exports**

```bash
grep -rn "computeChart\|triageCards\|chart\.mjs" src/ theme/ tests/ --include="*.mjs" --include="*.njk" --include="*.js"
```

Expected: no matches (aside from this plan document and the design spec, which are prose, not
code). Any match is a task in this plan that missed a reference and needs fixing before the final
commit.

- [ ] **Step 5: Commit only if Steps 1-4 required fixes**

If everything already passed clean, there is nothing to commit here. If a fix was needed:

```bash
git add -A
git commit -m "fix: clean up remaining references after the feature planning rebuild"
```

---

## Self-review

**Spec coverage.** Every section of the design spec maps to a task: "What's retired, what stays"
→ Tasks 4, 7 (retirement) and the "kept unchanged" list is verified by never modifying
`src/depth.mjs`'s `computeLadder`, `src/triage.mjs`'s `classifyTriage`/`TRIAGE_ORDER`, or
`src/schema.mjs` in any task. "Surface 1" (2a) → Task 5. "Surface 1, expanded" (2b) → Task 6.
"Task lists: source and parsing" → Tasks 1-3. "Surface 2" (1c) → Task 9. "Implementation notes" →
Tasks 7-8 (order.js lift-not-reinvent) and Task 10 (dead-code check, decision 40 note is structural
— never validated, so nothing to test beyond what Task 1's parser tests already cover by not
enforcing an owner enum).

**Placeholder scan.** No task contains "TBD"/"add appropriate handling"/"similar to Task N without
the code." Task 9's Nunjucks `{% set %}`-scoping caveat is not a placeholder — it is a real,
disclosed uncertainty about one template-engine behavior with a fully concrete fallback plan
(precomputed grouping) given, and an explicit verification step (a scratch template) before
choosing which path to commit to.

**Type/signature consistency, checked across tasks:**
* `parseTasks(issueBody)` (Task 1) → consumed identically in Task 4's wiring and Task 6's test
  fixtures (`{ text, done, owner }[]`) — same field names throughout.
* `fetchIssueBodies({ repo, issueNumbers, token, fetchImpl })` (Task 2) → called in Task 4 exactly
  as declared, `Map<number, string|null>`, `.get(milestone.issue)` matches the Map's key type
  (`number`, since `milestone.issue` is validated as a positive integer by `src/schema.mjs`).
* `spineDetail(milestones)` (Task 3) → indexed 1:1 against `stream.manifest.milestones` in Task 4
  and Task 6's template (`stream.spineDetail[loop.index0]`), same array, same order, never
  re-sorted between them.
* `taskOrderKey`/`orderTaskIndices` (Task 8) operate on positions, not the task objects themselves
  — consistent with Task 6's `data-task-index` attribute, which is what Task 8's DOM code reads
  back out (`originalIndex` in the wiring loop matches `data-task-index`'s value by construction,
  since both are `loop.index0` / `items.forEach`'s own index over the same list order).
* `data-row-handle`/`data-name`/`data-slug`/`data-feature-list` (Task 5) → queried by exactly those
  selectors in Task 7, no renaming across the boundary.
