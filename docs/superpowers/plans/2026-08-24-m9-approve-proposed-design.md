# M9: Approve a Proposed Design — Implementation Plan

Spec: `docs/superpowers/specs/2026-08-24-m9-approve-proposed-design-design.md`. Read it first —
this plan assumes its reasoning (why the Git Data API and not the Contents API, the three
preconditions, decisions 58/59's exact scope) without repeating it.

## Global constraints

- No new runtime dependency. `createTreeClient` is built the same way `createContentsClient` is:
  plain `fetch`, injected as `fetchImpl`, no SDK.
- `approve` never re-derives content it can move by reference — a proposed file's existing blob SHA
  travels to its new path unchanged; only the manifest, the plan, and the edited config are new
  blobs.
- Every new refusal path names which precondition failed, the same way every existing refusal does
  — no generic "bad request."
- Full test suite green (`npm test`) before this is done — not just the new tests.

## Task 1: `createTreeClient` (`api/lib/github.mjs`)

`readBranch`, `readTree` (recursive, refuses `truncated: true`), `readBlob`, `createBlob`,
`createTree` (validates every entry path with the same guard `apiPath` uses, extracted as
`assertRepoRelativePath`), `createCommit` (one parent, always), `updateRef` (`force: false`; a 422
or 409 becomes the same `conflict`/409 shape a stale Contents-API SHA already produces).

Test: `tests/writeback-github.test.mjs`, extended — one test per method, plus the fast-forward
refusal and the traversal refusal, against the existing `stubFetch` helper.

## Task 2: Shared manifest template (`api/lib/manifest-template.mjs`)

Extract `buildManifest`/`buildManifestText`/`buildPlanText` out of `src/scaffold.mjs`'s
`scaffoldWorkstream` verbatim (content unchanged — only the placeholder text's "M7 scaffold:" prefix
generalises, since a second caller exists now). `src/scaffold.mjs` imports and uses it; its own
tests (`tests/scaffold.test.mjs`) need no change since the written output is unchanged.

## Task 3: `planApproval` / `addWorkstreamToConfig` (`api/lib/approve.mjs`, new)

The three preconditions from a flat tree listing, `ApproveError` with a code per refusal
(`no-such-proposal`, `already-approved`, `already-scaffolded`, `no-config`). `addWorkstreamToConfig`
mirrors `scaffold.mjs`'s `promoteInConfig`, idempotent.

Test: `tests/approve-plan.test.mjs`, new — pure, no network, one test per precondition plus the
happy path and idempotency.

## Task 4: `validateApprovePayload` (`api/lib/payload.mjs`)

`{ slug }` only, reusing `whyNotADirectoryName`. No `sha` field — see the spec's "Where the
mechanism lives" section for why.

## Task 5: `handleApprove` and the Function (`api/lib/handlers.mjs`, `api/approve/`)

Generalise `prepare()` to accept a client factory (default `createContentsClient`, `approve` passes
`createTreeClient`). `handleApprove`: read branch → read tree → `planApproval` → read config blob →
build manifest/plan/config blobs → build the tree entries (each move is two entries: new path with
the old SHA, old path with `sha: null`) → `createTree` → `createCommit` → `updateRef`. `ApproveError`
joins `GitHubError`/`RecordError` in `fromError`'s status mapping. `api/approve/function.json` +
`index.mjs`, identical shape to `api/acceptance/`.

Test: `tests/approve-handler.test.mjs`, new — an in-memory Git Data API stub (`githubTree()`)
realistic enough that the fast-forward race is a real race: `someoneElseCommits` advances the
branch mid-request the same honest way `writeback-handlers.test.mjs`'s stub does for a stale
Contents-API SHA. Covers the happy path, all three preconditions, auth (401/403), payload
validation, and the race.

## Task 6: The two "exactly N" guards

`tests/writeback-function.test.mjs`'s "the deployable holds exactly three functions" and
`tests/writeback-handlers.test.mjs`'s "the Function exports exactly three write handlers" both
become named-list assertions (four names, not a count) — decision 58 retires the closed-count
posture, not the closed-LIST one. Update both files' header comments to match (four endpoints, why
`approve` needed its own mechanism, decisions 57/58/59 in one sentence each).

## Task 7: Wire into the build (`src/config.mjs`, `src/build.mjs`)

`proposedDesignDirs(config)` in `config.mjs`, same shape and same never-throws posture as
`unnamedFeatureDirs`. Threaded into `assembleSite`'s return as `proposedDesigns`, and into the depth
page's data in `planPages`.

## Task 8: The Proposed section (`theme/_includes/depth.njk`, `theme/approve.js`, `theme/tokens.css`)

A new section below `.feature-list`, absent entirely when `proposedDesigns` is empty. One row per
slug, one Approve button. `theme/approve.js` mirrors `theme/deploy.js`'s `wire()` shape
(`[data-*-trigger]` wrapper → status line + button), sends `{ slug }` with no `sha`, leaves the
button disabled on success. CSS reuses existing Sky UI tokens (`--sky-color-border`,
`--sky-text-*`, `--sky-space-*`, `--sky-focus-color`) — no new literal colour.

Test: `tests/theme.test.mjs` — the section renders (and is absent when empty), the script tag is
depth-page-only, `approveBody`/`outcomeMessage` pure-function tests, and `wire()` against hand-built
fake elements (same convention as `deploy.js`'s own tests).

## Task 9: Decisions and docs

`README.md`'s write-back section: four endpoints, the Contents-API-vs-Git-Data-API split, decisions
57/58/59 in prose. `api/lib/handlers.mjs`'s header comment. `api/lib/contract.mjs`'s comments on
`ACCEPTANCE_RESULTS`, `MANIFEST_FILENAME`, and `whyNotAWritableRecord`'s manifest-refusal message
(the refusal itself is unrelated to decision 35 and still stands; only the reasoning cited needed to
change). `src/labels.mjs`'s header (a passing decision-35 reference). This spec + plan pair.

## Task 10: Full-suite verification

`npm test` clean, including every test written in Tasks 1–8, with nothing from before this
milestone broken.

## Self-review

- Every new refusal (`no-such-proposal`, `already-approved`, `already-scaffolded`, `no-config`,
  `invalid-config`, `tree-truncated`, the ref-update `conflict`) is exercised by a test.
- The race test is real, not simulated by asserting a call count: `someoneElseCommits` actually
  advances the in-memory branch's tip between `readBranch` and `updateRef`, so the fast-forward
  check in the stub is doing the same work GitHub's real one would.
- No file this milestone touches loses its own existing test coverage — `scaffold.mjs`'s tests,
  the three existing endpoints' tests, and `theme.test.mjs`'s existing `deploy.js` tests all still
  pass unchanged.
- Nothing outside `api/`, `src/`, `theme/`, `tests/`, `docs/superpowers/`, `README.md` and
  `.atlas-decisions.md` (untracked, local-only) is touched. The Vennusign repository — the source of
  `docs/design/proposed/`/`docs/design/approved/` content this milestone reads and writes at
  runtime — is not touched; it needs no code change for this feature.
