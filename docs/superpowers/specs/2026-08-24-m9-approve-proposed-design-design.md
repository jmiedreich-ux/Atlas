# Atlas M9: approve a proposed design from the website

## Why

The owner asked, across more than one planning session, how `docs/design/proposed/<slug>/`
becomes action on the web page — not a documentation page describing `scaffold.mjs` (M7's CLI),
but a real mechanism that takes a design under review and turns it into a tracked, planned feature.
Confirmed directly this session: the mechanism is a button that updates git — moves the design to
`docs/design/approved/<slug>/` and begins the planning stage, the same outcome `scaffold.mjs`
already produces locally, but reachable from `atlas.vennusign.com` itself.

`scaffold.mjs` (M7) is real, tested, and does the second half of this already — but it is a local
CLI with zero UI footprint, and nothing before this milestone let the website act on anything.
Decision 35 (M3) scoped write-back to two things, later three (M8), and justified stopping there on
the grounds that *"creating issues, approving milestones, editing manifests and triggering work
belong to the project's own operations console — two consoles that both act is how they diverge."*
Decision 57 (owner, 2026-08-22, tracked in `docs/design/approved/atlas/decisions.md` in the
Vennusign repository, GitHub issue #784) found that justification false: Platform Operations deals
with the release process and nothing before it, so the console named never owned any of this.
Decision 57 explicitly did **not** widen write-back's scope on its own — it said the old reason was
void and the scope had to be re-decided on correct grounds, naming "editing a manifest" as one of
the things that re-decision would have to cover on its own merits, not by default.

This milestone is that re-decision, made explicitly rather than inferred: **decision 58** retires
decision 35 (its justification is gone; keeping the rule on no stated grounds would be worse than
retiring it and saying why). **Decision 59** is the actual new capability — `approve` — decided on
its own terms: a design a human has explicitly reviewed and wants to move forward, moved to
`approved/` and scaffolded, in one commit, gated behind the same `author` role every other write
already requires.

## What this milestone does NOT build

- **A form for the manifest's free-text fields.** `approve` writes the exact same
  placeholder-driven starter `workstream.json`/`m1-plan.md` `scaffold.mjs` writes today — someone
  still fills in the real title, summary and next-step by hand afterward, through ordinary git, the
  same as every scaffold before this one. Building a web form for that content is a separate,
  larger decision (a manifest EDITING surface, not a manifest CREATING one) and is explicitly out
  of scope here.
- **A "reject" or "un-approve" action.** Only the forward direction — proposed to approved — is
  built. Reversing an approval (moving files back, deleting the manifest) is ordinary git, done by
  hand, the same as it is today.
- **A visible queue for loose proposed files with no slug directory.** `docs/design/proposed/`
  holds both slug directories (`keystone/`, `platform-operations/`) and loose top-level files
  (`display-stale-signals.md`). `scaffold.mjs`'s own precondition check has only ever operated on a
  slug directory, and `approve` keeps that restriction rather than inventing a new shape for the
  loose case.
- **Any change to who can approve.** Same `author` role every write already requires. Whether
  approval should someday need a narrower role is a separate decision, not inferred here.

## Where the mechanism lives, and why it is not the existing write pattern

The three endpoints M3/M8 shipped (`answer`, `acceptance`, `deployment-transition`) share one
shape: read one record's text and SHA, edit the text, `PUT` it back with that SHA. GitHub's Contents
API gives optimistic concurrency for free that way — a stale SHA is refused, nothing is retried
without a fresh one.

`approve` cannot use that shape. It touches every file under `docs/design/proposed/<slug>/` (moved,
not edited), plus two new files (`workstream.json`, `m1-plan.md`) and one edited file
(`atlas.config.json`) — four-plus separate writes if done as a sequence of Contents-API `PUT`s, and
a sequence is exactly the wrong shape here: if a `PUT` after the first fails, the repository is left
with files gone from `proposed/` and no manifest ever written — a real half-state, the exact thing
decision 37's "nothing is kept anywhere" has refused everywhere else in this codebase.

So `approve` is built on GitHub's **Git Data API** instead (`createTreeClient`, `api/lib/github.mjs`):
read the branch's current commit and tree, build one new tree from it (additions and removals
computed by `api/lib/approve.mjs`'s `planApproval`), wrap it in one commit, and move the branch ref
to it. The ref update is requested as a fast-forward only (`force: false`) — if the branch moved
between the read and the write, GitHub refuses the update and nothing lands. That is `approve`'s
whole concurrency guarantee, and it needs no caller-supplied SHA to get it: unlike the other three
endpoints, `approve`'s payload is `{ slug }` alone.

A moved file is never re-uploaded. Git blobs are content-addressed, so the new tree entry at
`docs/design/approved/<slug>/x` carries the exact same blob SHA the old entry at
`docs/design/proposed/<slug>/x` had — a move is a change of tree position, not new content, and
this holds for a binary PNG the same as a Markdown file (the Contents API's ~1MB read limit, which
would otherwise force `approve` to skip large proposed assets, never applies).

## The three preconditions, and where they come from

`planApproval` (`api/lib/approve.mjs`) mirrors `scaffold.mjs`'s `checkPreconditions` exactly, read
from a git tree listing instead of `existsSync`:

1. **Something is actually there.** `docs/design/proposed/<slug>/` has at least one blob under it.
   No slug directory, or an empty one → `no-such-proposal` (404).
2. **Nothing is already approved under this slug.** `docs/design/approved/<slug>/` must be empty —
   `approve` moves a design out of `proposed/` once; it does not merge into an approved design that
   already exists → `already-approved` (409).
3. **Not already scaffolded.** No `docs/features/<slug>/workstream.json` yet — this writes a
   design's FIRST milestone only, the same restriction the CLI states → `already-scaffolded` (409).

All three are read fresh, inside the same request that acts on them — not from anything a page
rendered earlier — so a stale page cannot approve something that has since been approved by someone
else through another path; it gets the same `already-approved`/`already-scaffolded` refusal a fresh
page load would.

## The UI

A new "Proposed" section on the Feature Planning page (`depth.njk`), below the existing feature
list — not another kind of `.feature-row`, because a proposed design has no manifest yet and
nothing to expand. `src/config.mjs`'s `proposedDesignDirs` enumerates the approvable slugs at build
time (the same three-condition filter `planApproval` checks at request time; the build-time list
can go stale between builds, which is fine — a stale button gets the live precondition refusal, not
a silent no-op). One row per slug, one Approve button, wired by `theme/approve.js` following
`theme/deploy.js`'s established pattern (a `[data-*-trigger]` wrapper, a status line with
`aria-live="polite"`, the button disabled during the request). Left disabled after a successful
approve — the button's own proposal is gone from the repository at that point, and a second click
before the next rebuild would just 404.

## This retires decision 35, on the record rather than by omission

Decision 58 (`.atlas-decisions.md`, the Atlas repository's own untracked-but-real decision log —
see that file's header on why it is gitignored: this repository is public, and an unshipped
decision at an immutable tag is a security posture published ahead of the thing it protects):

> **58 · Decision 35 is retired.** Its justification — that approving milestones and editing
> manifests belong to a separate operations console — was withdrawn by decision 57 (Platform
> Operations does not do those things). Decision 57 did not itself widen write-back's scope; this
> decision does not either. What it removes is the CLOSED-COUNT posture: a future write-back
> capability is its own decision, on its own stated grounds, the same way decision 59 is — not
> something that needs a fixed "exactly N" test updated by amendment every time. `api/lib/handlers.mjs`'s
> "exactly three handlers" test is retired to a named-list test for the same reason: a closed,
> named list still catches a stray export nobody decided on; a fixed count does not do more than
> that, and dressed a routine addition up as an amendment each time.

Decision 59:

> **59 · `POST /api/approve` moves a proposed design to approved and scaffolds its first milestone,
> in one commit.** Decided on its own grounds, per decision 57's instruction to re-decide rather
> than infer: a human has already reviewed the design (decision 35's own "repository presence does
> not constitute design approval" still holds — nothing here approves a design that has not been
> looked at; it acts on a decision a person already made) and wants it to become a tracked feature.
> This is a genuinely bigger write surface than the three before it — it creates a manifest rather
> than editing a record a manifest names — and it is built with its own atomic-commit mechanism
> (`createTreeClient`) rather than reusing the single-record one, precisely because that surface is
> bigger. It does not reopen the rest of what decision 35 excluded: creating an arbitrary GitHub
> issue, setting a milestone's `status` directly, or any other manifest EDIT is still undecided and
> still not built.

## Data model summary

No schema change. `approve` writes exactly the shape `scaffold.mjs` already writes
(`api/lib/manifest-template.mjs`, extracted so both callers share it): a `workstream.json` with
`stage: "designing"`, one milestone `M1` at `status: "unplanned"`, every free-text field an
unmissable placeholder — and an `m1-plan.md` scaffold. `atlas.config.json` gains one entry in
`workstreams`, appended (idempotent — a second call after the manifest already exists refuses at
precondition 3 before ever reaching the config write).

## Implementation notes for the plan

- `api/lib/github.mjs`: `createTreeClient` — `readBranch`, `readTree` (recursive, refuses a
  truncated listing rather than acting on a partial one), `readBlob`, `createBlob`, `createTree`,
  `createCommit`, `updateRef` (fast-forward only, conflict on failure).
- `api/lib/manifest-template.mjs` (new): `buildManifest`/`buildManifestText`/`buildPlanText`,
  extracted from `src/scaffold.mjs` so the CLI and the API share one template.
- `src/scaffold.mjs`: unchanged behaviour, now imports the shared template.
- `api/lib/approve.mjs` (new): `planApproval` (the three preconditions, from a tree listing),
  `addWorkstreamToConfig` (idempotent).
- `api/lib/payload.mjs`: `validateApprovePayload` — `{ slug }` only, reusing `whyNotADirectoryName`.
- `api/lib/handlers.mjs`: `handleApprove`, sharing `prepare`'s steps 1–3 (now parametrised over
  which GitHub client to build) with the other three.
- `api/approve/` (new): `function.json` + `index.mjs`, matching the existing three exactly.
- `src/config.mjs`: `proposedDesignDirs`.
- `src/build.mjs`: threads `site.proposedDesigns` into the depth page's data.
- `theme/_includes/depth.njk`: the Proposed section.
- `theme/approve.js` (new): `approveBody`, `outcomeMessage`, `wire` — mirrors `theme/deploy.js`.
- `theme/tokens.css`: `.proposed-*`/`.approve-trigger*` rules, reusing existing Sky UI tokens.
- Tests: `tests/writeback-github.test.mjs` (tree client, isolated), `tests/approve-plan.test.mjs`
  (pure precondition logic), `tests/approve-handler.test.mjs` (end to end against an in-memory Git
  Data API stub, including the fast-forward race), `tests/theme.test.mjs` (the rendered section and
  `approve.js`'s `wire()`), and the two "exactly N" tests in `tests/writeback-function.test.mjs` /
  `tests/writeback-handlers.test.mjs` converted to named-list assertions.
