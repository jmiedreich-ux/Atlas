# Atlas M8: real deployment stages, and an ordered record of how a feature got there

**Status:** approved by the owner in conversation, 2026-08-23. Supersedes nothing already
shipped — extends M4.1's accordion (`docs/superpowers/specs/2026-08-23-feature-planning-rebuild-design.md`).

## Why

The accordion's stage chip says **"Shipping"** for a feature that has only ever run in a
development environment — Atlas itself (`atlas` manifest) and Menus both carry `"stage":
"shipping"` today, and neither has a release in the sense the word implies. `WORKSTREAM_STAGES`
(`api/lib/contract.mjs`) is `['not-started', 'designing', 'planned', 'shipping']` — one catch-all
word for everything past `planned`, when Vennusign's real deployment path has at least two more
distinct, meaningful states: a feature runs in **development**, may or may not pass through
**staging**, and eventually reaches **release**. The owner's ruling: replace the one word with the
real stages, and let a feature's actual progress through them be recorded and shown — as an
**ordered sequence of what happened, not a calendar of when** (his words: "its not a timeline of
times/dates, its a timeline of order of events" — deliberately not reopening M4.1's "no dates, no
duration" decision).

Two things follow from that:

1. A stage transition has to be **triggerable** — on Atlas's own site, or by telling whichever
   agent is doing the work — not just observed after the fact.
2. **Triggering it must not itself deploy anything.** The owner was explicit and this reflects a
   real correction mid-conversation: the first framing floated was a button that fires a GitHub
   Actions `workflow_dispatch` directly from Atlas, and the owner agreed that's too large an
   escalation for the generator to own. See "Deliberately excluded" below.

## What this milestone does NOT build

**A deployment agent.** Something has to actually receive "this feature is ready to move to
staging/release" and decide whether to act on it, authorize it, and orchestrate whatever real
deployment work that means — for every Vennusign feature, not only Atlas's own. The owner's own
words: "we might want a deployment agent to handle it... that handles that... we will spec this
out further later." That agent — its authorization model, its credentials, its relationship to
GitHub Actions or whatever actually deploys — is **explicitly out of scope here** and gets its own
spec when the owner is ready for it. This milestone's write-back extension (below) stops at
**recording that a transition was requested**. It does not call GitHub Actions, does not know what
a deployment pipeline looks like for any given feature, and does not name the deployment agent
anywhere in code — because doing so would be designing that agent's interface without the owner
having decided what it is yet. Where this spec needs to gesture at "and then something picks this
signal up," it says exactly that and stops.

**A migration mechanism for the vocabulary rename itself beyond the two real manifests that use
it.** `atlas` and `menus` are the only two workstreams (of seven in the Vennusign repo today)
carrying `"stage": "shipping"`; `keystone` is `planned`, and `onboarding`/`platform-operations`/
`screens`/`theme-studio` are `designing` — none of those five are touched by this rename. The
implementation plan updates the two real manifests directly; there is no generalized migration
tool because there is nothing here that needs one.

## The vocabulary

`WORKSTREAM_STAGES` becomes:

```js
export const WORKSTREAM_STAGES = Object.freeze([
  'not-started', 'designing', 'planned', 'development', 'staging', 'release',
]);
```

`not-started`, `designing` and `planned` are unchanged — they describe a feature before any code
exists to deploy, and nothing about deployment stages touches them. `shipping` is removed;
`development`, `staging`, `release` replace it. **Staging is optional**, per the owner: a feature
may go `development` → `release` directly, or `development` → `staging` → `release`. Nothing in
the schema enforces adjacency between these three — a milestone's `depth` is a strict ladder
position because decision 20 makes it one, but a workstream's stage history is not a ladder, and
this spec does not make it act like one. `theme/_includes/base.njk`'s `chipLabel` macro gets three
new entries (`"development": "Development"`, `"staging": "Staging"`, `"release": "Release"`) and
loses `"shipping": "Shipping"`.

## Where a transition record lives, and why it is not a manifest edit

**Decision 35 keeps manifests out of Atlas's write path entirely** — `api/lib/contract.mjs`'s
`whyNotAWritableRecord` refuses any write whose target is `workstream.json` by name, and
`handleAcceptance` (`api/lib/handlers.mjs:206`) demonstrates the actual, working precedent: it
*reads* the manifest to find where a milestone's acceptance record lives
(`milestone.acceptance.record` — a repository-relative path the manifest merely *points at*), and
writes into **that** file, never into the manifest itself. A stage transition follows the identical
shape:

* Each workstream manifest gains one new, optional field: **`deploymentLog`** — a
  repository-relative path, exactly like `milestone.acceptance.record` is a path, pointing at a
  small JSON record under the workstream's own directory (e.g.
  `docs/features/atlas/deployment-log.json`). Optional, because a workstream that has never
  reached `development` has nothing to log yet, the same reason `milestone.issue` is nullable.
* The record is a flat, ordered array: `[{ "stage": "development", "note": "" }, { "stage":
  "release", "note": "skipped staging — hotfix" }]`. `stage` is validated against the three
  deployment values only (`development`/`staging`/`release` — not the pre-development three, which
  can't be "transitioned to" after the fact). `note` is an optional free-text string, capped the
  same way other short manifest strings are, for the rare case a transition needs one line of
  context ("skipped staging", "rolled back"). **No date field exists on an entry** — array order
  *is* the record, per the owner's own framing.
* A new write-back Function, `POST /api/deployment-transition`, appends one entry. Same shape as
  `handleAcceptance`: read the manifest, resolve `deploymentLog` (refuse with `409
  no-deployment-log` if absent — "add the field first," the same refusal shape `handleAcceptance`
  gives for a missing `acceptance.record`), validate the path with the existing
  `whyNotAWritableRecord`, read-modify-write the JSON array with the same optimistic-concurrency
  SHA check every other write-back handler already uses. **It never touches `workstream.json`.**
  It commits to the deployment log and nothing else, through the same GitHub App write-back
  already uses.

## What the manifest's own `stage` field means now

`stage` stays exactly as required and author-edited as it is today for the pre-development values
— nothing here removes it from `validateWorkstream` or makes `not-started`/`designing`/`planned`
derived. But once a workstream's `deploymentLog` exists and has at least one entry, **the
displayed stage is the log's latest entry, not the manifest's `stage` field** — computed at build
time in `assembleSite`, the same place `triage` is computed from `classifyTriage` today rather
than read off the manifest. This is deliberate, not an oversight: it is what actually fixes the
"chip says Shipping, feature is really in dev" problem, because a stale hand-edited `stage` value
stops being able to lie once a real, append-only log exists to override it. A manifest's own
`stage` field is only ever consulted as the value shown *before* any deployment activity has been
logged — the same way `column.tipLabel` already falls back to `gate` text when there's nothing
more specific to say.

**This is a genuinely new rule and it needs its own decision number** — record it as such in the
implementation plan's Global Constraints, the way `blocked`-not-`gated` got recorded as its own
line in `api/lib/contract.mjs`. Working title: *"a workstream's displayed stage is its deployment
log's latest entry once one exists, never the manifest's own `stage` field past that point."*

## Triggering a transition: on-screen and by-agent are one mechanism

The owner: "on screen or to the agent" — a control on Atlas's site, or telling whichever Claude
Code agent is doing the work, are both **inputs to the same `POST /api/deployment-transition`
endpoint**, not two implementations. "Telling an agent" means the agent calls the endpoint the same
way a person clicking a button would trigger the same request client-side — there is no separate
code path for "an agent did it" versus "a person clicked it." The on-screen control is a small
form on each feature's expanded row (three buttons — Development, Staging, Release — each POSTing
the same payload shape a script or an agent would send), gated behind `WRITE_ROLE` (`'author'`,
`api/lib/contract.mjs`) exactly like every other write-back action today.

**Why `author` and not a narrower role.** The two roles that exist today are `reader` and
`author` — there is no third tier, and inventing one is new infrastructure this spec is not going
to justify on its own. The reasoning that makes `author` acceptable here, stated plainly rather
than assumed: this endpoint **records a request**, it does not deploy anything. The actual
authorization question — who may cause a real deployment to happen — belongs entirely to the
deployment agent this spec explicitly excludes, which will apply its own authorization to whatever
it receives. Gating the *signal* more tightly than the *register-answer* signal already is would
be protecting against a risk (an unauthorized real deployment) that this endpoint structurally
cannot cause on its own.

## Where the ordered history renders

Not inside `.milestone-spine` — a stage transition is a fact about the *feature*, not about any one
milestone, and mixing the two axes on one vertical line would make the spine answer two different
questions at once. It renders as its own small ordered row, directly above the milestone spine in
an expanded feature (`theme/_includes/depth.njk`), reusing the spine's *visual grammar* (a filled
dot per reached stage, connected by a line, in order) without reusing its markup, since the data
shapes differ (a stage transition has no `title`, no `status` enum matching milestone statuses, no
tasks). New elements: `.stage-history` (the row), `.stage-node` (one dot + label per logged
transition, plus one more for the workstream's own current pre-log `stage` value when no log
exists yet, so the row is never empty for a feature that simply hasn't started deploying).

## Data model summary

* `WORKSTREAM_STAGES`: six values, `shipping` removed, `development`/`staging`/`release` added.
* New, optional manifest field: `workstream.deploymentLog` — a repository-relative path, validated
  the same way `milestone.acceptance.record` is.
* New record type: a workstream's deployment log, a flat ordered array of `{ stage, note }`, no
  dates.
* New write-back endpoint: `POST /api/deployment-transition`, append-only, `author`-gated,
  decision-35-compliant (never writes `workstream.json`).
* New build-time computation: a workstream's *displayed* stage is its log's latest entry once one
  exists, else its manifest's own `stage` field.
* **Not built:** anything that deploys. Not the deployment agent. Not a new authorization role.

## Implementation notes for the plan

* Only `docs/features/atlas/workstream.json` and `docs/features/menus/workstream.json` (Vennusign
  repo) currently use `"shipping"` — the plan updates both directly to `"development"` or
  `"staging"` or `"release"` (whichever is factually true right now; this needs the owner's own
  read of where Atlas and Menus actually stand, or, if that read isn't available at plan-writing
  time, the plan should default both to `"development"` as the conservative floor and say so
  explicitly rather than guess a further-along value).
* `handleAcceptance` (`api/lib/handlers.mjs:206`) is the template the new handler is written
  against line for line — same manifest-read, same path-resolution-and-refusal shape, same
  optimistic-concurrency SHA check. The plan's tasks should cite it by name and line, not describe
  it in prose.
* Tests: `tests/writeback-handlers.test.mjs` and `tests/writeback-contract.test.mjs` are where
  `handleAcceptance`'s own tests live — the new handler's tests belong beside them, following the
  same fixture/mock-client patterns already established there rather than inventing new ones.
