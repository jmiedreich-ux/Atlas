# Feature planning rebuild: design

**Status:** approved by the owner in conversation, 2026-08-22/23. Written up here for the
implementation plan to argue from. Supersedes the parts of #780 named below.

## Why

#780 built the feature-planning page as a drawn SVG chart: one ribbon per feature descending a
shared depth ladder, dates and duration beside every dot, a shared gutter column for milestone
numbers. Live use surfaced two problems that kept compounding rather than resolving with small
fixes:

* Dates and duration clutter the page without answering the question the page exists for — the
  fixture and the real site both show pages of identical or near-identical single-day spans,
  because that is what a project actually looks like when many milestones close close together.
  The owner's ruling: drop dates and duration entirely. The milestone is the axis; nothing is
  scheduled against a calendar here.
* A milestone that has been inserted or renumbered (Atlas's own M2.1; Menus' M3.1, M6.1–M6.3) has
  no honest place to say so under #780's rule that "milestone identifiers live in the ladder
  column and nowhere else" — the ladder gutter is one shared positional scale and cannot carry a
  second numbering system.

Both problems, plus the owner's separate observation that milestones already carry real task
lists (GitHub issue checklists) that the current site does not render at all, led to a UX
exploration (`claude.ai/design`, project `b86c3976-018e-4476-ae7e-49663302765c`, file "Feature
Planning Directions.dc.html") rather than another patch to the chart. The owner picked and
combined pieces of that exploration; this document is that combination, made concrete against
Atlas's actual code and data.

## What's retired, what stays

**Retired:**

* `src/chart.mjs` in full — the ribbon/arrow/dot/balloon coordinate geometry, and everything in
  it that exists only to serve that geometry (`wrapText`, `dateLines`, `headHalfWidth`, the whole
  SVG layout).
* The desktop `theme/_includes/depth.njk`'s SVG rendering — replaced outright (see below). The
  file keeps its name and route (`/`) but not its content.
* The per-feature triage **modal** introduced in M4. Expanding a feature row now shows the same
  information (what needs the owner, position, gate) directly, in place — a second way to reach
  identical content is a UI decision this rebuild removes rather than carries forward.
* `theme/order.js`'s SVG-lane dragging (it moves a `<g>` by rewriting one `transform`). The
  *behaviour* it implements — drag to reorder, arrow keys to reorder, `H` to hide, per-device
  persistence in `localStorage`, an announcement region for screen readers — is kept and
  reimplemented against ordinary HTML rows, because there is no ribbon lane to transform any more.

**Kept, unchanged:**

* `src/depth.mjs` / `computeLadder` — mobile (`/mobile/`, being rebuilt below) and `state.json`
  both read `column.covered`, `column.completedCount`, `column.milestoneCount`, and
  `column.tipLabel` from it today, and the new desktop accordion's per-feature progress strip
  reads the same fields. Nothing about the ladder's *computation* changes, only who draws from it.
* `src/triage.mjs` — `classifyTriage` and `TRIAGE_ORDER` are the real, tested classification
  (decision 27) and drive the new mobile page directly (see 1c below). Unruled semantics stay
  unruled; this rebuild does not touch the mapping, only its presentation.
* `src/schema.mjs`, `MILESTONE_STATUSES`, `WORKSTREAM_STAGES` — the closed vocabularies are
  unchanged. The new milestone spine renders the same five statuses (`done`, `next`, `blocked`,
  `parked`, `unplanned`) it always had; only the visual treatment (icon + colour on a vertical
  line, matching the mockup's CLOSED/SKIPPED/IN PROGRESS/CAN'T START framing) is new.
* The `started`/`completed` date fields stay in the schema — write-back and any future surface
  may still want them recorded — but no page renders them any more. This is a *display* rule, not
  a schema change: nothing here removes or deprecates the fields themselves.

## Surface 1: Feature Planning (desktop, `/`)

An accordion: one row per feature, collapsed by default. This is mockup **2a**.

**Collapsed row**, left to right:
* A disclosure indicator (▸/▾) and the feature's codename.
* A stage chip (`Shipping`/`Designing`/`Planned`/`Not started` — `WORKSTREAM_STAGES`, via the
  existing `chip()` macro).
* A milestone progress strip: one dot per milestone, filled for `covered` (reusing
  `column.covered`/`completedCount`/`milestoneCount` exactly as `mobile.njk` already does — no
  new computation).
* A one-line "next" sentence: `column.tipLabel` if present, else the workstream's `gate` text
  (same fallback mobile already uses via `card-gate`), else nothing when the feature has shipped
  everything on record.
* A right-aligned "waiting on" tag: `{{ chip('triage', stream.triage) }}` — the exact same macro
  and label vocabulary `mobile.njk` already renders ("Waiting on you", "Moving", "Blocked",
  "Designing", "Not started"). Not reinvented: 1a's separate `dev`/`design`/`Keystone`-name
  "Waiting" column doesn't survive, because it was hand-authored narrative for the demo rather
  than something `classifyTriage` actually produces, and 1a is dropped in full (below).

Rows are **draggable** to reorder, exactly like today's desktop drag: pointer drag, arrow-key
reorder while focused, `H` to hide, an `aria-live` region announcing moves, order and hidden-set
persisted to `localStorage` per device (same caveat text already on the page: "remembered on this
device only"). The mechanism is reimplemented against real DOM rows (see Implementation notes)
rather than SVG transforms; the *contract* — what persists, what the keys do, what gets announced
— does not change.

**Expanding a row** reveals that feature's milestone spine inline, directly beneath it (not a
navigation, not a modal) — mockup **2b**, nested rather than standalone.

## Surface 1, expanded: the milestone spine

A vertical line of milestones for the one expanded feature, closed → skipped → in-progress →
not-yet-reached, top to bottom in ladder order.

Each milestone node:
* An icon on the line: filled circle for `done`, a ring for `next` (the live one — same "hollow"
  visual language the old chart used for its live dot), and a solid colored dot per status for
  `parked`/`blocked`/`unplanned` — colour distinguishes them from each other, but never carries
  the status alone: the adjacent status chip labels every state in words on every node, the same
  redundancy #780 required of the retired chart. (Shipped: an earlier draft of this spec asked for
  a literal crossed marker on `parked` and a dashed outline for not-yet-reached milestones; ruled
  during the final branch review that the colored-dot-plus-chip treatment already ships makes no
  information depend on colour alone, so the distinct glyphs added complexity without adding
  meaning. Revisit only as a deliberate visual-polish pass, not a correctness fix.)
* The milestone's own **label** — `M3`, `M2.1`, `M6.1` — always shown here, on the node itself.
  This is the resolution of the divergent-label problem the last round patched narrowly: the
  spine has no shared ladder gutter to conflict with, so every milestone says its own real label,
  not only the ones that diverge from a generic position. The narrow per-dot-label exception added
  to `src/chart.mjs` in the previous round is retired along with the rest of that file — this
  design doesn't need it, because the constraint it was working around (#780's "identifiers live
  in the ladder column and nowhere else") no longer applies to a page with no ladder column.
* The milestone's `title`.
* **No dates, no duration, anywhere in this view.**

How much of a milestone's task list shows is graduated, matching the mockup's own (cross-feature)
demo exactly, adapted to one feature's own milestone sequence:

* `done` and `parked` (skipped) milestones collapse to a single line — icon, label, title, status
  tag — never a checklist. Re-litigating a closed milestone's task-by-task history is not what
  this page is for.
* The **current** milestone (`status: next` — there is at most one per feature, the same
  convention the retired chart's `liveIndex` used) always shows its full flat task list, expanded.
* The **one milestone immediately after it** in depth order (the next `unplanned` one on record,
  if any) also shows its full task list, expanded but visually muted (dimmed, matching the
  mockup's `opacity:.65` treatment) — the "what's coming" preview.
* Any milestone further out than that collapses to a single line with just a task count
  (`N sub-tasks`) when it has tasks on record, or nothing beyond its title when it doesn't —
  matching the mockup's own real M2 row ("3 sub-tasks · ..."), never a call-to-action to add one:
  Atlas has no authoring UI and decision 1 means a milestone with no plan on record simply isn't
  drawn with an invitation to create one.

Each expanded checklist line is a checkbox row — done tasks struck through — each optionally
carrying an owner tag, "Unassigned" when absent. Milestones with nothing to show beyond their
status (no tasks parsed, or collapsed per the rule above) render as a single line — no empty
checklist section, no placeholder text.

**Task rows within an expanded milestone's checklist are also draggable to reorder.** This is a
per-device display preference only, the same `localStorage` contract feature rows already use —
task order as parsed from the issue checklist is the record; dragging never writes back to GitHub
and never changes what the checklist "really" says. Milestones themselves are never draggable:
a milestone's position is `depth`, a fact from the manifest, not a client-side preference.

## Task lists: source and parsing

**Source.** A milestone's tasks are the checklist already inside the body of its linked GitHub
`issue` — real data that exists today; the known, previously-flagged gap is that Atlas currently
renders that checklist as literal `- [x]` text instead of parsing it. This rebuild fixes that gap
and is the *only* new data source it introduces.

**Fetch.** `src/github.mjs`'s existing `fetchProjectIssues` only requests **open** issues
(`state=open`) — a milestone marked `done` almost always has a *closed* issue, so its checklist
would never arrive through that call. A new function is needed:

```
fetchIssueBodies({ repo, issueNumbers, token, fetchImpl })
  → Map<issueNumber, string | null>   // null on any per-issue failure
```

One request per distinct, non-null milestone `issue` number across every workstream
(`GET /repos/{repo}/issues/{number}`, which returns `body` regardless of open/closed state).
Bounded by "how many milestones this project has" (a few dozen at most today), not by the open
backlog, and it fails the same way `fetchProjectIssues` does: a network error or non-OK response
for one issue logs a warning and yields `null` for that issue only (never fails the build —
decision 32's stated exception extends to this call the same way it already covers the open-issues
fetch). `offline` mode skips it entirely, same convention as `emptyBuckets()`.

**Parsing.** A new module, `src/tasks.mjs`:

```
parseTasks(issueBody: string | null) → { text: string, done: boolean, owner: string | null }[]
```

* Reads GitHub task-list lines: `- [ ] ...` / `- [x] ...` (case-insensitive on the `x`), in
  document order. Anything else in the body is ignored — this parses a checklist, not the whole
  issue.
* **Owner tag**, optional, trailing: a line may end with an em-dash or hyphen and a name —
  `- [x] Write-back endpoint deployed — Claude`. The parser strips ` — <name>` /
  ` - <name>` (either dash, one or more trailing spaces before it) from the end of the line if
  present and returns it as `owner`; absent tag → `owner: null` (rendered as "Unassigned" per the
  mockup's own precedent — the M1/TenantContext "Backfill migration" row).
* **No closed vocabulary for `owner`.** Unlike `MILESTONE_STATUSES`, this is deliberately open —
  "for now it's Claude or ChatGPT, whatever we name them later" means the set of values changes
  without a schema update. `owner` is validated only as "a non-empty string or null", never
  checked against an enum, and never causes a build failure. This is the one place in this
  rebuild that intentionally does *not* follow decision 32's closed-vocabulary discipline, and
  it's worth being explicit about why: the vocabulary is genuinely unstable right now, the same
  reasoning `src/triage.mjs` already documents for its "deliberately unruled" mapping.
* A task assigned when it is created has no owner tag until it is actually delegated out — the
  parser does not require or infer one; a checklist item with no trailing tag is simply
  unassigned, at any status, forever if it's never delegated.
* Sequential and flat, always — no nesting. If a future issue's checklist itself contains
  indented sub-items, they are read as ordinary top-level lines in document order (decision: don't
  build hierarchy the owner has explicitly said isn't needed yet; revisit if that changes).

**Wiring.** In `assembleSite` (`src/build.mjs`), after the existing `issues` fetch: collect every
milestone's non-null `issue` number across `resolved`, call `fetchIssueBodies` once (skipped
under `offline`, same as today), and attach `tasks: parseTasks(bodies.get(milestone.issue))` to
each milestone alongside the fields already assembled at line ~299 (`url`, `permalink`,
`planPath`, etc.). One fetch, one parse pass, no per-page recomputation — same "one model, both
pages and state.json render from it" discipline the module's own header comment states.

## Surface 2: "What needs you" (`/mobile/`, phone)

Rebuilt as **1c**: grouped by triage state, not a flat card list. This is a presentation change
over data `src/triage.mjs` already produces in full — `orderByTriage`'s output is already grouped
by state in sequence, `mobile.njk` just doesn't currently render section headers over the groups.

Five sections, `TRIAGE_ORDER`'s sequence, each header carrying the state's existing chip label
and a real count:

* **Waiting on you** (`awaiting-decision`) — cards as today (codename, what, position, gate).
* **Moving** (`moving`) — framed as "running, no action" (decision 27's own words for this state:
  "a milestone is in flight"), matching the mockup's "Running — no action" section honestly.
* **Blocked** (`blocked`)
* **Designing** (`designing`)
* **Not started** (`not-started`)

A section with zero cards is omitted entirely (mirrors the desktop accordion's "no empty task
section" rule).

**Deliberately not carried over from the mockup:** 1c also clusters cards *within* the
"needs a decision" group by a shared, hand-written blocking reason ("Approve a design authority —
unblocks 4"). That clustering was authored for the demo, not derived from real data — Atlas has
no structured field saying which gates share a cause, only free-text `gate` prose, and guessing
at similarity from that text is exactly the kind of thing decision 1 forbids ("built from source,
never maintained" — a similarity heuristic is a second, undeclared source of truth that can drift
from the real one). Each card keeps its own `gate` text in full; the honest version of this
feature is grouping by real triage state, which is what ships.

1a (the status-board table) is dropped in full — no page in this rebuild takes that shape.

## Data model summary (nothing here is a schema change — recap for the plan)

* `workstream.json` / `MILESTONE_STATUSES` / `WORKSTREAM_STAGES`: unchanged.
* New, computed only (never written back, never authored): `milestone.tasks: { text, done, owner
  }[]`, attached during `assembleSite`, sourced from the milestone's existing `issue` field.
* `started`/`completed`: unchanged in the schema, unused by any page after this rebuild ships.

## Implementation notes for the plan

* `theme/order.js`'s reorder/hide/announce *logic* (which element moves where, what persists,
  what gets announced) is real and should be lifted, not reinvented — only the "how a moved
  element repaints" half (today: rewrite an SVG `transform`) needs to change to "reorder real DOM
  nodes." The plan should treat this as one adaptation task per surface it now applies to
  (feature rows on desktop; task rows inside an expanded milestone), not a from-scratch design.
* `tests/chart.test.mjs` and the chart-specific assertions in `tests/theme.test.mjs` (everything
  keyed to ribbons, dots, balloons, `wrapText`, ladder gutter captions) are retired along with
  `src/chart.mjs`. New tests replace them: `tests/tasks.test.mjs` (parser), an extended
  `tests/github.test.mjs` (the new fetch, including its per-issue failure tolerance and offline
  skip), and rebuilt `tests/theme.test.mjs` coverage for the accordion, the spine, and the
  regrouped mobile page.
* Decision 40 (no layout names a person) is unaffected — `owner` values in practice today are
  agent identities (`Claude`, `ChatGPT`), not people, and the parser doesn't validate identity at
  all, so nothing here either enforces or violates that decision; it's simply out of scope for a
  string the generator doesn't interpret.
* This is a genuine "M5" for Atlas — sized like M1 through M4, not a patch. It should get its own
  entry in `docs/features/atlas/workstream.json` once real (i.e. treat this document the way
  every prior milestone's spec was treated, and expect the implementation plan to be a normal
  multi-task subagent-driven-development plan, not a quick-fix loop).
