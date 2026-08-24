# Atlas

Atlas is a reusable generator that turns a project repository into a static site, built from
the repository's own Markdown and its GitHub issues — never hand-maintained. It holds no
project content of its own; a project provides a fixed convention (config and manifests) and
Atlas builds the site from it.

Atlas ships as a versioned composite GitHub Action, consumed in one line:

```yaml
uses: jmiedreich-ux/atlas@v1
```

## Using the action

A consuming project's own workflow checks itself out, then hands its checkout to Atlas:

```yaml
concurrency:
  group: atlas-${{ github.ref }}
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: read
    steps:
      - uses: actions/checkout@v4

      - uses: jmiedreich-ux/atlas@v1
        with:
          github-token: ${{ github.token }}
```

The `concurrency:` group is not decoration either. Decision 30 puts this workflow on a six-hourly
schedule, and a push during a scheduled run gives you two builds writing to one output directory.
Atlas refuses the second rather than publishing a mixture of the two — it claims its staging
directory with an atomic `mkdir` — so the failure is loud rather than silent, but a cancelled run is
better than a failed one.

The `permissions:` block is not optional decoration. Where an organisation defaults the workflow
token to a restricted set, the issue fetch 403s — and `src/github.mjs` correctly degrades to empty
buckets rather than failing the build, because GitHub being unreachable is the one failure this
generator tolerates. The result is a site that silently claims every workstream has an empty
backlog. `issues: read` is what stops that; `contents: read` is what lets `actions/checkout` work.

| Input          | Required | Default              | What it is                                                                                                                                                                        |
| -------------- | -------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project-path` | no       | `${{ github.workspace }}` | The project to build — the checkout that carries `atlas.config.json`, `ROADMAP.md` and `docs/`. The default is the calling workflow's own workspace, which is correct for the ordinary case above and rarely needs overriding. |
| `output-dir`   | no       | `.atlas-out`           | Where the built site is written, relative to the calling workflow's working directory unless given as an absolute path. Wired straight into a later step — `actions/upload-pages-artifact`, an Azure Static Web Apps deploy — that publishes it. |
| `api-dir`      | no       | `.atlas-api`           | Where the write-back Function is placed, so a workflow can name it as an Azure Static Web Apps `api_location`. Resolved like `output-dir`, replaced wholesale each run, and refused if it overlaps `output-dir` or anything the build reads, or if it falls outside the checkout — it has to be somewhere `api_location` can name. It does **not** have to be inside `project-path`: a project in a subdirectory can put its API at the checkout root, which is what Atlas's own CI does. Set it to an empty string for a project publishing the site without the endpoints. The action's `api-path` output holds where it landed — see **Write-back**, below. |
| `github-token` | no       | *(none)*               | A token used to fetch each workstream's open issues and pull requests. There is no safe default, so it is left unset rather than defaulted: without it, the build still succeeds — `src/github.mjs` tolerates GitHub being unreachable — but the requests are unauthenticated and subject to GitHub's public rate limit. Pass `${{ github.token }}`, as above, to authenticate as the workflow's own run. |

Per decision 46, the version tags (a `vX.Y.Z` per release, and the `v1` major tag moved forward to
the newest compatible one) live in **this** repository. A consuming project holds none of its own — nothing to bump, nothing to keep
in sync — it only ever points at Atlas's.

## Running it yourself

Atlas is a Node 22 project with two runtime dependencies (decision 9). Nothing below needs the
action, a runner, or a network.

```bash
npm ci                 # or: npm install
npm test               # the whole suite
```

The generator is a command line, and it is the same one the composite action invokes:

```bash
node src/build.mjs <project-root> [<out-dir>] [--offline] [--quiet]
```

| Argument         | What it is                                                                    |
| ---------------- | ----------------------------------------------------------------------------- |
| `<project-root>` | A directory following the convention above. Required.                          |
| `<out-dir>`      | Where the site is written. Defaults to `.atlas-out`. **Replaced wholesale** on every successful build, so a page whose record was deleted does not survive the rebuild. |
| `--offline`      | Skip GitHub entirely rather than attempt it and tolerate failure. What the test suite and CI use, and what a project with no GitHub wants. |
| `--quiet`        | Print Atlas's own one-line summary and nothing else.                           |

`GITHUB_TOKEN` in the environment authenticates the issue fetch; without it the request is
unauthenticated and subject to GitHub's public rate limit.

The repository ships a fixture project — a small invented one, so the generator holds no project
content of its own (decision 40). Building it is the fastest way to see the output:

```bash
node src/build.mjs fixture .atlas-out --offline --quiet
```

Atlas **refuses** to build into a directory that overlaps anything it reads — the project's
`atlas.config.json`, `ROADMAP.md` or `docs/`, or its own `src/`, `theme/`, `.eleventy.js`,
`package.json` or `node_modules/` — in either direction, because a build replaces its output
directory wholesale. `<project>/_site` is fine; `<project>/docs` is refused, and so is any spelling
of it the filesystem says is the same path. See `src/outdir.mjs`.

## `state.json` — the agent-facing output

Every build writes `state.json` beside the pages (decision 29). It is the one thing Atlas offers
agents rather than people: a session's orientation read becomes one guaranteed-current file instead
of six.

It is not a second derivation. `src/state.mjs` is handed the very objects the pages were rendered
from — the same manifests, the same ladder, the same triage call, the same issue buckets — and
projects them, so the site and this file cannot disagree.

```jsonc
{
  "version": 1,                       // the shape's own version, first, so a consumer can tell
  "project": "…",
  "repo": "owner/name",
  "surfaces": [ { "id": "depth", "url": "/" }, { "id": "triage", "url": "/mobile/" } ],
  "workstreams": [ {
    "slug": "…", "codename": "…", "stage": "…", "position": "…", "gate": "…",
    "triage": "awaiting-decision",    // decision 27's state, from the same call the phone view used
    "dir": "docs/features/…",         // every path is repository-relative, never absolute
    "manifestPath": "docs/features/…/workstream.json",
    "design": [ { "name": "…", "where": "…" } ],
    "depth": { "barTo": "…", "headAt": "…", "tipLabel": "…", "note": "…",
               "completedCount": 3, "milestoneCount": 6 },
    "milestones": [ { "id": "M1", "label": "M1", "depth": 1, "status": "done",
                      "started": "2026-03-02", "completed": "2026-03-05",  // stored days, or null
                      "plan": "m1-plan.md", "planPath": "docs/features/…/m1-plan.md",
                      "acceptance": { "kind": "…", "record": "…" }, "url": "/workstream/…/m1/" } ],
    "issues": [ { "number": 101, "title": "…", "url": "…" } ]
  } ],
  "triage": [ … ],                    // decision 27's order, as the phone view laid the cards out
  "ladder": { "rows": [ … ], "columns": [ … ] },
  "issues": { "byLabel": { … }, "unlabelled": [ … ], "prs": [ … ] },
  "documents": [ { "title": "…", "path": "…", "url": "…" } ],
  "assets": [ { "path": "…", "url": "…", "isDocument": true } ]
}
```

**The compatibility rule, stated out loud, because agents are the audience for this file:**
`version` is bumped only when a change would break a reader that understood the previous version.
**Adding a key does not bump it.** So a consumer must read `state.json` by the keys it needs and
ignore the ones it does not — a strict-shape parser that rejects unknown keys will break on a
release that breaks nothing. `version` going from 1 to 2 is the signal to re-read this section;
nothing else is.

Two properties it is safe to rely on: **every path in it is repository-relative** — an agent reads
it to find out which file to open, and an absolute path from a CI runner is no use to anyone — and
**nothing in it is dated**, so an unchanged project rebuilds to a byte-identical file. A build
stamp would destroy the only property that lets a reader trust the file is current.

`src/state.mjs` is the authoritative description of this shape.

## What a project provides

Per decision 40, a project needs no code to be buildable by Atlas — only these files, following a
fixed convention, at its own root:

- **`atlas.config.json`** — the project's identity and its workstream list, in the order they
  should display (decision 20 — nothing here is re-sorted):

  ```json
  { "project": "Lighthouse Fixture",
    "repo": "atlas-fixtures/lighthouse",
    "workstreams": ["beacon", "tide", "harbor", "anchor"] }
  ```

  `repo` is `owner/name`, the repository `github-token` fetches issues and pull requests from.
  Each entry in `workstreams` is a directory name under `docs/features/`.

- **`ROADMAP.md`** — the project's narrative. Rendered as a page like any other Markdown file
  under `docs/`; nothing about its content is validated.

- **`docs/features/<workstream>/workstream.json`**, one per entry in `atlas.config.json`'s
  `workstreams` list — decision 14's manifest, the authority for where a workstream stands.
  Position lives here, never in prose:

  ```json
  { "codename": "Beacon",
    "what": "A six-milestone workstream ...",
    "stage": "shipping",
    "position": "Three milestones shipped, fourth in flight",
    "gate": "Owner sign-off on the M4 demo before M5 starts",
    "label": "workstream:beacon",
    "design": [{ "name": "lighthouse/Beacon Overview v1", "where": "design-project" }],
    "milestones": [
      { "id": "M1", "label": "M1", "depth": 1, "title": "Signal contract",
        "status": "done", "started": "2026-03-02", "completed": "2026-03-05",
        "plan": "m1-plan.md", "issue": 101, "pr": 201,
        "acceptance": { "kind": "demo-script", "record": "docs/features/beacon/m1-demo.md" } }
    ] }
  ```

  Every field is required except `started` and `completed`. `id` is the durable, never-renamed identifier (decision 17); `label` is
  its normalised display form, and the two are allowed — expected — to differ. `plan` is a
  filename resolved relative to the workstream's own directory (`docs/features/beacon/m1-plan.md`
  above); it must exist. `issue` and `pr` are GitHub numbers or `null`. `acceptance.record` is
  either `null` or a path relative to the project root, naming a Markdown file elsewhere under
  `docs/` — when it does, the milestone's page links to it. `design` **names** authorities that
  live outside the repository (decision 21: the Claude Design project, Google Drive) — as text,
  never as links. CI cannot reach either of them, so a link would be one nobody could follow;
  Atlas neither fetches nor renders them, and `state.json` carries the same names, unlinked.

  Two vocabularies are closed, and an unrecognised value fails the build rather than rendering a
  blank chip (decision 32):

  - workstream **`stage`** ∈ `not-started, designing, planned, shipping`
  - milestone **`status`** ∈ `done, next, blocked, parked, unplanned`

  `started` and `completed` are optional and are stored calendar days, written `YYYY-MM-DD` — the
  day the milestone began and the day it closed. Both are facts recorded when they happened;
  nothing on the site is ever computed from today's date, which is what keeps two builds of one
  input byte-identical. A closed milestone shows both days and how long it took, one in flight
  shows its start day alone, and one not yet begun shows nothing. `completed` may not be recorded
  without `started`, and may not be earlier than it.

- **The plan and acceptance files a manifest names** — `m1-plan.md` and the rest, beside
  `workstream.json` in the same workstream directory; a manifest pointing at one that doesn't
  exist fails the build.

- **The authorities under `docs/design/`** (or wherever a project keeps them) — ordinary content
  under `docs/`, rendered or copied exactly like every other file there; see "What a project
  publishes" below for the exact rule.

`src/schema.mjs` is the authoritative source for this shape — every field above, and every
validation error message, comes from its `validateConfig` and `validateWorkstream` functions.

## Putting a feature on the sheet

Promoting an idea from a design note onto the feature planning page is **two steps, in this
order**. Until #780 it was neither written down nor prompted for, which is why this section
exists: a procedure nobody can find is a procedure that gets half-done.

1. **Write the manifest.** `docs/features/<slug>/workstream.json`, following the shape above, plus
   a plan file for every milestone it lists — a milestone naming a plan that does not exist fails
   the build (decision 32), so a feature with no milestones yet is a legitimate and common starting
   point.
2. **Name the slug.** Add `"<slug>"` to the `workstreams` list in `atlas.config.json`, in the
   position you want the feature to appear in. Nothing is re-sorted (decision 20), so the order in
   that list is the order on the page.

**Atlas tells you when the second step has not happened.** A build that finds a
`docs/features/<slug>/` directory the config does not name prints:

```
atlas: warning: docs/features/quasar/ exists but atlas.config.json does not name it, so this
feature is not on the sheet. Add "quasar" to the "workstreams" list to promote it, or delete the
directory if the idea was abandoned.
```

It is a **warning and not a failure**, and the line matters: step 1 legitimately happens before
step 2, so this is the ordinary intermediate state of doing it correctly. Failing here would mean
that starting a promotion breaks the site. The reverse case — a config naming a directory that is
not there — is a broken reference and **does** fail the build.

The warning is not suppressed by `--quiet`, which suppresses build progress; a finding is not
progress. It is also not put on the site itself, deliberately: the pages render records, and a
directory with no manifest behind it is not a record. Atlas showing a feature that nothing supports
is the failure decision 3 exists to prevent, and it is not worth trading for a louder reminder.

## What a project publishes

Atlas renders every Markdown file under `docs/` (and `ROADMAP.md`) as a page, and copies every
other file under `docs/` to the site **verbatim** — standalone HTML documents, the scripts and
stylesheets they load, images, data files. That is what makes decision 10 work: a standalone
document that loads a sibling `support.js` still works once published.

It also means **anything a project puts under `docs/` is published**. Atlas applies no filter of
its own and makes no judgement about what belongs on the site; a file that should not be readable
by everyone who can reach the site should not be under `docs/`. The only exceptions Atlas makes are
`workstream.json` manifests, which are read rather than served, and dot-files and dot-directories,
which are skipped.

Alongside the pages, every build writes five files of its own: `state.json` (above), `tokens.css`,
`order.js` and `deploy.js` copied from the theme, and `staticwebapp.config.json` (below).

## Who can read the site

**Atlas emits a `staticwebapp.config.json` that gates the whole site, so a project that configures
nothing is not public** (decision 7: nothing on an Atlas site is anonymous). Every route requires
the `reader` role, which is granted by Azure Static Web Apps **role invitation** — deliberately not
`authenticated`, which means "signed in to the identity provider" and would put a login page in
front of a public site rather than controlling access to it. The `/.auth/*` endpoints are exempted
first, or the gate would lock a reader out of the gate itself, and an unauthorised visitor is
redirected to sign in rather than shown a bare 401.

The identity provider is Microsoft (`aad`), which is what decision 7 names. **A project using a
different provider, or a different role name, overwrites `staticwebapp.config.json` in its own
deploy step, after the build.** Atlas emits the safe default; it does not read the choice from
`atlas.config.json`.

See `src/swa.mjs`, which is the authoritative source for the emitted file.

## Write-back — answering, not only reading

Decisions 34 to 37. Two endpoints ship beside the site as Azure Static Web Apps **managed
Functions**, in the same deployable and behind the same auth — which is what decision 5 chose
Static Web Apps for, and what the Free tier includes.

| Endpoint               | What it writes                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `POST /api/answer`     | An answer to a question, into `docs/features/<workstream>/open-questions.md`.                  |
| `POST /api/acceptance` | An acceptance result, into the record the milestone's manifest names in `acceptance.record`.   |

**And nothing else.** Decision 35 gives creating issues, approving milestones, editing manifests
and triggering work to the project's own operations console: *two consoles that both act is how
they diverge*. There is no endpoint that sets a milestone's status, and adding one is a decision
rather than a feature.

Atlas keeps no state of its own (decision 37). A write is a commit; the page is rebuilt from that
commit by the ordinary build workflow. There is no database, no cache, no queue and no pending
list — the answer is in the repository or it does not exist.

### Wiring it into a deploy

The action places the Function where a deploy step can name it, and says where:

```yaml
      - uses: jmiedreich-ux/atlas@v1
        id: atlas
        with:
          github-token: ${{ github.token }}

      - uses: Azure/static-web-apps-deploy@v1
        with:
          azure_static_web_apps_api_token: ${{ secrets.AZURE_STATIC_WEB_APPS_API_TOKEN }}
          action: upload
          app_location: .atlas-out
          api_location: ${{ steps.atlas.outputs.api-path }}
          output_location: ""
          skip_app_build: true
```

Set `api-dir` to an empty string for a project that publishes the site without the endpoints, and
nothing is placed.

`api-path` is relative to the **checkout**, not to `project-path`, because that is how the deploy
action reads `api_location` — the same frame of reference as `app_location` beside it. The two are
the same directory only when a project sits at the repository root; a project in a subdirectory
still places its API wherever in the checkout it likes.

### The credential, which may be empty

Writes go through a **GitHub App**, never `GITHUB_TOKEN` (decision 36). The reason is mechanical
rather than a matter of security posture: *a push made with the Actions token does not trigger
workflows*, so the site would never rebuild after its own write and would sit stale, showing the
reader the answer it had just failed to render.

The App's installation credentials live in the Static Web App's **application settings**, and never
in the repository, in a build artifact, or in `state.json`:

| Setting                            | What it holds                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `ATLAS_GITHUB_APP_ID`              | The App's numeric id.                                                                                                                        |
| `ATLAS_GITHUB_APP_INSTALLATION_ID` | The id of the App's installation on the repository.                                                                                          |
| `ATLAS_GITHUB_APP_PRIVATE_KEY`     | The App's private key, PEM. A key pasted into the portal's single-line box with literal `\n`, or one wrapped in base64, is repaired on read.  |
| `ATLAS_REPO`                       | `owner/name`. The only repository a write can reach; no request can name another.                                                            |
| `ATLAS_BRANCH`                     | Optional. Defaults to `master`, which decision 1 builds from.                                                                                |

**Until they are set, the endpoints refuse with `503 credential-unavailable`, naming the settings
that are unset, and the site stays completely readable.** Nothing about reading depends on any of
it: the site is static files that were built before any of it ran.

### Who may write

Reading needs the `reader` role. Writing needs `author` — a separate invitation, so that being able
to read the records is not being able to commit to them.

The caller's identity comes from the `x-ms-client-principal` header Static Web Apps injects, and
from nowhere else. A body field naming a user, or a role, is a value the caller chose; it is
refused by name, along with every other field Atlas does not expect.

**An invitation sets a person's roles rather than adding to them**, so somebody who is to read and
write is invited with `reader,author` in one go. Inviting them with `author` alone takes `reader`
away, and every page then refuses them into a login loop.

**An invitation also names an identity provider, and it has to be the one the deployed site signs
people in with.** Atlas emits Microsoft (`aad`), which is decision 7's — but a project that
overwrites `staticwebapp.config.json` chooses its own, and an invitation issued for the wrong one
grants roles to an identity that never signs in there. Read the `responseOverrides` block of the
`staticwebapp.config.json` the site is actually running: whatever `/.auth/login/<provider>` it
redirects to is the provider to invite with.

**What a refusal looks like from outside is not always the status the Function returned.** The
emitted config turns a 401 into a `302` to the sign-in page — that is what stops an unauthorised
visitor seeing a bare 401 they cannot act on — and the `/api/*` rule refuses a caller without
`author` at the edge, before the Function is reached. So:

| Caller | What comes back |
| ------ | --------------- |
| Signed out | `302` to `/.auth/login/aad` |
| Signed in with `reader` only | `302` — the route rule refuses before the Function sees it |
| `author`, credential unset | `503`, naming the application settings that are missing |
| `author`, credential set | `200` and a commit URL |

The Function's own `401` and `403` are what a caller sees only where the route rule is absent —
a project that overwrote `staticwebapp.config.json` with its own. They are the layer that actually
decides, and they fail safe either way.

### Concurrency

`PUT /repos/{owner}/{repo}/contents/{path}` carries the SHA the record had when Atlas read it,
which both commits and gives optimistic concurrency for free. A stale SHA is a **conflict** — `409`,
saying so — and never a silent overwrite of somebody else's commit. A request may also carry the
`sha` its page was rendered from, and then a record that moved on in between is refused before
anything is attempted.

### The register's shape

A question is a heading whose first word is its id:

```markdown
## Q1 · Does the cutover run per tenant or per environment?

Raised while planning the second milestone.
```

An answer is written into that question's own section, between HTML comments that GitHub renders as
nothing:

```markdown
<!-- atlas:answer -->
**Answer** (someone@example.com):

Per tenant.
<!-- /atlas:answer -->
```

Answering again replaces that block rather than adding a second — the register says what is
settled, and git already holds how it got there. Nothing outside the block is touched, and nothing
in the write path reads the clock.

### The routes, and the runtime

Both are emitted, not written down. `src/swa.mjs` puts an `/api/*` rule requiring `author` **before**
the site's `/*` rule requiring `reader` — route rules are first-match-wins, so the order is the
whole thing — and declares `platform.apiRuntime`. A project that configures nothing gets both.

Nothing here needs hand-editing after a build, and that is deliberate: `staticwebapp.config.json`
is written into the **output** directory, which every build replaces wholesale, so "add this rule
afterwards" would be advice about a file that does not persist. A project that needs different
rules — a different identity provider, a different role name — overwrites the file in its own
deploy step, after the Atlas step and before the deploy step, exactly as **Who can read the site**
above describes.

**The runtime is not the build's runtime.** Atlas builds on Node 22: `package.json` says `22.x`,
`action.yml` installs 22, CI runs 22. That is GitHub Actions. The managed Function runs in Azure,
on whatever Static Web Apps offers managed Functions, and `API_RUNTIME` in `src/swa.mjs` is the one
line that says which — currently `node:20`. Raise it to `node:22` when the platform offers it; the
Function's code is plain ESM and runs unchanged on any of them.

**If the endpoints 404 or 500 after a deploy, check two things, in this order.**

1. **Was an API deployed at all?** If the workflow passes no `api_location` — or passes one that
   does not resolve inside the checkout — Static Web Apps publishes the site with no Functions, and
   every `/api/*` request is a plain 404 from the static host. This is the more likely of the two,
   and it looks identical from outside to a Function that failed to start.
2. **Is `platform.apiRuntime` in the config the site is actually running?** A project that
   overwrites `staticwebapp.config.json` after the build discards the emitted one, and with it both
   the runtime declaration and the `/api/*` rule. A missing or unsupported runtime is the most
   common reason a managed Function deploys and then does not answer, and it fails with nothing
   useful in the log.

Fetch `https://<the site>/staticwebapp.config.json` — it is not served, so read it from the
deployment or from whatever step wrote it — rather than assuming the emitted file is the live one.
