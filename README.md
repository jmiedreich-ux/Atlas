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
| `github-token` | no       | *(none)*               | A token used to fetch each workstream's open issues and pull requests. There is no safe default, so it is left unset rather than defaulted: without it, the build still succeeds — `src/github.mjs` tolerates GitHub being unreachable — but the requests are unauthenticated and subject to GitHub's public rate limit. Pass `${{ github.token }}`, as above, to authenticate as the workflow's own run. |

Per decision 46, the version tags (`v1.0.0`, and the `v1` major tag moved forward to it) live in
**this** repository. A consuming project holds none of its own — nothing to bump, nothing to keep
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

Alongside the pages, every build writes three files of its own: `state.json` (above), `tokens.css`
and `order.js` from the theme, and `staticwebapp.config.json`.

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
