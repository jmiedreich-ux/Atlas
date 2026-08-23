# Atlas M7: a design becomes a tracked feature

**Status:** owner-approved in conversation, 2026-08-23 (session continuing the M4.1 rebuild).

## Why

Four workstreams on the live sheet — Theme Studio, Platform Operations, Onboarding, Screens — sit
at `designing` stage with zero milestones and a design authority still under
`docs/design/proposed/<slug>/` rather than `docs/design/approved/<slug>/`. There is no
Atlas-aware path from "a design exists in `proposed/`" to "this feature has real milestones on the
sheet" — today that gap is closed entirely by hand, by someone following the M1–M4 pattern by eye.

Asked what M7 should build to close this, the owner confirmed four things, all in scope (his exact
words: "all of those sound good"):

1. A scaffolding tool that cuts the manual boilerplate of hand-authoring a first
   `workstream.json` entry and milestone plan.
2. A documented process for what "approving" a design authority requires.
3. A build-time signal for a workstream stuck at `designing` with nothing on record.
4. A rule for what has to be true **before** something is written into `docs/design/proposed/`
   at all — not just the proposed→approved step.

## What already exists — read before designing anything new

Two things are already load-bearing here, and this milestone extends them rather than
duplicating them:

* **`docs/design/proposed/README.md`** (Vennusign repo) already states, per entry: *"Approval
  rule: repository presence does not constitute design approval. Implementation RWPs may
  reference this as approved only after explicit owner confirmation."* — the proposed→approved
  rule already exists, item by item.
* **`docs/MILESTONE_EXECUTION.md`** step 3 (Vennusign repo) already gates implementation on it:
  *"Confirm the design authority is approved and landed in `docs/design/approved/<feature>/`. If
  it is still in `proposed/`, stop — implementation is not authorized."*

So items 2 above is **substantially already written** — M7's job for it is to make the existing
rule *discoverable at the point someone would need it* (from Atlas's own gate text, and from a
cross-reference in the SOP), not to invent a second version of it.

Item 3 is **already shipped**, incidentally, by the M4.1 follow-up round that landed just before
this spec was written (Atlas `v1.4.1`, `theme/_includes/depth.njk`): a workstream with
`column.milestoneCount === 0` now renders `"No milestones yet"` on its own accordion row instead
of leaving that space silent. That is exactly "a build-time signal that a workstream has nothing
on record" — visible, unconditional, no date threshold needed because none is invented. **M7 does
not re-build this.** It is recorded here so nobody re-scopes it, and because item 1's gate text
(below) is what upgrades that bare signal into something actionable.

That leaves items 1 and 4 as this milestone's real new work.

## A hard constraint that shapes item 1 entirely

**Write-back cannot produce a scaffolding tool.** `api/lib/contract.mjs`'s `whyNotAWritableRecord`
refuses any write whose last path segment is `workstream.json` by name (*"is a workstream
manifest, and decision 35 keeps manifests out of Atlas entirely"*), and a milestone plan file
sits directly under a workstream's own directory, which the same function's segment check would
also have to specifically allow — nothing under `docs/features/<slug>/plan-file.md` is currently
listed as an accepted acceptance-record path shape either. **Decision 35 is deliberate, not an
oversight**: Atlas's site can trigger exactly two writes (a register answer, an acceptance
result), and a manifest or a plan file is neither.

So the scaffolding tool in item 1 **cannot be an on-screen action on atlas.vennusign.com**. It has
to be a local script, run by a human or an agent against a real checkout, whose output is
committed through the ordinary git flow — the same way `node src/build.mjs` is already run
locally and in CI, never from a browser.

## Item 1: the scaffolding script

**Where it lives:** the `Atlas` repository, as a new `src/scaffold.mjs`, generic and
project-agnostic like every other module in `src/` (decision 40: the generator holds no project
content). It takes a project root and a workstream slug, not anything Vennusign-specific.

```
node src/scaffold.mjs <project-root> <workstream-slug>
```

**What it can mechanically know, and what it cannot.** A script has no judgment about what a
feature's first real milestone *should be* — that is a human or an agent reading the approved
design and deciding, the same work M1 through M4.1's plans all required by hand. What a script
*can* do reliably is the boilerplate that is pure structure: a schema-valid `workstream.json`
entry with every required field present and correctly typed, and a milestone plan file matching
the shape `docs/features/atlas/m2-plan.md` and its siblings already establish (`# <Feature>
Milestone 1 — <title>`, the "before/after" status banner, Goal/Where it will land/Spec headers).
So the scaffold produces a **valid, obviously-incomplete starter** — not invented content — with
placeholder text that fails a human reviewer's eye on sight (`"<< M7 scaffold: replace this line
— see docs/design/approved/<slug>/ >>"`), not a plausible-sounding guess.

**Preconditions, checked before anything is written, refused by name on failure (decision 32's
discipline applied to a CLI, not only to the build):**

* `docs/design/approved/<slug>/` exists and is non-empty in the target project root. If the
  design is still under `proposed/`, the script refuses by name and points at
  `MILESTONE_EXECUTION.md` step 3 rather than writing anything.
* `docs/features/<slug>/workstream.json` does not already exist. The scaffold is for a feature's
  *first* milestone; a workstream already on record is out of scope for this tool and the script
  says so rather than silently overwriting.
* The workstream's `stage` is `designing` (`WORKSTREAM_STAGES`, `api/lib/contract.mjs`) — the
  scaffold is specifically for the "approved, not yet on the sheet" gap this milestone closes, not
  a general-purpose manifest editor.

**What it writes, given a slug that passes the checks above:**

* `docs/features/<slug>/workstream.json` — `codename` titleized from the slug (a human renames
  it if the casing is wrong — `codename` is free text, not derived from anything canonical);
  `stage: "designing"` (unchanged — scaffolding a milestone does not itself approve the feature
  past design); `what`, `position`, `gate`, `design` all placeholder text naming exactly what to
  fill in and from where (`gate` placeholder literally says *"Owner: replace this. What is
  actually blocking work from starting, in one sentence."*); `milestones: [{ id: "M1", label:
  "M1", depth: 1, title: "<< replace — see the approved design >>", status: "unplanned", plan:
  "m1-plan.md", issue: null, pr: null, acceptance: { kind: "demo-script", record: null } }]` — the
  one milestone entry validates against `src/schema.mjs` exactly as written, so the very next
  build either succeeds with the placeholder text visible on the live site (impossible to miss)
  or the human has already replaced it.
* `docs/features/<slug>/m1-plan.md` — headers only, each with a one-line instruction in place of
  content: Goal, Where it will land, Spec (naming the approved design's own path so the writer
  does not have to go find it again).

**Finished when:** running it against a slug with an approved design and no existing manifest
produces a build that succeeds (placeholder text and all — decision 32 does not forbid a
placeholder *string*, only a missing required *field*); running it against a slug still in
`proposed/`, or one that already has a `workstream.json`, refuses with a message naming which
precondition failed and does not touch the filesystem; and a hand-fixture project exercising both
the success path and both refusal paths is the test.

## Item 4: the entry bar for `docs/design/proposed/`

**Where it lives:** `docs/MILESTONE_EXECUTION.md` (Vennusign repo) — not Atlas code. This is
process, the same category as steps 1–34 already there, and belongs in the same table rather than
a second document nobody reads.

**The gap, stated plainly.** Step 3 already gates *implementation* on approval. Nothing gates
*proposing* — a file can land under `docs/design/proposed/<slug>/` with no check that the
workstream directory it names even exists, that it doesn't collide with something already
proposed, or that whoever wrote it read the existing entries first (`proposed/README.md` has
five entries already; a sixth written without reading the other five risks contradicting one).

**The new step**, inserted into Phase A (before touching anything) — numbered relative to the
existing table, exact position decided by the implementer against the file's real current
numbering, not invented here:

> Before writing anything into `docs/design/proposed/`: confirm the workstream directory it names
> either already exists under `docs/features/` or is a deliberate new one (not a typo of an
> existing slug); read `docs/design/proposed/README.md` in full for anything already proposed
> that overlaps; and add an entry to that README in the same commit, following its existing
> per-item shape exactly (Files, Status, Intended use, Approval rule) — a proposal with no README
> entry is not discoverable by the very process (M7's scaffold, a future reviewer) that will look
> for it there.

This is a **process addition**, not generator code — the plan for this milestone treats it as a
single, self-contained documentation task, reviewed the way any `docs/MILESTONE_EXECUTION.md`
change is (it already carries its own changelog convention at the bottom of the file, "Steps N
were added on `<date>`, after..." — this addition follows that same convention, including a
plain statement of what gap it closes, matching 7a/7b's own entries).

## What ships, and where

| Piece | Repo | Kind |
|---|---|---|
| `src/scaffold.mjs` + its tests | Atlas | new generator-adjacent CLI script |
| The entry-bar step | Vennusign | `docs/MILESTONE_EXECUTION.md` addition |
| The build-time signal (item 3) | — | already shipped, M4.1 follow-up round, no new work |
| The approval process (item 2) | — | already exists (`proposed/README.md`, step 3); this
  milestone cross-references it from the scaffold's own refusal message rather than restating it |

## Deliberately excluded

* **Anything that infers milestone content from the approved design's prose.** That is a
  judgment call, not a mechanical transform — see "what it can mechanically know" above. A future
  milestone might reasonably hand this to an agent rather than a human; this one does not attempt
  it.
* **A second write-back-writable thing.** The hard constraint above is not worked around by, say,
  queuing a scaffold request through write-back for a human to run later — that reintroduces the
  exact manifest-write decision 35 already closed, wearing an indirection. If the owner wants
  on-screen scaffolding later, that is a new decision to make explicitly, not a corner this
  milestone cuts.
* **Updating Atlas's own `docs/features/atlas/workstream.json`** to record M7 itself. That happens
  once M7 actually ships, the same way M4.1 was recorded after the fact — not part of this plan.

## Decisions this milestone rests on and creates

It rests on **1** (built from source — the scaffold produces structure, never invented content),
**32** (closed vocabularies and named refusals, applied here to a CLI's preconditions rather than
only the build), **35** (write-back's two writable things, and no third — the reason item 1 must
be a local script), and **40** (the generator holds no project content — why `scaffold.mjs` is
project-agnostic). It does not create a new numbered Atlas decision on its own; the entry-bar step
is a Vennusign house-process addition, not a generator decision.
