# M6 reconciliation: what's still real after M4.1

**Status:** a decision document, not an approved spec. One question in here needs the owner's own
sign-off before this becomes a plan — see "The one real open question" below. Everything else is
a recommendation, not a decision already made.

## Why this exists

`docs/features/atlas/m6-plan.md` (Vennusign repo) was written before M4.1 shipped. M4.1 then
delivered a lighter version of M6's central promise — "tasks are GitHub issues, rendered inside
their milestone" — as an incidental part of a bigger rebuild, not as M6 itself. This document goes
through M6's plan piece by piece against what actually exists now, states what's redundant, what's
still real, and isolates the one place where M6's original design conflicts with something the
owner has explicitly said he wants, rather than just superseding an old plan quietly.

## What M4.1 actually shipped (the baseline this reconciles against)

`src/tasks.mjs`'s `parseTasks(issueBody)` reads GitHub task-list lines (`- [ ]`/`- [x]`) directly
from the body of the issue a milestone's own `issue` field already names — a field that has existed
since M1, not something M6 needs to add. Each line may carry a trailing owner tag (an em-dash,
en-dash, or hyphen, then a name), which is **never validated against a vocabulary** — the owner's
own words, quoted in the M4.1 spec: "for now it's Claude or ChatGPT, whatever we name them later."
Tasks render as a flat, sequential list inside the milestone spine (`theme/_includes/depth.njk`,
`.task-list`/`.task-line`), with visibility graduated by `src/depth.mjs`'s `spineDetail` — a done
or parked milestone shows none, the current one shows all, the one after it shows all but dimmed,
anything further out shows a count. This is live, tested, and the owner has used it directly.

## M6's plan, task by task, against that baseline

**Task 1 — the `workstream:*` label namespace.** Still real, and unrelated to everything below.
This task was never about the task-list rendering path at all — it's about `fetchProjectIssues`
(`src/github.mjs`), the open-backlog fetch that buckets issues by workstream label for triage
panels. M4.1's `fetchIssueBodies` is a completely different call, keyed by a milestone's own
`issue` number, and needs no label. M6's own recorded finding — "46 of 52 open issues carry no
label at all" — is still true and still a real gap in the triage/backlog surface. **Recommendation:
keep this as its own real piece of work**, scoped to what it always was (labeling the backlog),
not folded into a "task rendering" milestone it was never really part of.

**Task 2 — attribute an issue to a milestone, not only a workstream.** **Redundant, retire it.**
This task exists to solve a problem M4.1 solved a different way: a milestone already names its own
issue (`milestone.issue`, since M1), and `fetchIssueBodies` fetches exactly that issue, regardless
of open/closed state. There is no missing link left to build.

**Task 3 — the task row, a horizontally-scrolling grid (decision 26).** M4.1 shipped a different,
live, owner-tested visualization instead — the vertical spine, not a grid. Decision 26's "the
per-task cycle as rows" half was already recorded in M6's own plan as unfulfilled; that stays true,
but building a second, different task-visualization now would compete with something that already
works and that the owner has used without complaint. **Recommendation: do not build the grid.**
Decision 26 should be formally noted as superseded by the spine for the row-visualization half,
rather than left open as unbuilt work.

**Task 4 — sub-issues vs. checkbox text, and the defect that decision unlocks.** M6's plan flagged
that choosing checkboxes would reopen "#780's open defect that GitHub task lists render as literal
`[x]` text" and treated that as a reason sub-issues might be the easier path. **M4.1 already fixed
that exact defect** as the mechanism for shipping checkboxes — `parseTasks` is the fix. The
complication this task worried about no longer exists. **Recommendation: ratify checkboxes as the
chosen shape, retroactively — M4.1 already made and shipped this decision.** Native sub-issues
remain a real possible future upgrade (per-task comments, a native status, a native assignee
without inventing anything) but nothing about M6's original goal requires them now; they'd be new
scope with a new dependency, not a gap-fill.

**Task 5 — assignment: people are assignees, models are labels.** Splits into two genuinely
separate questions, one settled, one open.

- *Real GitHub assignee display for humans* — avatar, name, a working profile link — is something
  M4.1 does **not** provide. Its owner tag is a plain string regardless of whether the string names
  a person or a model; there's no actual GitHub identity behind a human name today. This is real,
  separate, non-conflicting work: wiring a task's real GitHub assignees (when the linked issue has
  any) into the rendered task line, alongside or instead of the text tag. **Recommendation: still
  worth doing**, independent of the question below.
- *A closed `agent:<name>` label namespace for model assignees, build-validated* — this is where
  M6's plan and what shipped directly disagree, not just supersede each other.

## The one real open question

M6's plan requires the model-assignee vocabulary to be closed and validated: "an unknown agent
name fails the build by name," "an issue carrying two `agent:` labels fails the build." M4.1
shipped the opposite on purpose, and the owner said so directly: an open, never-validated tag,
because the set of agent names is "genuinely unstable right now" (the same reasoning
`src/triage.mjs`'s own "deliberately unruled" mapping already uses elsewhere in this generator).
Picking M6's original design would not be superseding an old plan — it would be reversing something
the owner asked for by name, in this exact area, recently.

Three ways this could go:

1. **Keep the open vocabulary, drop the closed `agent:` label idea entirely.** Matches what's
   shipped and what was asked for. Costs: no build-time protection against a typo'd or unknown
   agent name — a task could say `— Cladue` and nobody would be told. Given the field already
   renders "Unassigned" for anything it can't parse rather than failing, a typo just reads as a
   slightly wrong name, not a broken page.
2. **A suggested set of names, surfaced in tooling (e.g. a CLI hint, a lint warning) but never
   build-validated.** Keeps the open door while catching obvious typos. Costs: a suggestion list
   that has to be maintained somewhere, and "suggested but not enforced" is a soft rule this
   generator otherwise doesn't have much of — decision 32's whole pattern is closed vocabularies
   that fail loudly, and a halfway version sits oddly next to that.
3. **Something else** — e.g., revisit this once the deployment agent (M8's own explicit exclusion)
   or a real dispatcher exists and there's an actual consumer that needs the vocabulary closed,
   rather than deciding it now for a system that doesn't exist yet.

**Recommendation: option 1.** The closed-vocabulary design was built for a dispatcher M6's own plan
already says "is not being built" (same section that marks its Task 6 as likely-skippable for the
identical reason). Closing the vocabulary now adds real friction — every new agent name needs a
build change — for protection against a failure mode (a typo) that already degrades gracefully
rather than breaking anything. This is a recommendation, not a decision; say which of the three (or
something else) you want before this becomes a plan.

**Task 6 — write the sub-task shape down, for a model to be assigned work against.** M6's own plan
already flags this as "the task most likely to be skipped, because nothing breaks if it is," and
its justification depends on the same not-yet-built dispatcher Task 5's closed vocabulary depends
on. Nothing about M4.1 changes this calculus, except that M4.1 shipped without any such document
and worked fine. **Recommendation: defer indefinitely, revisit only if a real dispatcher gets
built** — not a current priority, and not blocking anything else in this document.

## What's actually left to plan, once the open question is answered

- Task 1 (workstream label namespace) — real, independent, can be planned regardless of the open
  question's answer.
- Real GitHub assignee display for humans (half of old Task 5) — real, independent, can be planned
  regardless of the open question's answer.
- Whichever of the three options above the owner picks for the model-assignee vocabulary — the
  only piece actually gated on a decision this document doesn't make.
- Everything else (old Tasks 2, 3, 4, 6) is retired or ratified-as-already-shipped, not planned.

## Self-review

**Placeholder scan:** no "TBD"/open code blocks — this is a decision document, not an execution
plan, and correctly stops short of one.

**Internal consistency:** the two pieces marked "still real" (Task 1, human assignees) do not
depend on the open question's answer; verified neither references `agent:` labels or the closed
vocabulary anywhere in its own reasoning.

**Scope check:** deliberately does not include an implementation plan — the directive that
produced this document was explicit that this needs a decision back first.
