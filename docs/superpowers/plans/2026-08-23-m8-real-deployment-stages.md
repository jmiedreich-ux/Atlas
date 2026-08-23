# M8: Real Deployment Stages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `WORKSTREAM_STAGES`' single `'shipping'` catch-all with real deployment stages
(`development`/`staging`/`release`, staging optional), record transitions through them as an
ordered (dateless) append-only log via a new write-back endpoint that never touches
`workstream.json`, and render that log on the accordion.

**Architecture:** Three pure additions (`api/lib/contract.mjs`'s vocabulary, a new
`validateDeploymentTransitionPayload` in `api/lib/payload.mjs`, a new `appendDeploymentTransition`
in `api/lib/records.mjs`) feed a new write-back handler (`api/lib/handlers.mjs`) wired through a
new Function (`api/deployment-transition/`). `src/build.mjs` reads each workstream's optional
`deploymentLog` file and computes its *displayed* stage (log's latest entry, else the manifest's
own `stage`) into the assembled model. Two templates render it: `theme/_includes/depth.njk` (the
history row + the trigger buttons) and `theme/_includes/base.njk` (three new chip labels). A small
new client script (or an addition to `theme/order.js`) POSTs a transition request.

**Tech Stack:** Node.js (`node --test`), the same GitHub App write-back already uses
(`api/lib/github.mjs`, `api/lib/app-token.mjs`), no new runtime dependency (decision 9).

**Spec:** `docs/superpowers/specs/2026-08-23-m8-real-deployment-stages-design.md`

## Global Constraints

* **Decision 35 is amended by this plan, on the record.** `api/lib/handlers.mjs`'s own header
  states a test asserts the module exports exactly two write handlers. Task 1 updates that test's
  assertion (two → three) in the same commit that adds the third handler — never leave it failing
  for a later task to discover.
* **The new handler never writes `workstream.json`.** It resolves `manifest.deploymentLog` (a
  repository-relative path, validated with the existing `whyNotAWritableRecord` from
  `api/lib/contract.mjs`) and writes only to the file that path names, exactly as `handleAcceptance`
  (`api/lib/handlers.mjs:206`) resolves and writes only to `milestone.acceptance.record`.
* **No dates on a transition entry.** A log entry is `{ stage, note }` — nothing else. This is
  checked by name in every task that touches the entry shape.
* **`development`/`staging`/`release` are the only valid values a transition entry's `stage` may
  hold** — not the pre-development three (`not-started`/`designing`/`planned`), which describe a
  workstream before any deployment activity exists to log.
* **This plan does not call, name, or design a deployment agent.** No task here triggers GitHub
  Actions or any other real deployment. Where a task's UI or API response needs to say something
  happens next, the wording is "recorded" — never "deployed," "triggered a release," or similar.
* Every new/changed test follows this repository's existing `node --test` / `node:assert/strict`
  style — flat `test(name, async () => {...})`, no `describe` blocks (see
  `tests/writeback-handlers.test.mjs` for the pattern write-back tests already follow).
* `WRITE_ROLE` (`'author'`, `api/lib/contract.mjs`) is the gate for the new endpoint — the same
  gate every other write-back action uses. No task introduces a new role.

---

## File structure

**Created:**
* `api/deployment-transition/index.mjs`, `api/deployment-transition/function.json` — the Function,
  mirroring `api/acceptance/`.
* `tests/deployment-log.test.mjs` — unit tests for the new pure record functions.

**Modified:**
* `api/lib/contract.mjs` — `WORKSTREAM_STAGES` vocabulary; new `DEPLOYMENT_STAGES` (the
  three-value subset valid on a log entry).
* `api/lib/payload.mjs` — `validateDeploymentTransitionPayload`.
* `api/lib/records.mjs` — `appendDeploymentTransition`.
* `api/lib/handlers.mjs` — `handleDeploymentTransition`; the "exactly two handlers" test's
  assertion becomes three.
* `src/schema.mjs` — `deploymentLog` as an optional, nullable-string manifest field.
* `src/build.mjs` — read each workstream's deployment log (tolerant of a missing/absent file,
  same posture as the GitHub issues fetch — decision 32's stated exception); compute the
  displayed stage.
* `theme/_includes/base.njk` — `chipLabel` gains `development`/`staging`/`release`, loses
  `shipping`.
* `theme/_includes/depth.njk` — the `.stage-history` row and the three trigger buttons on an
  expanded row.
* `theme/tokens.css` — `.stage-history`, `.stage-node`, trigger-button styling.
* `theme/order.js` (or a new small `theme/deploy.js`, decided in Task 7) — the client POST.
* `tests/writeback-handlers.test.mjs`, `tests/writeback-contract.test.mjs`,
  `tests/writeback-credentials.test.mjs` (wherever the "exactly two" assertion actually lives —
  Task 1 locates it precisely) — updated coverage.
* `tests/theme.test.mjs` — accordion rendering coverage for the history row and buttons.
* **Vennusign repo** (`/mnt/c/development/vennusign/.claude/worktrees/keystone-decisions`):
  `docs/features/atlas/workstream.json` and `docs/features/menus/workstream.json` — `"shipping"`
  → a real value. This is a separate repository from Atlas; Task 9 below is explicitly scoped to
  it and is its own commit in its own repo, not part of the Atlas PR.

---

## Task 1: Locate and update the "exactly two handlers" guard

**Files:**
- Modify: whichever test file asserts `Object.keys(handlers).length === 2` or equivalent — run
  `grep -rn "exactly two\|handlers).length" tests/` from the Atlas repo root to find it before
  writing anything; do not guess the file.

**Interfaces:**
- Produces: confirmation (in the task's own commit message) of the exact file and line the
  assertion lived at, so Task 5's reviewer can verify it was updated rather than duplicated.

- [ ] **Step 1:** Run `grep -rn "exactly two\|handlers)\.length\|Object.keys(handlers)" tests/*.mjs`
  from the Atlas repo root and read the matching test in full.
- [ ] **Step 2:** Update its assertion from two to three, with a one-line comment above it citing
  this plan: `// Amended for M8: a third write handler, deployment transitions — decision 35 now
  names three writable things, not two.`
- [ ] **Step 3:** Run the test file alone (`node --test tests/<file>.mjs`) and confirm it still
  fails (there is no third handler yet) with a message naming the count mismatch, not an unrelated
  error.
- [ ] **Step 4:** Commit: `git add tests/<file>.mjs && git commit -m "test: expect three write handlers, not two (M8)"`.

## Task 2: The vocabulary

**Files:**
- Modify: `api/lib/contract.mjs`
- Test: `tests/schema.test.mjs` (or wherever `WORKSTREAM_STAGES` is currently asserted — grep
  first)

**Interfaces:**
- Produces: `WORKSTREAM_STAGES = Object.freeze(['not-started', 'designing', 'planned',
  'development', 'staging', 'release'])`; a new `DEPLOYMENT_STAGES = Object.freeze(['development',
  'staging', 'release'])`, re-exported from `src/schema.mjs` the same way `WORKSTREAM_STAGES`
  already is.

- [ ] **Step 1:** Write a failing test asserting `WORKSTREAM_STAGES` equals the new six-value
  array in order, and `DEPLOYMENT_STAGES` equals the three-value subset.

```js
test('WORKSTREAM_STAGES replaces shipping with real deployment stages', () => {
  assert.deepEqual(WORKSTREAM_STAGES, [
    'not-started', 'designing', 'planned', 'development', 'staging', 'release',
  ]);
  assert.deepEqual(DEPLOYMENT_STAGES, ['development', 'staging', 'release']);
});
```

- [ ] **Step 2:** Run it, confirm it fails against the current `['not-started', 'designing',
  'planned', 'shipping']`.
- [ ] **Step 3:** In `api/lib/contract.mjs`, replace the `WORKSTREAM_STAGES` line and add
  `DEPLOYMENT_STAGES` directly beneath it, with a comment explaining the subset relationship (the
  three values a *transition* may hold are a subset of the six a *workstream* may be in).
- [ ] **Step 4:** Add both to `src/schema.mjs`'s re-export list (the `export { ... } from
  '../api/lib/contract.mjs'` block).
- [ ] **Step 5:** Run the test, confirm it passes. Run the full suite once (`npm test`) — this
  will surface every place the old `'shipping'` string appeared in a fixture or test; **do not fix
  those yet**, just note the file list in the task's commit message for Task 8 (the theme/base.njk
  chip labels) and Task 9 (the two real manifests) to pick up. Some of this task's own fixtures
  may need a one-line value swap if they hard-code `'shipping'` — fix only fixtures inside this
  task's own files, leave template/manifest fixtures to their owning tasks.
- [ ] **Step 6:** Commit.

## Task 3: `validateDeploymentTransitionPayload`

**Files:**
- Modify: `api/lib/payload.mjs`
- Test: `tests/writeback-contract.test.mjs` (where `validateAcceptancePayload`'s own tests live —
  grep to confirm, follow that file's exact pattern)

**Interfaces:**
- Consumes: `DEPLOYMENT_STAGES`, `checkShape`, `checkWorkstream`, `whyNotWritableText`, `fail` (all
  already defined in `api/lib/payload.mjs`, used identically by `validateAcceptancePayload` at
  line 140).
- Produces: `validateDeploymentTransitionPayload(body) -> { ok: true, value } | { ok: false,
  response }`, fields `['workstream', 'stage', 'note', 'sha']` (no `milestone` — a transition is
  feature-level, not milestone-level, which is the whole reason `MILESTONE_ID` validation from
  `validateAcceptancePayload` does NOT appear here).

- [ ] **Step 1:** Write a failing test table covering: a valid payload with no note; a valid
  payload with a note; a missing `workstream`; a `stage` not in `DEPLOYMENT_STAGES` (e.g.
  `'shipping'` itself, or `'designing'` — both must be refused by name, the second specifically
  because it's a real `WORKSTREAM_STAGES` value that is NOT a valid transition target); an
  unwritable `note` (reuse `whyNotWritableText`'s own refused-input fixture from the acceptance
  payload's tests); a missing `sha`.

```js
test('a stage transition to a pre-development value is refused by name', () => {
  const result = validateDeploymentTransitionPayload({
    workstream: 'atlas', stage: 'designing', sha: 'abc',
  });
  assert.equal(result.ok, false);
  assert.match(result.response.body.message, /must be one of: development, staging, release/);
});
```

- [ ] **Step 2:** Run, confirm failure (function doesn't exist yet).
- [ ] **Step 3:** Implement, modeled line-for-line on `validateAcceptancePayload`
  (`api/lib/payload.mjs:140`) — same `checkShape`/`checkWorkstream` opening, same `note` handling
  (copy the `whyNotWritableText` block verbatim), swap the `result`/`ACCEPTANCE_RESULTS` check for
  a `stage`/`DEPLOYMENT_STAGES` check with the refusal message naming what a transition is not
  ("a transition's stage is one of: development, staging, release. `<value>` is a real workstream
  stage but not something a transition can record.").
- [ ] **Step 4:** Run, confirm pass. Commit.

## Task 4: `appendDeploymentTransition`

**Files:**
- Modify: `api/lib/records.mjs`
- Test: `tests/deployment-log.test.mjs` (new)

**Interfaces:**
- Consumes: nothing from elsewhere in `api/lib/` — this is a pure JSON-array function, unlike
  `recordAcceptance`'s Markdown-marker editing (`decompose`/`placeBlock`/`recompose`), which does
  NOT apply here: a deployment log is a JSON array, not a marked-up Markdown record, and this task
  must not force-fit the marker pattern onto it.
- Produces: `appendDeploymentTransition(text, { stage, note }) -> string` — `text` is the current
  file content (or `''`/`'[]'` for a log that doesn't exist yet — the handler in Task 5 creates it
  on first write), returns the new JSON text with one more entry appended, pretty-printed with
  2-space indent (matching every other JSON file this generator writes).

- [ ] **Step 1:** Write a failing test: appending to `'[]'` produces one entry; appending to an
  existing two-entry array produces three, preserving the first two unchanged; a `note` of
  `undefined`/`null`/empty string produces an entry with no `note` key at all (not `"note": null`
  — matches this repository's existing convention of omitting rather than nulling absent optional
  fields, confirm against `milestone.acceptance` in a real fixture manifest before assuming this).

```js
test('appendDeploymentTransition adds one entry and keeps the rest', () => {
  const before = JSON.stringify([{ stage: 'development' }], null, 2);
  const after = appendDeploymentTransition(before, { stage: 'staging', note: 'smoke-tested' });
  assert.deepEqual(JSON.parse(after), [
    { stage: 'development' },
    { stage: 'staging', note: 'smoke-tested' },
  ]);
});
```

- [ ] **Step 2:** Run, confirm failure.
- [ ] **Step 3:** Implement in `api/lib/records.mjs`, beside `recordAcceptance` — parse, push,
  `JSON.stringify(arr, null, 2) + '\n'` (trailing newline, matching this repo's other generated
  JSON).
- [ ] **Step 4:** Run, confirm pass. Commit.

## Task 5: `handleDeploymentTransition` and the Function

**Files:**
- Modify: `api/lib/handlers.mjs`
- Create: `api/deployment-transition/index.mjs`, `api/deployment-transition/function.json` (copy
  `api/acceptance/function.json` verbatim except the route)
- Test: `tests/writeback-handlers.test.mjs`

**Interfaces:**
- Consumes: `validateDeploymentTransitionPayload` (Task 3), `appendDeploymentTransition` (Task 4),
  `whyNotAWritableRecord` (`api/lib/contract.mjs`, already used by `handleAcceptance`),
  `staleAgainstCaller` (already in `handlers.mjs`), the same `prepare()` helper every handler
  shares (`handlers.mjs`, the block documented at "Steps 1 to 3, which every write shares").
- Produces: `handleDeploymentTransition(request, deps)`, same five-step shape as
  `handleAcceptance` (`handlers.mjs:206`): authorise → read credential → validate payload → read
  manifest, resolve `manifest.deploymentLog`, refuse `409 no-deployment-log` if absent (mirroring
  the `409 no-acceptance-record` refusal at line ~244) → read that record and its SHA, refuse if
  stale → write with `appendDeploymentTransition`.

- [ ] **Step 1:** Write a failing integration test (mock GitHub client, same fixture pattern
  `handleAcceptance`'s own tests use) covering: success appends and commits; missing
  `deploymentLog` refuses 409; stale `sha` refuses 409; a stage the workstream's own manifest
  doesn't declare is irrelevant here (deployment stages aren't per-milestone, so there's no
  "no such milestone" analogue — only "no such workstream," already covered by `checkWorkstream`
  in Task 3).
- [ ] **Step 2:** Run, confirm failure.
- [ ] **Step 3:** Implement `handleDeploymentTransition`, copying `handleAcceptance`'s structure
  exactly (read manifest → resolve pointer field → validate the pointer with
  `whyNotAWritableRecord` → read/write with SHA check) with `deploymentLog` in place of
  `acceptance.record` and no milestone lookup.
- [ ] **Step 4:** Create the Function files. `function.json` route: `deployment-transition`
  (mirrors `acceptance`'s own naming).
- [ ] **Step 5:** Update Task 1's "exactly two/three handlers" test file to actually import and
  count `handleDeploymentTransition` alongside the other two (if Task 1 only bumped the number,
  this step is what makes the count real rather than hardcoded).
- [ ] **Step 6:** Run the full `tests/writeback-*.test.mjs` suite, confirm all green. Commit.

## Task 6: Wire into `assembleSite` — the displayed stage

**Files:**
- Modify: `src/schema.mjs` (add `deploymentLog` as an optional nullable-string field to
  `validateWorkstream`, same shape as `milestone.acceptance.record`'s own nullable-string rule),
  `src/build.mjs`
- Test: `tests/schema.test.mjs`, `tests/build.test.mjs`

**Interfaces:**
- Consumes: nothing new at the schema layer beyond string validation.
- Produces: on each assembled workstream, `displayedStage: string` — the log's latest entry's
  `stage` if `deploymentLog` is set and the file exists and is non-empty, else the manifest's own
  `stage`. Every template that currently reads `stream.manifest.stage` for the chip switches to
  `stream.displayedStage` (this task updates the field name everywhere it's read — grep
  `manifest.stage` across `theme/` before finishing).

- [ ] **Step 1:** Write a failing schema test: a manifest with `deploymentLog: "docs/features/x/deployment-log.json"` validates; one with `deploymentLog: ""` (empty string) is refused, matching
  `isNullableString`'s existing rule (null or non-empty, never empty-string) already used for
  `acceptance.record`.
- [ ] **Step 2:** Add the field in `validateMilestone`... **no** — `deploymentLog` is a
  **workstream**-level field, not a milestone field (a workstream has one deployment history, not
  one per milestone). Add it inside `validateWorkstream` (`src/schema.mjs`, beside `requireString(obj, 'gate', ...)`), as `isNullableString` — not required, since a workstream that has never
  reached development has nothing to log.
- [ ] **Step 3:** Run, confirm pass.
- [ ] **Step 4:** Write a failing `build.test.mjs` case: two workstreams, one with no
  `deploymentLog` (its `displayedStage` equals its manifest `stage`), one with a `deploymentLog`
  pointing at a fixture file containing two entries (its `displayedStage` equals the *last* entry's
  `stage`, not the manifest's own `stage`, which the fixture should deliberately set to something
  different to prove the override is real).
- [ ] **Step 5:** In `src/build.mjs`'s `assembleSite`, after the existing per-workstream mapping
  (near where `issues`/`triage` are attached — read the file first, this plan does not know the
  exact line without a fresh read at implementation time), read each workstream's
  `manifest.deploymentLog` file if present (tolerant of a missing file — log a warning and fall
  back to the manifest's `stage`, the same posture `fetchProjectIssues` already has for GitHub
  being unreachable; this is a LOCAL file read, not a network call, so "missing" means "not created
  yet," a normal state, not a failure — a missing file is silent, not warned). Parse the JSON array,
  take the last entry's `stage` if the array is non-empty, else fall back.
- [ ] **Step 6:** Update every template read of `stream.manifest.stage` for chip rendering
  (grep `manifest.stage` in `theme/`) to `stream.displayedStage`. Leave any read of
  `manifest.stage` that is NOT about the displayed chip untouched (there may be none, but check).
- [ ] **Step 7:** Run the full suite, confirm pass. Commit.

## Task 7: The on-screen trigger and the history row

**Files:**
- Modify: `theme/_includes/depth.njk`, `theme/tokens.css`, `theme/_includes/base.njk`
- Create or modify: a client script for the POST — decide between adding to `theme/order.js` or a
  new `theme/deploy.js`; given `order.js` is already 500+ lines covering unrelated drag/reorder
  concerns, a new small file is cleaner — name it `theme/deploy.js`, loaded via a new `{% block
  bodyScripts %}` addition in `depth.njk` only (not site-wide).
- Test: `tests/theme.test.mjs`

**Interfaces:**
- Consumes: `stream.displayedStage`, `stream.deploymentHistory` (Task 6's array, or a
  build-time-empty array — this task's template code needs this field named; if Task 6 didn't
  expose the raw entry list separately from `displayedStage`, add it there, not here — flag this
  as a dependency to verify before starting this task).
- Produces: markup and script, no new pure logic.

- [ ] **Step 1:** In `base.njk`'s `chipLabel` macro, add `"development": "Development"`,
  `"staging": "Staging"`, `"release": "Release"`; remove `"shipping": "Shipping"`.
- [ ] **Step 2:** In `depth.njk`'s expanded-row block (beside `.milestone-spine`, not inside it —
  per the spec), add `.stage-history`: one `.stage-node` per `deploymentHistory` entry in order,
  each showing `chipLabel(entry.stage)` and, if present, `entry.note`. If the array is empty, show
  one node for the workstream's own current `displayedStage` (pre-deployment case) so the row is
  never blank.
- [ ] **Step 3:** Add three buttons (Development / Staging / Release), each `data-transition-to="development|staging|release"`, `data-slug="{{ stream.slug }}"`, visible only when the site is
  built with write-back configured (mirror however the existing modal/write-UI, if any, already
  gates on write-back availability — grep for an existing "write-back configured" template
  conditional before inventing a new one).
- [ ] **Step 4:** `theme/deploy.js`: on click, `fetch('/api/deployment-transition', { method:
  'POST', body: JSON.stringify({ workstream: slug, stage, sha }) })` — the `sha` comes from a
  fresh `GET` of the current deployment-log file first (same two-step "read current SHA, then
  write" pattern any write-back caller needs; there is no existing client precedent for this in the
  codebase — Task 7 is the first write-back UI Atlas ships, say so in the task's own commit
  message so nobody assumes a copied pattern that doesn't exist). On success, show inline
  confirmation text ("Recorded — the page will reflect this on the next rebuild.") — **never**
  claim a deployment happened.
- [ ] **Step 5:** Template tests: a rendered page with a two-entry `deploymentHistory` shows both
  nodes in order; a page with an empty history shows exactly one node (the current
  `displayedStage`); the three buttons carry the right `data-*` attributes.
- [ ] **Step 6:** Run the full suite. Commit.

## Task 8: CSS

**Files:**
- Modify: `theme/tokens.css`

**Interfaces:** none new — pure styling for `.stage-history`/`.stage-node` and the trigger buttons,
following the existing token-based color/spacing convention (no literal colors, `var(--sky-*)`/
`var(--atlas-*)` only, per the WCAG-contrast test `tests/theme.test.mjs` already enforces).

- [ ] **Step 1:** Style `.stage-node` reusing the milestone spine's dot-and-line visual language
  (`.milestone-icon`, the connecting line) at a smaller scale, distinct enough not to be mistaken
  for a milestone node — a different token or a smaller size, not identical CSS.
- [ ] **Step 2:** Style the three trigger buttons plainly, matching `.theme-list button`'s flat,
  no-box convention from the M4.1 rebuild rather than introducing a new button chrome.
- [ ] **Step 3:** Run the WCAG contrast test (`tests/theme.test.mjs`) and the self-consistency
  test beside it — both must stay green with the new rules' tokens included in
  `OCCURRING_PAIRS` if the new elements introduce a text-on-ground pairing not already covered.
  Add pairs as needed.
- [ ] **Step 4:** Rebuild the fixture, screenshot in both themes (this is a visual change — follow
  this project's own established practice of a real Playwright screenshot before calling it done,
  not just passing tests). Commit.

## Task 9: Migrate the two real Vennusign manifests (separate repo, separate commit)

**Files (Vennusign repo, `/mnt/c/development/vennusign/.claude/worktrees/keystone-decisions`):**
- Modify: `docs/features/atlas/workstream.json`, `docs/features/menus/workstream.json`

**Interfaces:** none — pure data edit, no code.

- [ ] **Step 1:** Change `"stage": "shipping"` to `"stage": "development"` in both manifests (the
  conservative floor per the spec's own instruction — this plan does not know Atlas's or Menus'
  real current deployment state with certainty, so it defaults low rather than guessing a
  further-along value; the owner can correct either to `staging`/`release` directly, or use the
  new on-screen control once Atlas M8 is deployed).
- [ ] **Step 2:** This is a Vennusign-repo commit, not part of the Atlas PR — commit and push it
  separately, after Atlas's M8 build (which introduces `development`/`staging`/`release` as valid
  values) is live, not before — a Vennusign manifest carrying `"development"` while the deployed
  Atlas site still only knows `['not-started','designing','planned','shipping']` would fail that
  site's own build validation until the new Atlas version deploys. State this ordering constraint
  in the commit message.

## Task 10: Full-suite verification and fixture build

**Files:** none — verification only.

- [ ] **Step 1:** `npm test` from the Atlas repo root — full suite green, exact count noted.
- [ ] **Step 2:** `node src/build.mjs fixture .atlas-out --offline --quiet` — succeeds.
- [ ] **Step 3:** Grep the whole repo (`grep -rn "'shipping'\|\"shipping\"" src/ theme/ api/
  tests/ fixture/`) for any remaining reference to the removed vocabulary value; every hit is
  either a deliberate historical comment (leave it) or a real bug (fix it) — decide per hit, don't
  bulk-delete.
- [ ] **Step 4:** Run the impeccable detector (`node .agents/skills/impeccable/scripts/detect.mjs
  --json theme/_includes/depth.njk theme/tokens.css` from the Vennusign repo, pointed at Atlas's
  changed files) on the new UI per this project's own established practice.

---

## Self-review

**Spec coverage.** Vocabulary (Task 2), storage-not-manifest (Tasks 4-5), the decision-35
amendment named explicitly (Task 1 + Global Constraints), the trigger mechanism (Task 7), the
displayed-stage override rule (Task 6), rendering (Tasks 7-8), the deployment-agent exclusion
(never implemented, checked by the Global Constraint banning the word "deployed" from any UI
string), the real-manifest migration scoped to its own repo and its own ordering constraint (Task
9). Every spec section maps to a task.

**Placeholder scan.** No task says "handle appropriately" or defers real logic. Task 7 flags a
genuine unknown (whether an existing "write-back configured" template conditional exists to reuse)
as something to check at implementation time rather than inventing a fake certainty about it —
that is a disclosed dependency, not a placeholder, and it names exactly what to grep for.

**Type/signature consistency.** `appendDeploymentTransition(text, {stage, note}) -> string` (Task
4) is consumed identically in Task 5's handler. `validateDeploymentTransitionPayload`'s output
shape (Task 3) matches every other `validate*Payload` function's `{ok, value}`/`{ok, response}`
contract already established by `validateAcceptancePayload` and `validateAnswerPayload`. `stream.displayedStage`/`stream.deploymentHistory` (Task 6) are the exact field names Task 7's
templates read — flagged explicitly as a cross-task dependency to verify (Task 7's Interfaces
block) rather than assumed silently.

**One thing intentionally left for the plan's executor to confirm, not this plan:** the exact file
and line of the "exactly two handlers" test (Task 1, Step 1) and the exact insertion point in
`assembleSite` (Task 6, Step 5) are both named as "grep/read first, don't guess" rather than cited
by line number, because this plan's author did not re-read those two spots at the moment of
writing this section and citing a wrong line would be worse than citing none.
