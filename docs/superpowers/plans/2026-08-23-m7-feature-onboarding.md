# Atlas M7: a design becomes a tracked feature — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local scaffolding script that turns an approved-but-unscaffolded design into a
schema-valid starter `workstream.json` entry and first milestone plan file, plus a Vennusign
house-process addition gating what may be written into `docs/design/proposed/` in the first
place.

**Architecture:** One new pure-ish module in the Atlas repository, `src/scaffold.mjs`, following
`src/build.mjs`'s own CLI conventions exactly (`parseArgv`/`main(argv)`, exit codes 0/1/2, `atlas:
`-prefixed messages, an `invokedDirectly` guard). It checks three preconditions against a real
project checkout, refuses by name on any failure, and on success writes two files that validate
against `src/schema.mjs` unchanged. A second, independent task adds one new step to
`docs/MILESTONE_EXECUTION.md` in the Vennusign repository — pure documentation, no code.

**Tech Stack:** Node.js (`node --test`), no new dependency (decision 9: exactly two runtime
dependencies, `@11ty/eleventy` and its own Nunjucks — a scaffolding CLI needs neither).

**Spec:** `docs/superpowers/specs/2026-08-23-m7-feature-onboarding-design.md`

## Global Constraints

* Decision 1 — built from source, never maintained. The scaffold writes **structure**, never
  invented prose: every free-text field it fills gets an unmissable placeholder
  (`"<< M7 scaffold: replace this — see docs/design/approved/<slug>/ >>"`), never a plausible
  guess.
* Decision 32 — fail loudly, by name. Every precondition failure names exactly which precondition
  failed and points at the fix; the script never writes a partial result.
* Decision 35 — write-back's two writable things, and no third. This script is **never** invoked
  from the website or from write-back. It is a local CLI, run against a real checkout, its output
  committed through ordinary git — the same way `node src/build.mjs` already runs.
* Decision 40 — the generator holds no project content. `src/scaffold.mjs` is as
  project-agnostic as `src/build.mjs`: it takes a project root and a slug as arguments, nothing
  Vennusign-specific is hard-coded anywhere in it.
* `atlas: ` message prefix, `node --test` / `node:assert/strict` test style (flat `test(name,
  async () => {...})`, no `describe`), matching every existing test file in `tests/` — see
  `tests/build.test.mjs` and `tests/config.test.mjs` for the pattern this plan's tests follow.
* The scaffold's exit codes mirror `src/build.mjs`'s `main()`: `0` success, `1` a precondition
  refusal (named), `2` a usage error (missing/malformed arguments) — see `src/build.mjs:659-702`
  for the exact shape to match.

---

## File structure

**Created:**
* `src/scaffold.mjs` — `parseArgv(argv)`, `checkPreconditions({ projectRoot, slug })`,
  `scaffoldWorkstream({ projectRoot, slug })`, `main(argv)`. Single responsibility: given a
  project root and a slug, either write two valid starter files or refuse by name.
* `tests/scaffold.test.mjs`
* `tests/fixtures/scaffold/` — a small hand-built fixture project directory (or reuse of the
  existing `fixture/` tree with one additional not-yet-scaffolded workstream under
  `docs/design/approved/`) exercising the success path and both refusal paths. Task 1 decides
  which; see its Step 1.

**Modified (Vennusign repository, not Atlas — Task 2 only):**
* `docs/MILESTONE_EXECUTION.md` — one new numbered step in Phase A, plus its own dated changelog
  entry at the bottom of the file, following the existing 7a/7b convention exactly.

---

## Task 1: `src/scaffold.mjs` — preconditions, writing, and the CLI

**Files:**
- Create: `src/scaffold.mjs`
- Test: `tests/scaffold.test.mjs`
- Fixture: a not-yet-scaffolded workstream under a test fixture's `docs/design/approved/<slug>/`
  (with at least one file in it, so "non-empty" has something real to check), and the same
  fixture's `docs/features/` deliberately missing that slug's directory.

**Interfaces:**
- Consumes: `src/schema.mjs`'s `validateWorkstream` (to prove the written manifest is valid — the
  test that matters most is "the generator accepts what this script wrote," not "this script's
  own idea of valid"); `api/lib/contract.mjs`'s `WORKSTREAM_STAGES` (for the `designing`-stage
  precondition, imported the same way `src/schema.mjs` re-exports it — see
  `src/schema.mjs:20-27`).
- Produces: `checkPreconditions({ projectRoot, slug }) → { ok: true } | { ok: false, reason:
  string }` and `scaffoldWorkstream({ projectRoot, slug }) → { ok: true, written: string[] } |
  { ok: false, reason: string }` (calls `checkPreconditions` itself first — a caller never has to
  remember to check before writing). Both exported for the test file to call directly, in
  addition to the CLI end-to-end path.

- [ ] **Step 1: Decide and build the fixture**

Read `fixture/` (the Atlas repository's own existing demo project, used by `tests/build.test.mjs`
and others) to see whether adding one more not-yet-approved-then-approved workstream to it is
simpler than a wholly separate fixture directory under `tests/fixtures/scaffold/`. Prefer
extending `fixture/` only if doing so does not change any existing test's expectations (grep
`tests/*.test.mjs` for hard-coded counts of `fixture/docs/features/*` entries first — if any
exist, use a separate fixture instead, so this task cannot silently break Task 10-style
full-fixture assertions elsewhere). Whichever is chosen, it needs:
- one slug with an approved design at `docs/design/approved/<slug>/README.md` (any real content,
  a sentence is enough) and no `docs/features/<slug>/` directory at all (the success path);
- one slug with an approved design AND an existing `docs/features/<slug>/workstream.json`
  (checked separately for the "already scaffolded" refusal);
- one slug with a design only under `docs/design/proposed/<slug>/`, nothing under `approved/`
  (the "still proposed" refusal).

- [ ] **Step 2: Write the failing tests for `checkPreconditions`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPreconditions } from '../src/scaffold.mjs';

test('checkPreconditions: refuses a slug still under proposed/, not approved/', () => {
  const result = checkPreconditions({ projectRoot: FIXTURE_ROOT, slug: 'still-proposed-slug' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /still in `?proposed\/|proposed\/.*not.*approved/i);
});

test('checkPreconditions: refuses a slug with no approved design at all', () => {
  const result = checkPreconditions({ projectRoot: FIXTURE_ROOT, slug: 'no-such-slug' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /approved/i);
});

test('checkPreconditions: refuses a slug that already has a workstream.json', () => {
  const result = checkPreconditions({ projectRoot: FIXTURE_ROOT, slug: 'already-scaffolded-slug' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /already|exists/i);
});

test('checkPreconditions: passes for an approved, unscaffolded slug', () => {
  const result = checkPreconditions({ projectRoot: FIXTURE_ROOT, slug: 'ready-slug' });
  assert.equal(result.ok, true);
});
```

Use the fixture slugs Step 1 actually built; adjust names to match. `FIXTURE_ROOT` is
`path.join(REPO_ROOT, 'fixture')` or the new fixture directory's path, matching the
`__dirname`/`REPO_ROOT` pattern every other test file in `tests/` already uses (see the top of
`tests/theme.test.mjs` for that exact boilerplate).

- [ ] **Step 3: Run to verify all four fail**

Run: `node --test tests/scaffold.test.mjs`
Expected: FAIL with "checkPreconditions is not a function" or similar — nothing is implemented
yet.

- [ ] **Step 4: Implement `checkPreconditions`**

```js
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

export function checkPreconditions({ projectRoot, slug }) {
  const approvedDir = path.join(projectRoot, 'docs', 'design', 'approved', slug);
  const proposedDir = path.join(projectRoot, 'docs', 'design', 'proposed', slug);
  const manifestPath = path.join(projectRoot, 'docs', 'features', slug, 'workstream.json');

  if (existsSync(manifestPath)) {
    return {
      ok: false,
      reason: `docs/features/${slug}/workstream.json already exists — this tool scaffolds a ` +
        `feature's FIRST milestone only; a workstream already on record is out of scope for it.`,
    };
  }

  const approvedExists = existsSync(approvedDir) && readdirSync(approvedDir).length > 0;
  if (!approvedExists) {
    if (existsSync(proposedDir)) {
      return {
        ok: false,
        reason: `docs/design/proposed/${slug}/ exists but docs/design/approved/${slug}/ does ` +
          `not — the design is still in proposed/. See docs/MILESTONE_EXECUTION.md step 3: ` +
          `implementation is not authorized until it lands in approved/.`,
      };
    }
    return {
      ok: false,
      reason: `docs/design/approved/${slug}/ does not exist or is empty — nothing to scaffold ` +
        `from. A design authority has to be approved and landed there first.`,
    };
  }

  return { ok: true };
}
```

- [ ] **Step 5: Run to verify the four preconditions tests pass**

Run: `node --test tests/scaffold.test.mjs`
Expected: PASS (4 of however-many tests currently exist in the file).

- [ ] **Step 6: Write the failing tests for `scaffoldWorkstream`**

```js
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { validateWorkstream } from '../src/schema.mjs';

test('scaffoldWorkstream: refuses the same way checkPreconditions does, and writes nothing', () => {
  const result = scaffoldWorkstream({ projectRoot: FIXTURE_ROOT, slug: 'still-proposed-slug' });
  assert.equal(result.ok, false);
  assert.ok(!existsSync(path.join(FIXTURE_ROOT, 'docs/features/still-proposed-slug')));
});

test('scaffoldWorkstream: writes a workstream.json the generator accepts', () => {
  const result = scaffoldWorkstream({ projectRoot: FIXTURE_ROOT, slug: 'ready-slug' });
  assert.equal(result.ok, true);
  const manifestPath = path.join(FIXTURE_ROOT, 'docs/features/ready-slug/workstream.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const validated = validateWorkstream(manifest);
  assert.ok(validated.ok, `scaffolded manifest is not schema-valid: ${JSON.stringify(validated.errors)}`);
  assert.equal(manifest.stage, 'designing');
  assert.equal(manifest.milestones.length, 1);
  assert.equal(manifest.milestones[0].id, 'M1');
  assert.equal(manifest.milestones[0].status, 'unplanned');
  assert.match(manifest.milestones[0].title, /<<.*replace.*>>/i);
  assert.match(manifest.gate, /<<.*replace.*>>|owner.*replace/i);
  rmSync(path.join(FIXTURE_ROOT, 'docs/features/ready-slug'), { recursive: true });
});

test('scaffoldWorkstream: writes a plan file at the path the manifest names', () => {
  scaffoldWorkstream({ projectRoot: FIXTURE_ROOT, slug: 'ready-slug' });
  const planPath = path.join(FIXTURE_ROOT, 'docs/features/ready-slug/m1-plan.md');
  assert.ok(existsSync(planPath));
  const plan = readFileSync(planPath, 'utf8');
  assert.match(plan, /^# .+ Milestone 1/m);
  assert.match(plan, /## Goal/);
  assert.match(plan, /## Spec/);
  assert.match(plan, /docs\/design\/approved\/ready-slug/);
  rmSync(path.join(FIXTURE_ROOT, 'docs/features/ready-slug'), { recursive: true });
});
```

- [ ] **Step 7: Run to verify these three fail**

Run: `node --test tests/scaffold.test.mjs`
Expected: FAIL — `scaffoldWorkstream` not implemented.

- [ ] **Step 8: Implement `scaffoldWorkstream`**

```js
import { mkdirSync, writeFileSync } from 'node:fs';

const PLACEHOLDER = (hint) => `<< M7 scaffold: replace this — ${hint} >>`;

function titleize(slug) {
  return slug.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

export function scaffoldWorkstream({ projectRoot, slug }) {
  const check = checkPreconditions({ projectRoot, slug });
  if (!check.ok) return check;

  const codename = titleize(slug);
  const featureDir = path.join(projectRoot, 'docs', 'features', slug);
  mkdirSync(featureDir, { recursive: true });

  const manifest = {
    codename,
    what: PLACEHOLDER(`what is ${codename}, in one sentence — see docs/design/approved/${slug}/`),
    stage: 'designing',
    position: PLACEHOLDER('where this stands right now'),
    gate: PLACEHOLDER('what is actually blocking work from starting, in one sentence'),
    label: `workstream:${slug}`,
    design: [{ name: `${slug}/approved design`, where: `docs/design/approved/${slug}/` }],
    milestones: [
      {
        id: 'M1',
        label: 'M1',
        depth: 1,
        title: PLACEHOLDER(`M1's real title — see docs/design/approved/${slug}/`),
        status: 'unplanned',
        plan: 'm1-plan.md',
        issue: null,
        pr: null,
        acceptance: { kind: 'demo-script', record: null },
      },
    ],
  };

  writeFileSync(
    path.join(featureDir, 'workstream.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );

  const plan = `# ${codename} Milestone 1 — ${PLACEHOLDER('this milestone\'s title')}

> This is a scaffold, not a plan. Every section below names what to fill in and from where.

## Goal

${PLACEHOLDER('one sentence — what does this milestone actually deliver')}

## Where it will land

${PLACEHOLDER('which repository, which files')}

## Spec

docs/design/approved/${slug}/ — read it before writing anything else in this file.
`;

  writeFileSync(path.join(featureDir, 'm1-plan.md'), plan);

  return { ok: true, written: [
    path.join(featureDir, 'workstream.json'),
    path.join(featureDir, 'm1-plan.md'),
  ] };
}
```

- [ ] **Step 9: Run to verify all `scaffoldWorkstream` tests pass**

Run: `node --test tests/scaffold.test.mjs`
Expected: PASS, all tests in the file.

- [ ] **Step 10: Write the failing CLI tests**

```js
import { execFileSync } from 'node:child_process';

test('CLI: exit 0 and prints the written paths on success', () => {
  const output = execFileSync('node', ['src/scaffold.mjs', FIXTURE_ROOT, 'ready-slug'], {
    encoding: 'utf8',
  });
  assert.match(output, /atlas:.*ready-slug/);
  rmSync(path.join(FIXTURE_ROOT, 'docs/features/ready-slug'), { recursive: true });
});

test('CLI: exit 1 and names the reason on a refused precondition', () => {
  assert.throws(
    () => execFileSync('node', ['src/scaffold.mjs', FIXTURE_ROOT, 'still-proposed-slug'], {
      encoding: 'utf8',
    }),
    (err) => err.status === 1 && /proposed/i.test(err.stderr ?? err.stdout ?? ''),
  );
});

test('CLI: exit 2 on missing arguments', () => {
  assert.throws(
    () => execFileSync('node', ['src/scaffold.mjs'], { encoding: 'utf8' }),
    (err) => err.status === 2,
  );
});
```

- [ ] **Step 11: Run to verify these three fail**

Run: `node --test tests/scaffold.test.mjs`
Expected: FAIL — no `main`/CLI entry point yet.

- [ ] **Step 12: Implement `main(argv)` and the CLI entry, mirroring `src/build.mjs:659-709` exactly**

```js
import { fileURLToPath, pathToFileURL } from 'node:url';

export function parseArgv(argv) {
  return { projectRoot: argv[0], slug: argv[1] };
}

export async function main(argv) {
  const { projectRoot, slug } = parseArgv(argv);
  if (!projectRoot || !slug) {
    console.error('atlas: usage: node src/scaffold.mjs <project-root> <workstream-slug>');
    return 2;
  }
  const result = scaffoldWorkstream({ projectRoot, slug });
  if (!result.ok) {
    console.error(`atlas: scaffold refused — ${result.reason}`);
    return 1;
  }
  console.log(`atlas: scaffolded ${slug} — wrote ${result.written.join(', ')}`);
  return 0;
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
```

- [ ] **Step 13: Run to verify all CLI tests pass, then the whole file**

Run: `node --test tests/scaffold.test.mjs`
Expected: PASS, every test in the file.

- [ ] **Step 14: Run the full suite to confirm nothing else broke**

Run: `npm test`
Expected: PASS, previous total plus this file's new tests, 0 failures.

- [ ] **Step 15: Commit**

```bash
git add src/scaffold.mjs tests/scaffold.test.mjs
# plus whatever fixture files Step 1 added/changed
git commit -m "feat: scaffold.mjs — a local CLI that turns an approved, unscaffolded design into a starter workstream.json and milestone plan"
```

---

## Task 2: the entry-bar rule for `docs/design/proposed/`

**Files:**
- Modify (Vennusign repository — a DIFFERENT working directory and a DIFFERENT git remote than
  every other task in this plan; do not run this task's commands inside the Atlas worktree):
  `docs/MILESTONE_EXECUTION.md`

**Interfaces:**
- Consumes: nothing from Task 1 — this task is independent and may run before, after, or
  concurrently with it.
- Produces: nothing another task in this plan consumes. This is the plan's one purely
  documentation-only task.

- [ ] **Step 1: Read the current file's real Phase A numbering**

`docs/MILESTONE_EXECUTION.md` in the Vennusign checkout (not this Atlas worktree) — the spec
names steps 1–7b as of this plan's writing, but re-read the live file before touching it, since
other work may have inserted steps since. Find the correct insertion point: this step belongs in
Phase A, logically before or alongside step 3 (which gates on approval already existing) — it
gates on what happens *before* a proposal exists at all, so it reads naturally as a new step
between steps 1 and 3, numbered to fit whatever the file's real current sequence is (e.g. `2a` if
it sits directly after step 2, following the same lettering convention 7a/7b already established
for an inserted sub-step).

- [ ] **Step 2: Insert the step**

Insert, in the Phase A table, in the `| # | Step | Source |` row format every other entry uses:

```
| <N> | **Before writing anything into `docs/design/proposed/`:** confirm the workstream directory it names either already exists under `docs/features/` or is a deliberate new one (not a typo of an existing slug); read `docs/design/proposed/README.md` in full for anything already proposed that overlaps; and add an entry to that README in the same commit, following its existing per-item shape exactly (Files, Status, Intended use, Approval rule) — a proposal with no README entry is not discoverable by the very process (Atlas's M7 scaffold, a future reviewer) that will look for it there. | house |
```

- [ ] **Step 3: Add the changelog entry at the bottom of the file**

Following the exact style of the existing entries under `## Status` (the ones documenting when
and why 12a/12b/15a/24a and 7a/7b were added — read those two paragraphs for the voice and
level of detail expected), append a new paragraph:

```
Step <N> was added on <today's date>, closing the gap Atlas's M7 milestone found: step 3 already
gated *implementation* on a design being approved, but nothing gated *proposing* one in the first
place — a file could land under `docs/design/proposed/` naming a workstream directory that didn't
exist, or duplicating something already proposed, with no check and no README entry recording it.
```

Replace `<today's date>` with the actual date the commit is made, and `<N>` with the step number
actually used in Step 2.

- [ ] **Step 4: Verify the file still reads coherently**

No automated test exists for this file's prose (it is documentation, not code) — read the whole
Phase A section once after the edit to confirm the new step reads naturally in sequence with its
neighbors, and read the `## Status` section once to confirm the new paragraph matches the
existing two in structure (what changed, what gap it closes, in that order).

- [ ] **Step 5: Commit, in the Vennusign repository**

```bash
git add docs/MILESTONE_EXECUTION.md
git commit -m "docs(sop): gate what may be written into docs/design/proposed/ — Atlas M7"
```

---

## Task 3: full-suite verification and a real end-to-end run

**Files:** none created or modified — verification only.

**Interfaces:**
- Consumes: Task 1's `scaffold.mjs` (built), Task 2's SOP addition (no code dependency, verified
  separately).

- [ ] **Step 1: Run the full Atlas suite**

Run: `npm test` (from the Atlas worktree)
Expected: PASS, 0 failures, count equal to the pre-M7 baseline plus `tests/scaffold.test.mjs`'s
own tests.

- [ ] **Step 2: Run the scaffold CLI against a fresh copy of the fixture, end to end, not just via the test harness**

```bash
cp -r fixture /tmp/atlas-m7-e2e-fixture   # or the platform-appropriate equivalent; do not touch
                                            # the real fixture/ directory
node src/scaffold.mjs /tmp/atlas-m7-e2e-fixture ready-slug
node src/build.mjs /tmp/atlas-m7-e2e-fixture /tmp/atlas-m7-e2e-out --offline --quiet
```

Expected: the scaffold succeeds and prints the two written paths; the subsequent `node
src/build.mjs` run against that now-modified fixture **succeeds** (proving the scaffolded
manifest is not just schema-valid in isolation but actually buildable end to end) and the built
output contains a page for `ready-slug` with the placeholder title/gate text visible verbatim —
confirm with a `grep -r "M7 scaffold" /tmp/atlas-m7-e2e-out` that returns at least one match, so
the placeholder's visibility-on-the-live-site claim from the spec is actually demonstrated, not
assumed.

- [ ] **Step 3: Clean up the temporary directories**

```bash
rm -rf /tmp/atlas-m7-e2e-fixture /tmp/atlas-m7-e2e-out
```

- [ ] **Step 4: Report**

No commit for this task (verification only) — record the two commands' output in the task's
completion report so a reviewer sees the real end-to-end proof, not just "tests pass."

---

## Self-review

**Spec coverage.** Item 1 (scaffold) → Task 1, every precondition and both write targets named
explicitly. Item 4 (entry-bar rule) → Task 2. Items 2 and 3 → the spec itself states they are
already satisfied; this plan does not re-build either, and Task 3's end-to-end run is the closest
thing to a regression check that the M4.1-shipped "No milestones yet" signal (item 3) still shows
correctly, without dedicating a task to re-testing something M4.1 already tests.

**Placeholder scan.** No task contains "TBD" or "add appropriate handling." Every code block is
complete, runnable code, not a description of code. Task 1 Step 1 leaves an open decision (extend
`fixture/` vs. a new fixture directory) but gives the implementer a concrete decision procedure
(grep for hard-coded counts) rather than leaving it to guesswork — that is a real, disclosed
choice-point with a stated resolution rule, not a placeholder.

**Type/signature consistency.** `checkPreconditions({ projectRoot, slug }) → { ok, reason? }` and
`scaffoldWorkstream({ projectRoot, slug }) → { ok, written?, reason? }` are used identically in
Steps 2, 6, and 10 — Task 1's own test file never diverges on field names between them.
`main(argv)` and `parseArgv(argv)` match `src/build.mjs`'s own signatures exactly (Global
Constraints names the file and line range this plan copies the shape from, per
`docs/MILESTONE_EXECUTION.md`'s own step 12b: cite the path, not a description of it).

**Cross-repository hazard, named explicitly.** Task 2 operates in the Vennusign repository; Tasks
1 and 3 operate in the Atlas repository. This is called out in Task 2's own file list and Step 1
instructions specifically because this plan's own controller session has, earlier in this
project's history, collided two pieces of git work in one shared directory by not being explicit
about which repository a task touches (see `docs/MILESTONE_EXECUTION.md` steps 7a/7b) — Task 2
is deliberately the most likely task in this plan to get run in the wrong working directory if a
dispatch brief does not say so plainly, and now it does, twice.
