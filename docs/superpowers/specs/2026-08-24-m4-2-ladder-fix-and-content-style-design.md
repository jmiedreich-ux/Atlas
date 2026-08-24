# Atlas Milestone 4.2: the ladder handles a gap, and status text stops narrating

**Why M4.2, not a fresh top-level number, not folded into M5.** SOP step 2b
(`docs/MILESTONE_EXECUTION.md`, Vennusign repo) requires a stated reason before work goes out of
the planned M5/M6 order, recorded where it happens. The reason here: the owner tested M4.1's
just-shipped accordion+spine page live and found real defects on that same surface — a `tipLabel`
that resolves to nothing and falls back to a wall of prose, and content on that page he flatly
rejected the style of. Both are M4.1's own surface, not M5's (the Q&A register) or M6's (tasks as
GitHub issues). Fixing them now, before M5 starts, is the valid reason; the sub-milestone number
(`M4.2`, decision 18's own form — the way M2.1 and M4.1 both were) is how that reason gets recorded
rather than asserted.

## What actually broke, read from the real code

`src/depth.mjs`'s `computeLadder` computes a `tipLabel` for the collapsed row's "next" text
(wired to `theme/_includes/depth.njk`'s `feature-next` span, added in the M4.1-followups round: "Next:
`{{ tipLabel }}`" when present, bare `{{ manifest.gate }}` prose otherwise). `tipLabel` is derived
from `headPosition = barRows + 1`, and `barRows` is `preMilestoneCoveredCount(stage) +
finishedDepth(milestones)` — the DEEPEST `done` milestone's depth, not a contiguous count (M2.1's
own decision: a parked milestone with later work shipped past it must not zero out the bar).

Atlas's own manifest today: M1–M4.1 done (depths 1–6), M5–M6 `unplanned` (depths 7–8), M7–M8 done
(depths 9–10). `finishedDepth` returns 10 (M8, the deepest done milestone) — correct, by M2.1's own
rule. `headPosition` becomes 14, `depth = headPosition - 3 = 11`. **Depth 11 does not exist.**
`milestoneAtDepth` returns `null`, `tipLabel` is `null`, and the template falls back to the full
`gate` sentence — which is what the owner saw and rejected ("just include the milestone name,
thats all no text about").

**The real defect is not the null-fallback (that already existed, correctly, for the "nothing
recorded beyond this point" case M2.1 documented).** It is that `finishedDepth`'s "deepest done"
rule, built for the *parked* case (work went round a milestone, kept shipping, the bar should not
stop dead), is now also swallowing a *different* case it was never meant to cover: M5 and M6 are
not parked. Nothing worked around them. They are simply not started — sitting earlier in the
sequence than milestones that, out of order, already are. `skippedBehind` (the function that draws
the crossed "work went round it" marker) currently treats both cases identically: "behind the
completed edge and not done" — which means M5 and M6 today render with the same visual language as
a genuinely parked, abandoned milestone. That is wrong on its own terms, independent of the
tip-label bug: M5 has a complete six-task plan on record. It has not been abandoned.

## The fix

**Two milestone-completion patterns are genuinely different and the code must say so, not infer
it from position alone:**

1. **Parked** (`status: 'parked'`) — work went round it on purpose, later milestones shipped, the
   bar correctly does not stop. `skippedBehind`'s crossed-marker treatment is right for this case
   and does not change.
2. **Queued behind out-of-order work** (`status: 'unplanned'` or `'blocked'`, sitting at a
   shallower depth than a `done` milestone) — nothing worked around it; it just has not started
   yet, and something numbered later got done first (the exact situation SOP 2b now exists to
   prevent going forward, but M7/M8 already happened this way once). This is not the ladder's
   "detour" case. It needs its own name in the record, and its own head position: **the ladder's
   head should point at the EARLIEST non-`done`, non-`parked` milestone in depth order — not one
   past the deepest `done` milestone — whenever that earliest milestone exists.** That is the
   honest "what's actually next" a reader following the plan in order would ask for, independent
   of what shipped out of turn later.

**Concretely, in `computeLadder`:**

- Add `earliestOpenDepth(milestones)`: the shallowest depth among milestones whose status is
  neither `'done'` nor `'parked'` (mirrors `finishedDepth`'s shape — same reduce pattern, opposite
  direction). Returns `null` when every milestone on record is `done` or `parked` (nothing open —
  today's behavior for a workstream with no gap is unaffected).
- `headPosition` becomes: if `earliestOpenDepth` exists AND is `<= finishedDepth` (i.e., there is
  an open milestone at or behind the deepest-done edge — the gap case), point the head at
  `earliestOpenDepth`'s row instead of `finishedDepth + 1`. Otherwise, unchanged (today's
  `finishedDepth + 1` logic, covering both the normal contiguous case and the "nothing open behind
  the edge, next real depth has no record yet" case that already correctly nulls `tipLabel`).
- `tipLabel` in the gap case resolves to that milestone's own `label` — never `null`, never
  falling back to prose, because a real milestone with a real label is what the head is now
  pointing at.
- `skippedBehind` gets a second filter: it already excludes `m.status === 'done'`; it now also
  excludes whichever milestone `earliestOpenDepth` identified as the new head target, so that
  milestone is not simultaneously drawn as "next" AND as a crossed skip-marker. Everything else
  behind the edge that is not `done` and not the head target (i.e., genuinely `parked`, or a
  second gap milestone behind the first) keeps the existing skip treatment — this milestone does
  not attempt to solve N-deep nested gaps beyond naming the first one; SOP 2b's whole point is that
  this should not recur, so designing for arbitrary depth here would be solving a problem the
  process fix already addresses.

**What does not change:** `finishedDepth`/`barRows`/`covered`/`completedCount` — the bar's own
length and the "N of M complete" count are untouched. The gap case only changes where the *head*
(and therefore `tipLabel`) lands. A workstream with no gap renders byte-identical to today.

## `docs/features/atlas/workstream.json` after this fix

With the change above, Atlas's own column: `finishedDepth` = 10 (M8, unchanged), but
`earliestOpenDepth` = 7 (M5) and 7 ≤ 10, so `headPosition` targets M5's row. `tipLabel` = `"M5"`.
The collapsed row will read **"Next: M5"** — exactly what the owner asked for, and honestly: M5 is
the actual next thing to do, which is the whole point of SOP 2b existing.

## Content style: `position` and `gate` stop narrating

**The owner's words, verbatim, because paraphrasing them would soften the actual instruction:**
"I don't read paraghraphs of text... I don't need to know how tings got there or what, I need
concise points of where we are... its needs to be informaiton that is only important and
actionable" — and, shown Atlas's own fields specifically: "not some ramond AI speak."

**This is not a general problem — it is Atlas's own entry, specifically, drifting.** Measured
directly: `docs/features/atlas/workstream.json`'s `position` is 1,893 characters, `gate` is 1,104.
Every other real manifest is already short and current-state-only:

| Workstream | `position` | `gate` |
|---|---|---|
| keystone | 93 chars | 185 chars |
| menus | 48 chars | 202 chars |
| onboarding | 85 chars | 82 chars |
| platform-operations | 97 chars | 162 chars |
| screens | 86 chars | 83 chars |
| theme-studio | 144 chars | 125 chars |
| **atlas** | **1,893 chars** | **1,104 chars** |

Keystone's `gate`, for reference, at 185 characters: *"Owner approval of the design authority,
which is still in docs/design/proposed/keystone/ and must move to approved/ before M1 starts. Tier
and plan cost are deferred: provision nothing."* Two sentences, present tense, no history, no
reasoning about how it got that way. That is already the right shape. Atlas's own entries accreted
history with every milestone shipped this session — each rewrite appended more of "how we got
here" instead of replacing it with "where we are now."

**Decision: this milestone fixes Atlas's own entry to match the six already-correct manifests, and
adds a structural guard so the drift cannot silently recur — it does not rewrite the other six,
because they are not broken.** The guard: `src/schema.mjs`'s `validateWorkstream` gains a length
check on `position` and the renamed `next` field (see below) — 240 characters each, chosen with
headroom above Keystone's 185-character `gate` (the longest already-good real example) and firmly
below anything narrative. Over the limit fails the build by name (decision 32's own pattern —
`"position" must be 240 characters or fewer (got 1893) — state where things stand, not how they
got there`), the same way an unknown status or a missing plan file already does. A soft convention
would have let Atlas's own entry drift three separate times this session; a hard, cited limit is
the only thing decision 1's own philosophy ("built from source, never maintained... hand-authored
twice") would call durable here.

## Renaming `gate`

**The owner's words:** "I said many times I hate the word gate... so I don't want this in some
ramond AI speak." Standing feedback, not a one-off.

**Chosen replacement: `next`.** Reasoning: the field means "what's next for this workstream" in
every real example read (Keystone's is literally "before M1 starts"; Atlas's, once rewritten, will
be "M5" plus what's needed for it) — and the UI already independently arrived at the exact word
"Next:" as the prefix for the accordion's own tip-label text (`theme/_includes/depth.njk`,
M4.1-followups round). Naming the field what the UI already calls the concept it holds is the
`docs/MILESTONE_EXECUTION.md` step 12b principle applied to a schema key: cite what already exists
rather than inventing a second name for one thing. Considered and rejected: `blocked_by` (wrong
when nothing is blocking — Atlas's own gate text routinely says "nothing new blocks..."; the field
must hold a value even when nothing blocks, per decision 32's `requireString`), `waiting_on` (same
problem, plus multi-word keys don't match this schema's existing single-word convention:
`codename`, `what`, `stage`, `position`), `status_note` (accurate but generic — doesn't say what
kind of status). `next` does collide in spelling with `MILESTONE_STATUSES`'s `'next'` value (a
different vocabulary, milestone status vs. workstream field name) — noted here explicitly so a
future reader does not mistake the coincidence for a schema conflict; there is none, they are
different keys entirely (`milestone.status === 'next'` vs. `workstream.next`).

**This is a hard rename, migrated everywhere in this milestone — no back-compat shim.** Decision 1
means every manifest is source, not a deployed artifact with external consumers; decision 32 means
an old `gate` key left in a manifest should fail the build loudly (unknown/missing required field),
not be silently accepted by a compatibility branch. Touches, confirmed by direct grep, not
assumed: `api/lib/contract.mjs`'s field-name comment (line 24, which already explicitly reserves
the word "gate" for this field and needs updating to reserve `next` instead — and note the
*milestone-status* vocabulary (`MILESTONE_STATUSES`) already chose `blocked` over `gated` for
exactly this reason ("the word 'gate' belongs to the workstream's own `gate` field," per the same
comment, which cites **#780** for that choice), so the rename actually removes a piece of legacy
tension rather than creating one), `src/schema.mjs`
(`requireString(obj, 'gate', ...)` → `'next'`), `src/state.mjs` line 89 (`gate:
stream.manifest.gate` → `next: stream.manifest.next`), `src/depth.mjs` (the `note: gate` column
field, and the `{ codename, stage, gate, milestones }` destructure), `theme/_includes/depth.njk`
(the `feature-next` fallback, `stream.manifest.gate` → `stream.manifest.next`), `theme/_includes/
mobile.njk` (`card-gate`/`card-gate-label` classes and their `Gate` label text — becomes `Next`),
`theme/_includes/workstream.njk` (`gate-callout` class and its `Gate` label — becomes `Next`),
`theme/tokens.css` (`.card-gate`, `.card-gate-label`, `.gate-callout` selectors — renamed to match,
styling unchanged), every one of the 9 test files a direct grep found referencing `gate`
(`config.test.mjs`, `scaffold.test.mjs`, `state.test.mjs`, `swa.test.mjs`, `build.test.mjs`,
`schema.test.mjs`, `triage.test.mjs`, `depth.test.mjs`, `theme.test.mjs`), and every real manifest
— all seven in the Vennusign repo, plus every fixture manifest in Atlas's own `fixture/` directory
and every hand-built manifest fixture inside the test files themselves (`entry()`/`milestone()`
helpers and inline literals in `tests/theme.test.mjs` and others already use `gate:` as a field
key — those are test doubles, not the schema, but they still need updating or `validateWorkstream`
will reject them once `'next'` is required and `'gate'` is not accepted).

## `position`/`gate` stay a plain string, not a structured field

Considered: turning `position`/`next` into an array of short strings (structurally impossible to
write a paragraph into). Rejected for this milestone: the demonstrated problem is Atlas's own
authoring discipline, not the string type — six of seven real manifests already hold to a concise
style in plain strings, and a length cap (above) is a smaller, more surgical fix than a schema
shape change that would require rewriting every template that reads these fields and every real
manifest's structure, for a problem a length check already solves. Revisit only if the length cap
alone proves insufficient in practice — not assumed here.

## Deliberately excluded

- Rewriting the six already-concise manifests' `position`/`gate` (now `next`) content — not
  broken, not touched beyond the mechanical key rename.
- Any change to `finishedDepth`, `covered`, `completedCount`, or the bar's own rendered length —
  the gap fix only changes where the head/tipLabel points.
- Solving nested/multiple gaps beyond the first open milestone — SOP 2b's process fix is what
  prevents this from recurring; this milestone names the first gap honestly and stops there.
- Any change to `MILESTONE_STATUSES` or the milestone-status vocabulary — the earlier
  "needs a status between unplanned and blocked" question (a milestone that's fully planned but
  not started) is a separate, real, un-scoped gap, noted but not fixed here.

## Decisions this milestone rests on and creates

Rests on **1** (built from source, no hand-maintained-twice authoring — the length cap exists
because a soft convention already failed three times), **17** (milestone ids durable — unrelated
to this rename, cited so nobody conflates a milestone id with a workstream field), **18** (`M<n>.1`
form, why this is M4.2), **20** (per-workstream milestone numbering, why the gap fix must not
assume any two workstreams share depth semantics), **32** (closed vocabulary,
fail-loudly — both the length cap and the hard `gate`→`next` rename apply this). Creates no new
numbered decision on its own; if a numbered record is wanted for the length-cap rule specifically,
that is an authoring call for whoever lands this plan, not asserted here.
