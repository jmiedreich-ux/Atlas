# Atlas M4.2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** fix `computeLadder`'s tip-label gap when a workstream has open milestones behind an
out-of-order `done` one; rename the `gate` field to `next` everywhere; add a length cap that stops
`position`/`next` drifting into narrative prose; apply both to every real manifest and rewrite
Atlas's own content to the concise style already used by the other six workstreams.

**Architecture:** `src/depth.mjs` gains `earliestOpenDepth` and a small branch in the `headPosition`
computation — pure, no new exports beyond what's already there. The `gate`→`next` rename touches
`api/lib/contract.mjs`'s comment, `src/schema.mjs`'s validator, `src/state.mjs`, `src/depth.mjs`'s
column shape, three templates, `theme/tokens.css`'s selectors, Atlas's own fixture manifests, and
nine test files — mechanical, verified by the test suite itself failing loudly on any missed spot
(a manifest still holding `gate` fails `validateWorkstream` once `next` is required). The length
cap is one new check in the same validator. Two Vennusign-repo tasks land the content half: the key
rename across all seven real manifests, and Atlas's own content rewrite.

**Tech Stack:** Node.js (`node --test`), no new dependency.

**Spec:** `docs/superpowers/specs/2026-08-24-m4-2-ladder-fix-and-content-style-design.md`

## Global Constraints

* Decision 32 — fail loudly, closed vocabulary. The `gate`→`next` rename is a hard rename (no
  back-compat key); the length cap fails the build by name, citing the manifest path, the field,
  the limit, and the actual length — matching every other `schema.mjs` error's shape exactly
  (see `requireString`'s message format for the pattern to copy).
* Decision 1 — built from source, nothing hand-maintained twice. The six already-concise
  manifests (`keystone`, `menus`, `onboarding`, `platform-operations`, `screens`, `theme-studio`)
  get their `gate` key renamed to `next` and nothing else — their content is not rewritten, it is
  already correct.
* The `gate`→`next` rename and the length-cap addition both touch `src/schema.mjs`'s
  `validateWorkstream`. Do the rename first (Task 2), the length cap second (Task 3), so the cap
  is written against the field name it will actually validate rather than being written twice.
* Every file this plan touches for the rename is enumerated in the spec's "Renaming `gate`"
  section, confirmed there by direct grep — that list is the authority for completeness, not this
  plan's own memory of it.
* `docs/features/atlas/workstream.json` and its plan files (`m1-plan.md` through `m8-plan.md`,
  `m4-1-plan.md`) live in the **Vennusign** repository
  (`/mnt/c/development/vennusign/.claude/worktrees/keystone-decisions`), not this Atlas worktree.
  Tasks 5 and 6 operate there — in a **separate, freshly-created worktree off Vennusign's current
  `origin/master`**, never directly in that path, which is another live session's own working
  directory (SOP 7a/7b — this project's own incident history is exactly this mistake).

---

## File structure

**Modified (Atlas repo):**
* `src/depth.mjs` — `earliestOpenDepth`, `headPosition`/`tipLabel`/`skippedBehind` gap handling.
* `src/schema.mjs` — `gate`→`next` field rename, new length-cap validation.
* `api/lib/contract.mjs` — comment update (no vocabulary change, `gate`/`next` are not enums).
* `src/state.mjs` — `gate: stream.manifest.gate` → `next: stream.manifest.next`.
* `theme/_includes/depth.njk`, `theme/_includes/mobile.njk`, `theme/_includes/workstream.njk` —
  `manifest.gate` → `manifest.next`; `Gate` label text → `Next`.
* `theme/tokens.css` — `.card-gate`/`.card-gate-label`/`.gate-callout` → `.card-next`/
  `.card-next-label`/`.next-callout` (styling rules unchanged, selectors renamed).
* `fixture/docs/features/*/workstream.json` (all six fixture workstreams) — `gate` key → `next`.
* `tests/config.test.mjs`, `tests/scaffold.test.mjs`, `tests/state.test.mjs`, `tests/swa.test.mjs`,
  `tests/build.test.mjs`, `tests/schema.test.mjs`, `tests/triage.test.mjs`, `tests/depth.test.mjs`,
  `tests/theme.test.mjs` — every `gate:`/`.gate`-referencing line updated to `next`.

**Modified (Vennusign repo, separate worktree):**
* `docs/features/*/workstream.json` (all seven real manifests) — `gate` key → `next`.
* `docs/features/atlas/workstream.json` — `next` content rewritten to the concise style, under the
  240-character cap.

---

## Task 1: `computeLadder` handles a completion gap

**Files:**
- Modify: `src/depth.mjs`
- Test: `tests/depth.test.mjs`

**Interfaces:**
- Produces: no new exports. `computeLadder`'s return shape is unchanged (`tipLabel` can now
  resolve to a real label in a case that previously returned `null`; `skipped` can now exclude one
  more milestone than before, in the gap case specifically).

- [ ] **Step 1: Write the failing test**

Add to `tests/depth.test.mjs`, near the existing `finishedDepth`/`skippedBehind`-adjacent tests
(search the file for `'a parked milestone'` or similar to find the right neighborhood):

```js
test('computeLadder: an open milestone behind an out-of-order done one becomes the head, not a skip marker', () => {
  const milestones = [
    { id: 'M1', label: 'M1', depth: 1, status: 'done' },
    { id: 'M2', label: 'M2', depth: 2, status: 'unplanned' },
    { id: 'M3', label: 'M3', depth: 3, status: 'done' },
  ];
  const ladder = computeLadder([
    { manifest: { codename: 'Gapped', stage: 'release', gate: 'n/a', milestones } },
  ]);
  const column = ladder.columns[0];

  assert.equal(column.tipLabel, 'M2', 'the head should point at the open milestone, not fall back to null');
  assert.equal(column.headAt, 'depth-2', 'the head row should be M2\'s own depth, not one past the deepest done milestone');
  assert.deepEqual(
    column.skipped.map((s) => s.id),
    [],
    'M2 is the head target now, not a skip marker — skippedBehind must exclude it',
  );
});

test('computeLadder: a genuinely parked milestone still renders as a skip marker, unaffected by the gap fix', () => {
  const milestones = [
    { id: 'M1', label: 'M1', depth: 1, status: 'done' },
    { id: 'M2', label: 'M2', depth: 2, status: 'parked' },
    { id: 'M3', label: 'M3', depth: 3, status: 'done' },
  ];
  const ladder = computeLadder([
    { manifest: { codename: 'Parked', stage: 'release', gate: 'n/a', milestones } },
  ]);
  const column = ladder.columns[0];

  assert.equal(column.tipLabel, null, 'nothing open behind the edge — M2.1\'s original null-fallback case, unchanged');
  assert.deepEqual(column.skipped.map((s) => s.id), ['M2'], 'a parked milestone is still a skip marker');
});

test('computeLadder: no gap, no change — a workstream that completes in order renders exactly as before', () => {
  const milestones = [
    { id: 'M1', label: 'M1', depth: 1, status: 'done' },
    { id: 'M2', label: 'M2', depth: 2, status: 'next' },
  ];
  const ladder = computeLadder([
    { manifest: { codename: 'Ordinary', stage: 'release', gate: 'n/a', milestones } },
  ]);
  const column = ladder.columns[0];

  assert.equal(column.tipLabel, 'M2');
  assert.equal(column.headAt, 'depth-2');
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test tests/depth.test.mjs`
Expected: the first two new tests FAIL (`tipLabel` is `null` for the gap case instead of `'M2'`;
the parked test's `skipped` assertion passes already — that one is a regression guard, not a new
behavior, and should already pass). The third test should already pass (no gap, no change).

- [ ] **Step 3: Implement the fix**

In `src/depth.mjs`, add a new function near `finishedDepth` (same file, same style — a plain
reduce, no dependency on anything not already imported):

```js
// The mirror of `finishedDepth`: the shallowest depth among milestones that are neither `done`
// nor `parked` — the earliest thing genuinely still open. `null` when nothing is open (everything
// on record is finished or was worked around), which is the existing, correct case this function
// does not change.
function earliestOpenDepth(milestones) {
  const open = milestones.filter((m) => m.status !== 'done' && m.status !== 'parked');
  if (open.length === 0) return null;
  return open.reduce((shallowest, m) => (m.depth < shallowest ? m.depth : shallowest), Infinity);
}
```

Then, inside `computeLadder`'s `columns.map` callback, after `completedDepth` is computed and
before `barRows`/`headPosition` are used to derive `tipLabel`, add the gap check. Replace the
existing block:

```js
    const completedDepth = finishedDepth(milestones);
    const barRows = preMilestoneCoveredCount(stage) + completedDepth;
    const headPosition = barRows + 1;

    const barTo = barRows === 0 ? null : rowIdForSequencePosition(barRows);
    const headAt = rowIdForSequencePosition(headPosition);
```

with:

```js
    const completedDepth = finishedDepth(milestones);
    const barRows = preMilestoneCoveredCount(stage) + completedDepth;

    // A gap: something shallower than the deepest DONE milestone is neither done nor parked — it
    // was leapfrogged, not worked around (SOP 2b's own case). The head points there instead of
    // one past the deepest done milestone, because that open milestone — not an imagined "next"
    // depth with nothing recorded — is the honest answer to "what's actually next."
    const openDepth = earliestOpenDepth(milestones);
    const gapped = openDepth !== null && openDepth <= completedDepth;

    const headPosition = gapped ? openDepth + preMilestoneCoveredCount(stage) : barRows + 1;

    const barTo = barRows === 0 ? null : rowIdForSequencePosition(barRows);
    const headAt = rowIdForSequencePosition(headPosition);
```

(`headPosition` in the gap case is `openDepth + preMilestoneCoveredCount(stage)` rather than
`barRows + 1`, because `rowIdForSequencePosition` expects a 1-based *sequence* position — pre-
milestone stages occupy positions 1-3, and milestone depth `d` occupies sequence position `d + 3`.
`preMilestoneCoveredCount(stage)` is always `3` for any workstream with milestones on record at
all — `development`/`staging`/`release`/`planned` all return 3 — so this reduces to `openDepth + 3`
in every real case, matching `rowIdForSequencePosition`'s own `position - 3` inverse exactly. Kept
as the named call rather than the literal `+ 3` so the relationship stays visible if
`preMilestoneCoveredCount` ever changes.)

Further down, the `tipLabel` branch already does the right thing once `headPosition` is correct —
no change needed there; `depth = headPosition - 3` will now correctly equal `openDepth`, and
`milestoneAtDepth` will find the real milestone.

Last, `skippedBehind` needs to exclude the gap milestone from the skip-marker list (it is the head
target now, not something the work went round). Replace:

```js
      skipped: skippedBehind(milestones, completedDepth),
```

with:

```js
      skipped: skippedBehind(milestones, completedDepth).filter((s) => !(gapped && s.depth === openDepth)),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/depth.test.mjs`
Expected: PASS, all three new tests plus the full existing file (no regressions — the "no gap"
case and every other existing `computeLadder` test must still pass byte-identical).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. This task touches only `src/depth.mjs`, consumed by `src/build.mjs`,
`theme/_includes/depth.njk` (via `column.tipLabel`/`column.skipped`), and `src/state.mjs` — none of
those call sites change shape, so nothing downstream should need updating in this task.

- [ ] **Step 6: Commit**

```bash
git add src/depth.mjs tests/depth.test.mjs
git commit -m "fix: computeLadder points the head at an open milestone behind an out-of-order done one"
```

---

## Task 2: rename `gate` to `next` across the Atlas repository

**Files:**
- Modify: `api/lib/contract.mjs`, `src/schema.mjs`, `src/state.mjs`, `src/depth.mjs`,
  `theme/_includes/depth.njk`, `theme/_includes/mobile.njk`, `theme/_includes/workstream.njk`,
  `theme/tokens.css`, all six `fixture/docs/features/*/workstream.json` files
- Test: `tests/config.test.mjs`, `tests/scaffold.test.mjs`, `tests/state.test.mjs`,
  `tests/swa.test.mjs`, `tests/build.test.mjs`, `tests/schema.test.mjs`, `tests/triage.test.mjs`,
  `tests/depth.test.mjs`, `tests/theme.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: every workstream manifest's required field is now `next`, not `gate`. Any manifest
  still holding `gate` fails `validateWorkstream` (Task 3 hasn't landed the length cap yet at this
  point, but the field-name check alone already rejects the old key by Task 2's own change).

This task is mechanical but wide — a real rename, not a design decision. The pattern is identical
everywhere: `gate` → `next` as an object key, `.gate` → `.next`/`manifest.gate` →
`manifest.next` as a property access, `"Gate"` as a UI label → `"Next"`, and the three CSS
class names (`card-gate`, `card-gate-label`, `gate-callout`) → (`card-next`, `card-next-label`,
`next-callout`). Do it file by file, verifying each with a targeted grep before moving to the
next — do not rely on a single global find/replace across the whole tree, since some files (this
plan's own spec/plan documents, this task's own commit message) legitimately still say the word
"gate" in prose about the rename itself and must not be touched.

- [ ] **Step 1: `api/lib/contract.mjs`**

Update the comment at the line beginning `` `blocked`, not `gated` (#780): the word "gate" belongs
to the workstream's own `gate` field `` to read `` `blocked`, not `gated` (#780): the word "gate"
used to belong to the workstream's own field — since M4.2, that field is `next` `` (or equivalent
— the point is the comment must not claim a field name that no longer exists). No code in this
file changes; `contract.mjs` does not itself hold `gate` as a validated key (that's
`src/schema.mjs`).

Verify: `grep -n "gate" api/lib/contract.mjs` shows only the updated comment, no other reference.

- [ ] **Step 2: `src/schema.mjs`**

Find `requireString(obj, 'gate', '', errors);` in `validateWorkstream` and change to
`requireString(obj, 'next', '', errors);`.

Verify: `grep -n "'gate'" src/schema.mjs` returns nothing.

- [ ] **Step 3: `src/state.mjs`**

Find line 89, `gate: stream.manifest.gate,` (context: this is inside the object `buildState` or a
similarly-named function assembles per workstream for `state.json`). Change to
`next: stream.manifest.next,`.

Verify: `grep -n "gate" src/state.mjs` returns nothing.

- [ ] **Step 4: `src/depth.mjs`**

Two spots, both inside `computeLadder` (this task runs on top of Task 1's changes to the same
function — merge carefully, don't revert Task 1's work):
1. The destructure `const { codename, stage, gate, milestones } = manifest;` → `const { codename, stage, next, milestones } = manifest;`.
2. The column's own field `note: gate,` → `note: next,`.

Verify: `grep -n "gate" src/depth.mjs` returns nothing.

- [ ] **Step 5: `theme/_includes/depth.njk`**

Find the `feature-next` span's gate fallback (added in the M4.1-followups round, near the
`tipLabel`/`Next:` logic):

```njk
{%- elif stream.manifest.gate %}
<span class="feature-next">{{ stream.manifest.gate }}</span>
{%- endif %}
```

Change `stream.manifest.gate` to `stream.manifest.next` (the `feature-next` CSS class name stays —
it already describes the *rendered concept*, "the next-step text," not the manifest field, and
Task 1 didn't touch it either).

Verify: `grep -n "gate" theme/_includes/depth.njk` returns nothing.

- [ ] **Step 6: `theme/_includes/mobile.njk`**

Find:

```njk
<p class="card-gate"><span class="card-gate-label">Gate</span>{{ stream.manifest.gate }}</p>
```

Change to:

```njk
<p class="card-next"><span class="card-next-label">Next</span>{{ stream.manifest.next }}</p>
```

Verify: `grep -n "gate\|Gate" theme/_includes/mobile.njk` returns nothing.

- [ ] **Step 7: `theme/_includes/workstream.njk`**

Find:

```njk
<p class="gate-callout"><span class="meta-label">Gate</span>{{ workstream.manifest.gate }}</p>
```

Change to:

```njk
<p class="next-callout"><span class="meta-label">Next</span>{{ workstream.manifest.next }}</p>
```

(`meta-label` is a shared class used by other callouts on this template too — leave it as-is, only
the `gate-callout` class and the field access change.)

Verify: `grep -n "gate\|Gate" theme/_includes/workstream.njk` returns nothing.

- [ ] **Step 8: `theme/tokens.css`**

Find the three selectors `.card-gate`, `.card-gate-label`, `.gate-callout` (search for `card-gate`
and `gate-callout` — they may not be adjacent in the file). Rename each selector to
`.card-next`, `.card-next-label`, `.next-callout` respectively. **Do not change any declaration
inside the rule bodies** — this is a selector rename only, the visual styling is unaffected.

Verify: `grep -n "gate" theme/tokens.css` returns nothing.

- [ ] **Step 9: fixture manifests**

All six files under `fixture/docs/features/*/workstream.json` (beacon, tide, reef, harbor, anchor,
shoal — confirm the actual list with `ls fixture/docs/features/`) have a top-level `"gate": "..."`
key. Rename the key to `"next"` in each, value unchanged.

Verify: `grep -rln '"gate"' fixture/` returns nothing; `grep -rln '"next"' fixture/docs/features/*/workstream.json` lists all six.

- [ ] **Step 10: the nine test files**

For each of `tests/config.test.mjs`, `tests/scaffold.test.mjs`, `tests/state.test.mjs`,
`tests/swa.test.mjs`, `tests/build.test.mjs`, `tests/schema.test.mjs`, `tests/triage.test.mjs`,
`tests/depth.test.mjs`, `tests/theme.test.mjs`: run `grep -n "gate" <file>` first to see every hit
in that specific file, then fix each — the shapes to expect, none of them exotic:
- A hand-built manifest literal or fixture object with a `gate: '...'` key (rename to `next:`).
- A test assertion string that names the field, e.g. `'"gate" is required'` (update to `'"next"
  is required'`) or a test *title* describing gate behavior (reword the title to say "next", not
  just the code).
- `tests/theme.test.mjs` specifically has the `entry()` helper (search for `function entry`) whose
  default object includes a `gate:` field — rename that default too, and check every call site that
  overrides `gate: '...'` inline.
- `tests/depth.test.mjs` already has three new tests from Task 1 using `gate: 'n/a'` as a fixture
  field on the manifest literal — rename those three occurrences to `next: 'n/a'` too, since Task 2
  runs after Task 1 and the schema no longer accepts the old key. (`computeLadder` itself does not
  validate its input against the schema, so those tests would not fail on this alone, but leaving
  a stale `gate:` in a fixture object is exactly the kind of drift decision 1 exists to prevent —
  fix it for consistency.)

Verify, across the whole test directory: `grep -rln '"gate"\|'"'"'gate'"'"'\|\.gate\b' tests/`
returns nothing.

- [ ] **Step 11: Run the full suite**

Run: `npm test`
Expected: PASS, all files, no reference to `gate` anywhere left in a place that isn't this plan's
own commit message or the spec document.

- [ ] **Step 12: Commit**

```bash
git add api/lib/contract.mjs src/schema.mjs src/state.mjs src/depth.mjs \
  theme/_includes/depth.njk theme/_includes/mobile.njk theme/_includes/workstream.njk \
  theme/tokens.css fixture/ tests/
git commit -m "refactor: rename the gate field to next, everywhere"
```

---

## Task 3: a length cap on `position` and `next`

**Files:**
- Modify: `src/schema.mjs`
- Test: `tests/schema.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `validateWorkstream` now rejects a `position` or `next` value over 240 characters,
  with an error message matching this file's own established format (see `requireString`'s message
  for the shape: names the field, states the rule, shows what was actually given).

- [ ] **Step 1: Write the failing test**

Add to `tests/schema.test.mjs`, near the other `validateWorkstream` field-length/shape tests:

```js
test('validateWorkstream: position over 240 characters is rejected by name', () => {
  const manifest = validManifest({ position: 'x'.repeat(241) });
  const result = validateWorkstream(manifest);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.path === 'position' && /240 characters or fewer/.test(e.message)),
    `expected a position-length error, got: ${JSON.stringify(result.errors)}`,
  );
});

test('validateWorkstream: next over 240 characters is rejected by name', () => {
  const manifest = validManifest({ next: 'x'.repeat(241) });
  const result = validateWorkstream(manifest);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.path === 'next' && /240 characters or fewer/.test(e.message)),
    `expected a next-length error, got: ${JSON.stringify(result.errors)}`,
  );
});

test('validateWorkstream: position and next at exactly 240 characters are accepted', () => {
  const manifest = validManifest({ position: 'x'.repeat(240), next: 'x'.repeat(240) });
  const result = validateWorkstream(manifest);
  assert.equal(result.ok, true, `expected valid, got: ${JSON.stringify(result.errors)}`);
});
```

(`validManifest` — check the actual helper name in this test file; it may be called something
else, e.g. a local `entry()`/`baseManifest()` builder. Use whatever this file's own existing tests
already use to build a minimally-valid manifest object, don't invent a new one.)

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test tests/schema.test.mjs`
Expected: FAIL (the length is not currently checked at all — a 241-character `position`/`next`
validates successfully today).

- [ ] **Step 3: Implement the length cap**

In `src/schema.mjs`, add a small helper near `requireString` (same file, same section):

```js
const CONCISE_FIELD_LIMIT = 240;

function requireConciseString(obj, key, path, errors) {
  if (!requireString(obj, key, path, errors)) return;
  const value = obj[key];
  if (value.length > CONCISE_FIELD_LIMIT) {
    errors.push({
      path: joinPath(path, key),
      message:
        `"${key}" must be ${CONCISE_FIELD_LIMIT} characters or fewer (got ${value.length}) — ` +
        `state where things stand, not how they got there`,
    });
  }
}
```

Then in `validateWorkstream`, replace the two existing calls:

```js
  requireString(obj, 'position', '', errors);
  ...
  requireString(obj, 'next', '', errors);
```

with:

```js
  requireConciseString(obj, 'position', '', errors);
  ...
  requireConciseString(obj, 'next', '', errors);
```

(Exact surrounding lines depend on Task 2's rename already having landed — `next` is the field
name to require here, not `gate`. If `requireString(obj, 'position', ...)` and the `next`/`gate`
call are not adjacent in the file, that's fine, make each substitution in place.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/schema.test.mjs`
Expected: PASS, all three new tests, and the full existing file (no real manifest test fixture in
this file should be over 240 characters already — if one is, that's a pre-existing test fixture
that needs shortening, not a reason to raise the limit).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. If any *other* test file's fixture manifest happens to exceed 240 characters in
`position`/`next` (unlikely, but check), shorten that fixture's string rather than loosening the
cap — the whole point of this task is that 240 is a real ceiling.

- [ ] **Step 6: Commit**

```bash
git add src/schema.mjs tests/schema.test.mjs
git commit -m "feat: cap position and next at 240 characters, failing loudly over"
```

---

## Task 4: full-suite verification and fixture build (Atlas repo)

**Files:** none modified — verification only.

- [ ] **Step 1: Run the full suite one more time**

Run: `npm test`
Expected: every test passes, full file, no `gate` reference anywhere outside prose about the
rename itself (this plan, the spec, commit messages).

- [ ] **Step 2: Build the fixture and inspect the output**

```bash
rm -rf .atlas-out
node src/build.mjs fixture .atlas-out --offline --quiet
grep -rl "gate" .atlas-out/ || echo "no gate references in built output"
```

Expected: the build succeeds, and the grep finds nothing (the word "gate" should not appear
anywhere in a rendered page — if it does, something in the rename was missed).

- [ ] **Step 3: Commit if anything changed**

If Step 2 required any fix, commit it separately with a clear message naming what was missed.

---

## Task 5: rename `gate` to `next` in every real Vennusign manifest

**Repository:** Vennusign (`jmiedreich-ux/Vennusign`), **not** this Atlas worktree.

**Before starting this task:** create a fresh, separate git worktree off Vennusign's current
`origin/master` — do **not** operate directly in
`/mnt/c/development/vennusign/.claude/worktrees/keystone-decisions`, which is a different, live
session's own working directory (SOP 7a/7b: this project's own incident history is exactly this
mistake, twice already tonight with M7 and M8's own cross-repo tasks). Example:

```bash
git -C /mnt/c/development/vennusign fetch origin master
git -C /mnt/c/development/vennusign branch m4-2-gate-rename origin/master
git -C /mnt/c/development/vennusign worktree add /home/jeremy/.local/tmp/atlas-worktrees/m4-2-vennusign-rename m4-2-gate-rename
```

(Confirm the actual default branch name and current `origin/master` HEAD first rather than
assuming — verify with `git -C /mnt/c/development/vennusign branch --show-current` or equivalent
inside whatever worktree you're already in before creating a new one, since another session may
have moved `master` forward since this plan was written.)

**Files:** all seven `docs/features/*/workstream.json` (atlas, keystone, menus, onboarding,
platform-operations, screens, theme-studio) in that new worktree.

- [ ] **Step 1:** For each of the seven files, rename the top-level `"gate": "..."` key to
  `"next": "..."` — value unchanged for six of them (keystone, menus, onboarding,
  platform-operations, screens, theme-studio). **Atlas's own `gate` value is handled separately in
  Task 6, not here** — Task 5 is the mechanical key rename only; do not rewrite Atlas's content in
  this task, that is Task 6's whole job and doing it here would make Task 6's diff impossible to
  review cleanly.

- [ ] **Step 2:** Validate every file parses as JSON and the key rename is complete:

```bash
python3 -c "
import json, glob
for f in sorted(glob.glob('docs/features/*/workstream.json')):
    d = json.load(open(f))
    assert 'gate' not in d, f'{f} still has a gate key'
    assert 'next' in d, f'{f} is missing next'
print('all seven manifests renamed cleanly')
"
```

- [ ] **Step 3: Commit**

```bash
git add docs/features/*/workstream.json
git commit -m "refactor(features): rename gate to next across all seven manifests (Atlas M4.2)"
```

Leave this commit here, uncommitted-to-master and unpushed, in this isolated worktree — same
convention as every other cross-repo task this project has run tonight (M7's SOP addition, M8's
manifest migration). Do not merge or push. Report the worktree path, branch name, and commit SHA
in this task's own completion note so the controller can land it.

**Sequencing note for whoever lands this:** this commit and the Atlas repo's Task 2 (the code-side
rename) must land in a coordinated order — Vennusign's live site build would fail if this lands
before Atlas's new schema (requiring `next`, rejecting `gate`) is live, and Atlas's schema change
alone doesn't break anything until a build actually runs against these manifests. In practice:
merge Atlas's PR (Tasks 1-4) and move the `v1` tag first, exactly as M8's manifest migration was
sequenced, then merge this.

---

## Task 6: rewrite Atlas's own `position`/`next` content

**Repository:** Vennusign, same isolated worktree as Task 5
(`/home/jeremy/.local/tmp/atlas-worktrees/m4-2-vennusign-rename` unless Task 5 used a different
path — reuse whichever worktree Task 5 actually created, don't make a third one).

**Files:** `docs/features/atlas/workstream.json` only.

- [ ] **Step 1:** Read the current `position` and `next` (post-Task-5-rename) fields in full —
  they are the 1,893- and 1,104-character narrative paragraphs the spec measured and quoted from.

- [ ] **Step 2:** Rewrite both to the concise style the spec establishes, matching Keystone's own
  shape as the working example (`"Designed, not approved. 49 decisions proposed, 34 questions
  answered, six milestones planned."` / `"Owner approval of the design authority, which is still
  in docs/design/proposed/keystone/ and must move to approved/ before M1 starts. Tier and plan
  cost are deferred: provision nothing."`) — current state, present tense, no history of how it got
  there, under the 240-character cap Task 3 (Atlas repo) now enforces. Concretely, this milestone's
  own real facts to state (not invented, drawn from the actual shipped record): eight milestones
  done through `v1.5.1`; M5 is the real next milestone (a complete plan already exists for it); M6
  needs a decision on reconciling with what M4.1 shipped before its own plan proceeds unmodified;
  write-back covers three things as of M8. Two short sentences to two short paragraphs, not the
  existing eight-paragraph history — if a full draft comes out longer than 240 characters per
  field, cut content, don't request a cap increase.

- [ ] **Step 3:** Validate the result actually fits the cap before committing:

```bash
python3 -c "
import json
d = json.load(open('docs/features/atlas/workstream.json'))
print('position:', len(d['position']), 'chars')
print('next:', len(d['next']), 'chars')
assert len(d['position']) <= 240, 'position still over the cap'
assert len(d['next']) <= 240, 'next still over the cap'
print('both under the cap')
"
```

- [ ] **Step 4:** Validate the file still parses as a schema-valid manifest — check it against
  Atlas's own `validateWorkstream` if Task 5's worktree has Atlas's source available (it likely
  does not, being a Vennusign-only worktree); if not directly checkable here, at minimum confirm
  valid JSON and that every milestone/field this plan's other tasks assume still exists unchanged
  (only `position` and `next` change in this task — no milestone entry, no other field).

- [ ] **Step 5: Commit**

```bash
git add docs/features/atlas/workstream.json
git commit -m "docs(atlas): rewrite position/next to the concise style, under the new length cap"
```

Same convention as Task 5 — leave uncommitted-to-master, unpushed, report the SHA. This commit
should land in the same PR as Task 5's (both touch the same file's neighborhood in the same
worktree) or a follow-up — controller's call at landing time, not asserted here.

---

## Self-review

**Spec coverage.** The ladder-gap fix → Task 1. The `gate`→`next` rename → Tasks 2 (Atlas repo)
and 5 (Vennusign repo). The length cap → Task 3. Atlas's own content rewrite → Task 6. Every
"Touches" item the spec's grep-confirmed list names has a corresponding step in Task 2 or Task 5.
The spec's "deliberately excluded" section (the six already-concise manifests' content, nested/
multiple gaps, `MILESTONE_STATUSES` changes) has no task — correctly, since nothing should touch
those.

**Placeholder scan.** No task contains "TBD" or a description standing in for code. Task 2's
mechanical steps describe a repeated pattern rather than writing out nine near-identical test-file
diffs verbatim — that is not a placeholder, it is because the actual edits depend on each file's
existing exact wording (test titles, fixture variable names) which cannot be predicted without
reading the file, and each step gives a concrete verification grep rather than trusting the
pattern was followed correctly.

**Type/signature consistency.** `earliestOpenDepth(milestones) → number | null` (Task 1) mirrors
`finishedDepth`'s own signature exactly — same input type, same "reduce over depth" shape,
confirmed by reading the actual function before writing the mirror. `requireConciseString` (Task
3) has the identical four-argument shape as the file's own `requireString`/`requireEnum` — copied
convention, not invented. The `next` field name is used identically across every one of Tasks 2,
3, 5, and 6 — no task introduces a different spelling, casing, or a transitional alias.

**Cross-repository hazard, named explicitly, twice.** Tasks 5 and 6 both carry the same SOP 7a/7b
warning Tasks 2 (M7) and 9 (M8) already needed tonight — this is the third time this exact
instruction has been necessary in one session, which is itself worth the controller noting rather
than assuming it will be remembered.

**Sequencing hazard, named explicitly.** Task 5/6's completion note states plainly that the
Vennusign-side rename must land after Atlas's new schema is live, mirroring exactly how M8's
manifest migration was sequenced — not left for the controller to rediscover.
