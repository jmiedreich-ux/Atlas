# Atlas M5 — The register becomes data — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a question register stops being prose an endpoint text-edits, and becomes a record with a
shape; the readable document is generated from it, the same way every other page in Atlas is.

**Architecture:** a new `src/register.mjs` (Atlas repo) holds the register's contract
(`validateRegister`, alongside `validateWorkstream` in spirit but a separate export — a register is
not a workstream) and `renderRegisterMarkdown`, which turns validated register data into the same
markdown shape the corpus already uses, then hands it to the existing `renderMarkdown`
(`src/markdown.mjs`) unchanged. `api/lib/handlers.mjs`'s `handleAnswer` is retargeted to read/write
a structured JSON record instead of editing `open-questions.md`'s prose in place; `api/lib/records.mjs`
gains `answerRegisterQuestion` beside (not replacing) the existing prose-editing `answerQuestion`,
which stays for any register not yet migrated. `src/build.mjs` discovers register JSON files the
same way it discovers manifests, generates each one's markdown document as build output, and builds
an index page ordered by what's open.

**Tech Stack:** Node.js (`node --test`), the existing markdown/build pipeline. No new dependency.

**Spec:** `docs/features/atlas/m5-plan.md` (Vennusign repo) — the design this plan implements.
Read that first; this plan does not restate its reasoning, only makes it concrete.

## Global Constraints

* Decision 1/3 — built from source, never maintained twice. The generated document is build
  output; a hand edit to it is lost on the next build (Task 2's own acceptance criterion).
* Decision 32 — closed vocabularies fail loudly, by name, never render blank. `severity`
  (`BLOCKING`/`important`/`minor`), and `chosen` states (`offered`/`written-in`/`deferred`) are
  closed enums, validated in `src/register.mjs`'s `validateRegister`, same pattern as
  `src/schema.mjs`'s `requireEnum`.
* Decision 35/37 — write-back stays commit-only, no state kept anywhere. `handleAnswer`'s existing
  five-step order (authorise → credential → validate → read+SHA → write+SHA) is unchanged; only
  what step 5 writes changes, from a prose block to a JSON record.
* `MAX_TEXT = 8000` (`api/lib/records.mjs`) is the existing cap on an answer/note's length — reuse
  it for a write-in answer's length rather than inventing a second number.
* Every new/changed test lives in this repo's existing `node --test` / `node:assert/strict` style
  — flat `test(name, async () => {...})`, no `describe`, matching `tests/schema.test.mjs` and
  `tests/writeback-*.test.mjs`.
* **Task 6 (the existing 209-question Menus corpus) is deferred, not migrated, in this milestone.**
  See Task 6 below for the full reasoning — this is a stated, spec-sanctioned choice
  ("the decision to leave historical registers as prose is recorded, along with what that
  costs"), not a scope cut nobody agreed to.

---

## File structure

**Created (Atlas repo):**
* `src/register.mjs` — `validateRegister(obj)`, `renderRegisterMarkdown(register)`.
* `tests/register.test.mjs`

**Modified (Atlas repo):**
* `api/lib/records.mjs` — add `answerRegisterQuestion(current, { questionId, chosen, chosenWasOffered, author })`, alongside the existing `answerQuestion` (kept, for un-migrated registers).
* `api/lib/handlers.mjs` — `handleAnswer` branches: if the workstream's register is the new
  structured JSON form, use `answerRegisterQuestion`; if it is still `open-questions.md` prose,
  use the existing `answerQuestion` unchanged. Never both for one workstream.
* `api/lib/payload.mjs` — `validateAnswerPayload` grows to accept either the old shape (`answer`
  as free text, for prose registers) or the new shape (`chosen`, `chosenWasOffered`, for
  structured ones) — see Task 5.
* `src/build.mjs` — discover `docs/features/<slug>/register.json` (new, optional) alongside
  `workstream.json`; when present, generate its markdown document and feed it through the existing
  document pipeline; build the registers index page.
* `theme/_includes/register.njk` (new template, not modified) — the write-ins-surfaced section.
* `theme/_includes/registers-index.njk` (new template) — Task 4.
* `tests/build.test.mjs`, `tests/writeback-handlers.test.mjs`, `tests/writeback-records.test.mjs`, `tests/writeback-place-api.test.mjs` (payload tests) — extended.

**Not touched:** `docs/features/menus/open-questions.md` (Vennusign repo) — stays prose, per
Task 6's deferral.

---

## Task 1: the register's contract

**Files:**
- Create: `src/register.mjs`
- Test: `tests/register.test.mjs`

**Interfaces:**
- Produces: `validateRegister(obj) → { ok: true, value } | { ok: false, errors: [{path, message}] }`,
  same contract shape as `validateWorkstream` in `src/schema.mjs`.
- Produces: `REGISTER_SEVERITIES = Object.freeze(['BLOCKING', 'important', 'minor'])`,
  `CHOSEN_KINDS = Object.freeze(['offered', 'written-in', 'deferred'])`.

A register is `{ slug: string, title: string, questions: RegisterQuestion[] }`. Each question:

```js
{
  id: 'Q1',                    // durable, decision 17-style — never renumbered
  question: 'string',
  why: 'string',
  options: ['string', ...],    // the offered choices, at least one
  recommended: 'string',       // must be one of options — validated by value, not index
  severity: 'BLOCKING',        // REGISTER_SEVERITIES
  chosen: {
    kind: 'offered',           // CHOSEN_KINDS
    value: 'string' | null,    // the chosen option's text (kind: offered) or the write-in text
                                // (kind: written-in); null when kind is 'deferred'
  },
  citations: ['string', ...],  // repository paths / free text, may be empty
}
```

- [ ] **Step 1: write the failing tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRegister } from '../src/register.mjs';

function question(overrides = {}) {
  return {
    id: 'Q1',
    question: 'A question invented for this test?',
    why: 'Because a test needs a why.',
    options: ['Option A', 'Option B'],
    recommended: 'Option A',
    severity: 'BLOCKING',
    chosen: { kind: 'offered', value: 'Option A' },
    citations: [],
    ...overrides,
  };
}

function register(overrides = {}) {
  return { slug: 'lighthouse', title: 'Lighthouse register', questions: [question()], ...overrides };
}

test('register: a well-formed register validates', () => {
  const result = validateRegister(register());
  assert.equal(result.ok, true);
});

test('register: an unknown severity is rejected by name', () => {
  const result = validateRegister(register({ questions: [question({ severity: 'urgent' })] }));
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /severity.*must be one of/i);
});

test('register: an unknown chosen.kind is rejected by name', () => {
  const result = validateRegister(register({ questions: [question({ chosen: { kind: 'maybe', value: null } })] }));
  assert.equal(result.ok, false);
});

test('register: recommended must name a real option', () => {
  const result = validateRegister(register({ questions: [question({ recommended: 'Option Z' })] }));
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /recommended.*must be one of.*options/i);
});

test('register: chosen.kind "offered" must name a real option too', () => {
  const result = validateRegister(
    register({ questions: [question({ chosen: { kind: 'offered', value: 'Option Z' } })] }),
  );
  assert.equal(result.ok, false);
});

test('register: chosen.kind "deferred" requires value to be null', () => {
  const result = validateRegister(
    register({ questions: [question({ chosen: { kind: 'deferred', value: 'Option A' } })] }),
  );
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /deferred.*value.*null/i);
});

test('register: chosen.kind "written-in" requires a non-empty value', () => {
  const result = validateRegister(
    register({ questions: [question({ chosen: { kind: 'written-in', value: '' } })] }),
  );
  assert.equal(result.ok, false);
});

test('register: two questions with the same id fail loudly', () => {
  const result = validateRegister(register({ questions: [question(), question()] }));
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /Q1.*already used/i);
});

test('register: citations defaults to an empty array when omitted, not required', () => {
  const q = question();
  delete q.citations;
  const result = validateRegister(register({ questions: [q] }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.questions[0].citations, []);
});
```

- [ ] **Step 2: run, watch it fail** — `node --test tests/register.test.mjs` — `Cannot find module '../src/register.mjs'`.

- [ ] **Step 3: implement**

```js
// src/register.mjs
//
// A question register's contract (M5, decision 51): a register is structured data, and its
// readable document (register.mjs's own renderRegisterMarkdown, below) is generated from it —
// decision 3's rule, applied here rather than excepted from.
//
// Every register in practice offers multiple choice with a recommendation, and the owner
// routinely supplies an answer that was not on the list. `chosen` therefore has three shapes,
// not two: an offered option was picked, an answer was written in, or the question is deferred —
// and an unanswered question is a deferral, never silent acceptance (the same rule the corpus's
// own README already states in prose).

export const REGISTER_SEVERITIES = Object.freeze(['BLOCKING', 'important', 'minor']);
export const CHOSEN_KINDS = Object.freeze(['offered', 'written-in', 'deferred']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
function joinPath(base, segment) {
  return base ? `${base}.${segment}` : segment;
}
function requireString(obj, key, path, errors) {
  if (!isNonEmptyString(obj[key])) {
    errors.push({ path: joinPath(path, key), message: `"${key}" is required and must be a non-empty string (got ${JSON.stringify(obj[key])})` });
    return false;
  }
  return true;
}
function requireEnum(obj, key, allowed, path, errors) {
  if (typeof obj[key] !== 'string' || !allowed.includes(obj[key])) {
    errors.push({ path: joinPath(path, key), message: `"${key}" must be one of: ${allowed.join(', ')} (got ${JSON.stringify(obj[key])})` });
    return false;
  }
  return true;
}

function validateChosen(chosen, options, path, errors) {
  if (!isPlainObject(chosen)) {
    errors.push({ path, message: '"chosen" is required and must be an object with "kind" and "value"' });
    return;
  }
  if (!requireEnum(chosen, 'kind', CHOSEN_KINDS, path, errors)) return;

  if (chosen.kind === 'deferred') {
    if (chosen.value !== null) {
      errors.push({ path: joinPath(path, 'value'), message: '"value" must be null when chosen.kind is "deferred"' });
    }
    return;
  }
  if (chosen.kind === 'written-in') {
    if (!isNonEmptyString(chosen.value)) {
      errors.push({ path: joinPath(path, 'value'), message: '"value" is required and must be a non-empty string when chosen.kind is "written-in"' });
    }
    return;
  }
  // kind === 'offered'
  if (!isNonEmptyString(chosen.value) || !options.includes(chosen.value)) {
    errors.push({
      path: joinPath(path, 'value'),
      message: `"value" must be one of this question's own "options" when chosen.kind is "offered" (got ${JSON.stringify(chosen.value)})`,
    });
  }
}

function validateQuestion(q, path, errors) {
  if (!isPlainObject(q)) {
    errors.push({ path, message: 'a register question must be an object' });
    return;
  }
  requireString(q, 'id', path, errors);
  requireString(q, 'question', path, errors);
  requireString(q, 'why', path, errors);

  if (!Array.isArray(q.options) || q.options.length === 0 || !q.options.every(isNonEmptyString)) {
    errors.push({ path: joinPath(path, 'options'), message: '"options" is required and must be a non-empty array of non-empty strings' });
  } else if (!requireString(q, 'recommended', path, errors)) {
    // already errored
  } else if (!q.options.includes(q.recommended)) {
    errors.push({ path: joinPath(path, 'recommended'), message: `"recommended" must be one of this question's own "options" (got ${JSON.stringify(q.recommended)})` });
  }

  requireEnum(q, 'severity', REGISTER_SEVERITIES, path, errors);
  if (Array.isArray(q.options)) validateChosen(q.chosen, q.options, joinPath(path, 'chosen'), errors);

  if (q.citations !== undefined && (!Array.isArray(q.citations) || !q.citations.every((c) => typeof c === 'string'))) {
    errors.push({ path: joinPath(path, 'citations'), message: '"citations" must be an array of strings when present' });
  }
}

function assertNoDuplicateIds(questions, errors) {
  const seen = new Map();
  questions.forEach((q, index) => {
    if (typeof q?.id !== 'string') return;
    const key = q.id.toLowerCase();
    const first = seen.get(key);
    if (first) {
      errors.push({
        path: `questions[${index}].id`,
        message: `question id ${JSON.stringify(q.id)} is already used by questions[${first}]`,
      });
      return;
    }
    seen.set(key, index);
  });
}

/**
 * Validate a question register (decision 51): the contract for
 * `docs/features/<slug>/register.json`.
 *
 * @param {unknown} obj
 * @returns {{ ok: true, value: object } | { ok: false, errors: { path: string, message: string }[] }}
 */
export function validateRegister(obj) {
  if (!isPlainObject(obj)) {
    return { ok: false, errors: [{ path: '', message: 'a register must be an object' }] };
  }
  const errors = [];
  requireString(obj, 'slug', '', errors);
  requireString(obj, 'title', '', errors);

  if (!Array.isArray(obj.questions)) {
    errors.push({ path: 'questions', message: '"questions" is required and must be an array' });
  } else {
    obj.questions.forEach((q, i) => validateQuestion(q, `questions[${i}]`, errors));
    assertNoDuplicateIds(obj.questions, errors);
  }

  if (errors.length > 0) return { ok: false, errors };

  const value = structuredClone(obj);
  value.questions = value.questions.map((q) => ({ citations: [], ...q }));
  return { ok: true, value };
}
```

- [ ] **Step 4: run, watch it pass** — `node --test tests/register.test.mjs`.

- [ ] **Step 5: commit** — `git add src/register.mjs tests/register.test.mjs && git commit -m "feat: the register's contract — validateRegister"`.

---

## Task 2: the document is generated from the register

**Files:**
- Modify: `src/register.mjs` (add `renderRegisterMarkdown`)
- Modify: `src/build.mjs` (wire register discovery + document generation into `assembleSite`/the build loop)
- Test: `tests/register.test.mjs`, `tests/build.test.mjs`

**Interfaces:**
- Consumes: `validateRegister` (Task 1).
- Produces: `renderRegisterMarkdown(register) → string` — a markdown document in the corpus's own
  existing shape (verified against real Menus questions, `docs/features/menus/open-questions.md`,
  lines 1-60: `## Q<n> · <severity>` headings, a bold `*Recommended:*` line, a bold `*Answer:*`
  line, a `<sub>` citations line).
- Consumes (in `build.mjs`): `renderMarkdown` from `src/markdown.mjs`, unchanged — the generated
  markdown string is handed to the exact same renderer every other document already uses.

- [ ] **Step 1: write the failing test**

```js
test('register: renderRegisterMarkdown reproduces the corpus\'s own heading and answer shape', () => {
  const md = renderRegisterMarkdown(register({
    questions: [question({
      id: 'Q1',
      chosen: { kind: 'offered', value: 'Option A' },
      citations: ['decisions.md 10', 'README.md'],
    })],
  }));
  assert.match(md, /^## Q1 · BLOCKING$/m);
  assert.match(md, /\*\*Recommended:\*\* Option A/);
  assert.match(md, /\*\*Answer:\*\* Option A/);
  assert.match(md, /<sub>decisions\.md 10; README\.md<\/sub>/);
});

test('register: a written-in answer is marked as such in the document', () => {
  const md = renderRegisterMarkdown(register({
    questions: [question({ chosen: { kind: 'written-in', value: 'A different plan entirely.' } })],
  }));
  assert.match(md, /\*\*Answer:\*\* A different plan entirely\. \(written in\)/);
});

test('register: a deferred question says so, with no answer line', () => {
  const md = renderRegisterMarkdown(register({
    questions: [question({ chosen: { kind: 'deferred', value: null } })],
  }));
  assert.match(md, /\*\*Status:\*\* deferred/);
  assert.doesNotMatch(md, /\*\*Answer:\*\*/);
});

test('register: a hand edit to the generated document is lost on the next build', async () => {
  // build.test.mjs — full test, see Step 1 continuation below.
});
```

- [ ] **Step 2: run, watch it fail.**

- [ ] **Step 3: implement `renderRegisterMarkdown`** (append to `src/register.mjs`)

```js
function renderQuestion(q) {
  const lines = [`## ${q.id} · ${q.severity}`, '', q.question, '', q.why, '', `**Recommended:** ${q.recommended}`];
  if (q.chosen.kind === 'deferred') {
    lines.push('', '**Status:** deferred');
  } else {
    const suffix = q.chosen.kind === 'written-in' ? ' (written in)' : '';
    lines.push('', `**Answer:** ${q.chosen.value}${suffix}`);
  }
  if (q.citations.length > 0) {
    lines.push('', `<sub>${q.citations.join('; ')}</sub>`);
  }
  return lines.join('\n');
}

/**
 * The readable register, generated from its data (decision 3 applied to a register: this
 * document is build output, never a file anybody edits — a hand edit to it is overwritten by the
 * next build, which is the point rather than a side effect).
 *
 * @param {object} register - a `validateRegister`-passed value.
 * @returns {string} markdown, in the same shape the corpus's own hand-written registers use.
 */
export function renderRegisterMarkdown(register) {
  const lines = [`# ${register.title}`, ''];
  for (const q of register.questions) {
    lines.push(renderQuestion(q), '');
  }
  return lines.join('\n').trimEnd() + '\n';
}
```

- [ ] **Step 4: wire into `src/build.mjs`.** Read the current `collectDocuments`/document-writing
  loop in `src/build.mjs` before editing (it already writes every `.md` under `docs/` as a
  rendered page — follow that exact pattern rather than inventing a second document pipeline).
  Add, alongside the existing manifest-loading step in `assembleSite`:

```js
// Registers: docs/features/<slug>/register.json, optional. Present ones generate their own
// markdown document as build output — decision 3 applied to a register (M5) — and get folded into
// the same `documents` collection every other rendered .md file goes through, so a register's
// page is indistinguishable in the pipeline from any other document.
function loadRegister(projectRoot, slug) {
  const registerPath = path.join(projectRoot, 'docs', 'features', slug, 'register.json');
  if (!existsSync(registerPath)) return null;
  const raw = JSON.parse(readFileSync(registerPath, 'utf8'));
  const result = validateRegister(raw);
  if (!result.ok) {
    throw new Error(
      `atlas: ${relPath(projectRoot, registerPath)} is not a valid register:\n` +
        result.errors.map((e) => `  ${e.path || '(root)'}: ${e.message}`).join('\n'),
    );
  }
  return result.value;
}
```

Call `loadRegister` per workstream slug inside `assembleSite`'s existing per-workstream loop; for
each non-null result, generate `renderRegisterMarkdown(register)` and feed it into the same
document-collection step the real `.md` files already go through (find the exact function — likely
`collectDocuments` or an adjacent helper — and extend it rather than duplicating its URL/permalink
logic; a generated register document needs a `url` the same way a real file does, or nothing can
link to it).

- [ ] **Step 5: the "hand edit is lost" test**, in `tests/build.test.mjs`, following that file's
  existing pattern of building into a temp directory and asserting on the output:

```js
test('register: a hand-written register.json produces a generated document, and a stray hand-edited copy of the output is overwritten by the next build', async () => {
  const project = makeTempProject({
    'docs/features/lighthouse/register.json': JSON.stringify({
      slug: 'lighthouse',
      title: 'Lighthouse Register',
      questions: [{
        id: 'Q1', question: 'Real question?', why: 'Real why.',
        options: ['A', 'B'], recommended: 'A', severity: 'BLOCKING',
        chosen: { kind: 'offered', value: 'A' }, citations: [],
      }],
    }),
  });
  const out1 = await buildProject(project);
  const generatedPath = findGeneratedRegisterOutput(out1, 'lighthouse');
  assert.ok(existsSync(generatedPath));
  const original = readFileSync(generatedPath, 'utf8');

  // Simulate a hand edit directly on the build OUTPUT, not the source register.json.
  writeFileSync(generatedPath, 'HAND EDITED, SHOULD NOT SURVIVE');
  const out2 = await buildProject(project);
  const rebuilt = readFileSync(findGeneratedRegisterOutput(out2, 'lighthouse'), 'utf8');
  assert.equal(rebuilt, original);
  assert.notMatch(rebuilt, /HAND EDITED/);
});
```

(`makeTempProject`/`buildProject`/`findGeneratedRegisterOutput` — use whatever this file's existing
temp-project test helpers are actually called; read `tests/build.test.mjs`'s current top for the
real helper names before writing this test, they are not invented here.)

- [ ] **Step 6: run, watch it pass; commit.**

---

## Task 3: write-in answers are surfaced, not buried

**Files:**
- Modify: `theme/_includes/register.njk` (new file, register's own rendered page — Task 2's
  generated markdown renders through the existing document template; this task adds a SEPARATE,
  purpose-built page for the register, not just markdown-as-a-document, since "surfaced as a
  group" needs real layout, not a heading grep)
- Test: `tests/theme.test.mjs`

**Interfaces:**
- Consumes: the same `register` object Task 2 renders from build data.

*Shape: Claude.* What "surfaced" looks like is a design judgement — build the register's own page
(not the plain generated-markdown document) with a "Written in" section listing every question
whose `chosen.kind === 'written-in'`, above the full question list, each entry linking down to its
full question via an anchor (`#q1` etc., matching `headingAnchors`'s existing convention in
`src/markdown.mjs`).

- [ ] **Step 1: write the failing test** — assert the register page's rendered HTML contains a
  `<section class="written-in-answers">` (or similar; name it consistently with this theme's
  existing class conventions — `feature-list`, `milestone-spine` etc. are the pattern to match)
  listing exactly the write-in questions, in register order, each an `<a href="#q1">` linking to
  its full entry further down the same page.
- [ ] **Step 2: run, watch it fail.**
- [ ] **Step 3: implement** `theme/_includes/register.njk`, following `theme/_includes/depth.njk`'s
  existing header-comment convention (data contract documented at the top) and reusing
  `theme/tokens.css`'s existing tokens — no new colors invented.
- [ ] **Step 4: run, watch it pass; commit.**

---

## Task 4: an index of registers, built from the files

**Files:**
- Create: `theme/_includes/registers-index.njk`
- Modify: `src/build.mjs` (assemble the index from discovered registers)
- Test: `tests/build.test.mjs`, `tests/theme.test.mjs`

**Interfaces:**
- Consumes: every `loadRegister` result from Task 2's build wiring, PLUS (per Task 6's deferral)
  a list of workstreams whose register is still legacy prose (`open-questions.md` present,
  `register.json` absent) — the index renders BOTH kinds, structured ones with their real open
  count, legacy ones as a plain link with no count (Task 6's stated cost: "an index that has to
  render both").

- [ ] **Step 1: write the failing test** — an index page test asserting: a workstream with a
  structured register shows its open-question count, ordered before one with fewer open
  questions; a workstream with only legacy prose (Menus, post this milestone) shows a plain link
  and no count; a workstream with neither is absent entirely.
- [ ] **Step 2: run, watch it fail.**
- [ ] **Step 3: implement.** Build the index list in `src/build.mjs` from the discovered set
  directly (no hand-maintained list of registers anywhere) — sort structured registers by open
  count (`chosen.kind === 'deferred'`) descending, legacy-prose entries after, alphabetically.
- [ ] **Step 4: run, watch it pass; commit.**

---

## Task 5: `POST /api/answer` writes the record, not the document

**Files:**
- Modify: `api/lib/records.mjs` (add `answerRegisterQuestion`, keep `answerQuestion`)
- Modify: `api/lib/payload.mjs` (`validateAnswerPayload` accepts both payload shapes)
- Modify: `api/lib/handlers.mjs` (`handleAnswer` branches on which register shape the workstream has)
- Test: `tests/writeback-records.test.mjs`, `tests/writeback-place-api.test.mjs` (or wherever
  payload tests actually live — confirmed via `grep -rl validateAnswerPayload tests/` before
  editing), `tests/writeback-handlers.test.mjs`

**Interfaces:**
- Consumes: `validateRegister` (Task 1), the existing `client.read`/`client.write` contract
  `handlers.mjs` already uses (unchanged — Global Constraint above).
- Produces: `answerRegisterQuestion(currentJsonText, { questionId, chosen, chosenWasOffered, author }) → string`
  (new JSON text) — mirrors `appendDeploymentTransition`'s shape (parse, mutate, re-stringify) more
  than `answerQuestion`'s (line-range prose surgery), since the target is now JSON not markdown.

- [ ] **Step 1: write the failing tests** (in `records.mjs`'s own test file)

```js
test('records: answerRegisterQuestion sets chosen on the named question, offered case', () => {
  const before = JSON.stringify({
    slug: 'lighthouse', title: 'T',
    questions: [{ id: 'Q1', question: 'Q?', why: 'W', options: ['A', 'B'], recommended: 'A', severity: 'BLOCKING', chosen: { kind: 'deferred', value: null }, citations: [] }],
  });
  const after = JSON.parse(answerRegisterQuestion(before, { questionId: 'Q1', chosen: 'A', chosenWasOffered: true, author: 'jeremy' }));
  assert.deepEqual(after.questions[0].chosen, { kind: 'offered', value: 'A' });
});

test('records: answerRegisterQuestion marks a written-in answer distinctly', () => {
  // ...same shape, chosenWasOffered: false, chosen: 'Something else', asserts kind === 'written-in'
});

test('records: answerRegisterQuestion refuses an unknown question id', () => {
  // asserts it throws RecordError with code 'no-such-question', matching answerQuestion's existing error code
});

test('records: answerRegisterQuestion refuses an offered answer that names no real option', () => {
  // chosenWasOffered: true, chosen: 'Option Z' — RecordError, 'invalid-payload'
});

test('records: answering twice replaces, does not append', () => {
  // answer Q1 twice with different values; result has exactly one chosen block for Q1, the second value
});
```

- [ ] **Step 2: run, watch fail.**

- [ ] **Step 3: implement `answerRegisterQuestion`** in `api/lib/records.mjs`, beside the existing
  functions:

```js
/**
 * Set a register question's `chosen`, in the structured record (M5). Sibling to `answerQuestion`
 * above, which stays for any register still `open-questions.md` prose — this is the JSON-record
 * counterpart, not a replacement.
 *
 * @param {string} currentJsonText - the register's current JSON text, as read from the repo.
 * @param {{ questionId: string, chosen: string, chosenWasOffered: boolean, author: string }} args
 * @returns {string} the new JSON text.
 * @throws {RecordError} 'no-such-question' | 'invalid-payload'
 */
export function answerRegisterQuestion(currentJsonText, { questionId, chosen, chosenWasOffered }) {
  let parsed;
  try {
    parsed = JSON.parse(currentJsonText);
  } catch (error) {
    throw new RecordError(`the register is not valid JSON (${error.message})`, 'invalid-payload');
  }

  const question = (parsed.questions ?? []).find(
    (q) => typeof q?.id === 'string' && q.id.toLowerCase() === questionId.toLowerCase(),
  );
  if (!question) {
    throw new RecordError(`no question ${JSON.stringify(questionId)} in this register`, 'no-such-question');
  }

  if (chosenWasOffered && !(question.options ?? []).includes(chosen)) {
    throw new RecordError(
      `${JSON.stringify(chosen)} names no option this question actually offers`,
      'invalid-payload',
    );
  }

  question.chosen = { kind: chosenWasOffered ? 'offered' : 'written-in', value: chosen };
  return JSON.stringify(parsed, null, 2) + '\n';
}
```

- [ ] **Step 4: run, watch pass.**

- [ ] **Step 5: extend `validateAnswerPayload`** (`api/lib/payload.mjs`) to accept the new fields.
  Read the function's current full body before editing — the new shape adds `chosenWasOffered:
  boolean` and repurposes `answer` as the chosen text for BOTH the prose and structured path (no
  new field name needed there); `question` stays the id field name for both, unchanged.

```js
// Extend the existing ANSWER_FIELDS allow-list and validation body — do not replace it. The
// prose-register path (existing) and the structured-register path (new) share this one payload
// validator; `handlers.mjs` decides which record-writing function to call based on which register
// shape the workstream actually has, not based on anything in the payload itself — the caller
// does not get to declare which kind of register it thinks it is answering.
if (value.chosenWasOffered !== undefined && typeof value.chosenWasOffered !== 'boolean') {
  return fail(`"chosenWasOffered" must be a boolean when present (got ${JSON.stringify(value.chosenWasOffered)}).`);
}
```

- [ ] **Step 6: branch `handleAnswer`** (`api/lib/handlers.mjs`). Read the workstream's manifest
  (`workstreamPath(payload.workstream, 'workstream.json')`, `client.read`) to determine whether
  `docs/features/<slug>/register.json` exists (a second `client.read`, tolerating 404 as "prose
  path") — or, simpler and avoiding a second read: add a manifest field (e.g.
  `registerPath: string | null`, decision-14-style, same pattern `acceptance.record` already is)
  that names which register file this workstream answers into, and let its presence/absence
  decide the branch. Prefer the manifest-field approach — it is one read, matches this codebase's
  existing "the manifest is the map" convention (`acceptance.record`, `deploymentLog` both already
  work this way), and does not require probing for a file's existence mid-request. Add
  `registerPath` to `src/schema.mjs`'s `validateWorkstream` as an optional nullable string, same
  pattern as `deploymentLog`.

```js
// api/lib/handlers.mjs, inside handleAnswer, after reading the manifest:
const registerPath = parsedManifest?.registerPath ?? null;
if (registerPath) {
  const current = await client.read(registerPath, credential.branch);
  const stale = staleAgainstCaller(registerPath, payload.sha, current.sha);
  if (stale) return stale;
  const text = answerRegisterQuestion(current.text, {
    questionId: payload.question,
    chosen: payload.answer,
    chosenWasOffered: payload.chosenWasOffered ?? false,
    author: principal.author,
  });
  // ...client.write, same shape as the existing prose path, path: registerPath
} else {
  // existing prose path, unchanged
}
```

- [ ] **Step 7: full suite, run, watch pass; commit.**

---

## Task 6: the existing Menus register — deferred, decision recorded

**Files:**
- None changed in either repo. This task IS the decision, not a migration.

The spec's own "Finished when" for this task offers two valid outcomes: convert with nothing
lost, or record the decision to leave it as prose with the cost named. This plan takes the second.

**Why, concretely, having now read the real corpus** (`docs/features/menus/open-questions.md`,
Vennusign repo): 2,581 lines, 209 questions across four sittings, with severities, deferrals,
provisional-default flags, at least one `Moot` answer (Q3) that fits none of Task 1's three
`chosen.kind` values cleanly, and citation lists with 1-6 entries each in varying formats. A
lossless automated migration attempted without the owner reviewing every one of 209 round-tripped
entries is exactly the "wrong answer, expensive in both directions" the spec itself warned about —
guessing at which of `offered`/`written-in`/`deferred` an entry like Q3's "Moot" answer maps to is
an editorial judgment on 209 historical records, not a mechanical transform.

**What this costs, named explicitly (per the spec's own requirement):** two shapes of register
coexist in the repository — Menus stays hand-edited prose, any future register (and any register
that opts in later) is structured. Task 4's index already renders both. `POST /api/answer` against
Menus' workstream continues to use the existing `answerQuestion` prose-editing path unchanged
(Task 5's branch falls through to it, since Menus' manifest gets no `registerPath` field in this
milestone).

**Finished when:** this section exists, is read, and the owner has not asked for the migration to
be attempted instead. If a future milestone migrates Menus specifically, it is its own scoped
piece of work — a 209-question, citation-preserving, human-reviewed migration is not something to
fold into a task list item, per the spec's own "Shape: Claude... a judgement about a real corpus."

---

## Task 7: full-suite verification and fixture build

**Files:** none new.

- [ ] Add a fixture register under `fixture/docs/features/<some-existing-slug>/register.json` (a
  small, invented one — 3-4 questions, at least one of each `chosen.kind`) so the fixture site
  exercises the whole pipeline (build.mjs's --offline path already runs without a register present
  today; this proves it also runs correctly WITH one).
- [ ] `npm test` — full suite, watch it pass.
- [ ] `node src/build.mjs fixture .atlas-out --offline --quiet` — confirm it builds, and that the
  fixture's new register produces a real page (grep the output for the register's title).
- [ ] Commit.

---

## Self-review

**Spec coverage.** Tasks 1-5 map 1:1 to the spec's own numbered tasks 1-5. Task 6 maps to the
spec's own explicitly-sanctioned "or the decision to leave historical registers as prose is
recorded" branch — read the real 209-question corpus before choosing this branch rather than
assuming it, per the spec's own instruction that this is "a judgement about a real corpus." Task 7
is new (verification), matching every other Atlas milestone's own final task.

**Placeholder scan.** No task says "add appropriate validation" or leaves a code block as
description-only. Task 3's `theme/_includes/register.njk` is the one place shape is left to the
implementer ("Shape: Claude" in the spec itself) — that is a disclosed design decision, not a
placeholder, same distinction M7's plan drew for its own Claude-shaped task.

**Type/signature consistency.** `validateRegister`'s `chosen: {kind, value}` shape is used
identically in Task 2's `renderRegisterMarkdown`, Task 5's `answerRegisterQuestion`, and every
test across both. `registerPath` on the manifest follows `deploymentLog`'s exact optional-nullable
pattern in `src/schema.mjs`, cited by path rather than restated from memory (both read directly in
Task 1/5's write-up above).

**Cross-repository note.** Every task in this plan operates in the Atlas repository only. Task 6
deliberately touches nothing in the Vennusign repository — that is the task's whole point, not an
oversight to flag.
