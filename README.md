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
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: jmiedreich-ux/atlas@v1
        with:
          github-token: ${{ github.token }}
```

| Input          | Required | Default              | What it is                                                                                                                                                                        |
| -------------- | -------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project-path` | no       | `${{ github.workspace }}` | The project to build — the checkout that carries `atlas.config.json`, `ROADMAP.md` and `docs/`. The default is the calling workflow's own workspace, which is correct for the ordinary case above and rarely needs overriding. |
| `output-dir`   | no       | `.atlas-out`           | Where the built site is written, relative to the calling workflow's working directory unless given as an absolute path. Wired straight into a later step — `actions/upload-pages-artifact`, an Azure Static Web Apps deploy — that publishes it. |
| `github-token` | no       | *(none)*               | A token used to fetch each workstream's open issues and pull requests. There is no safe default, so it is left unset rather than defaulted: without it, the build still succeeds — `src/github.mjs` tolerates GitHub being unreachable — but the requests are unauthenticated and subject to GitHub's public rate limit. Pass `${{ github.token }}`, as above, to authenticate as the workflow's own run. |

Per decision 46, the version tags (`v1.0.0`, and the `v1` major tag moved forward to it) live in
**this** repository. A consuming project holds none of its own — nothing to bump, nothing to keep
in sync — it only ever points at Atlas's.

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
        "status": "done", "plan": "m1-plan.md", "issue": 101, "pr": 201,
        "acceptance": { "kind": "demo-script", "record": "docs/features/beacon/m1-demo.md" } }
    ] }
  ```

  Every field is required. `id` is the durable, never-renamed identifier (decision 17); `label` is
  its normalised display form, and the two are allowed — expected — to differ. `plan` is a
  filename resolved relative to the workstream's own directory (`docs/features/beacon/m1-plan.md`
  above); it must exist. `issue` and `pr` are GitHub numbers or `null`. `acceptance.record` is
  either `null` or a path relative to the project root, naming a Markdown file elsewhere under
  `docs/` — when it does, the milestone's page links to it. `design` names authorities that live
  outside the repository (decision 21: the Claude Design project, Google Drive) as plain links;
  Atlas never fetches or renders them.

  Two vocabularies are closed, and an unrecognised value fails the build rather than rendering a
  blank chip (decision 32):

  - workstream **`stage`** ∈ `not-started, designing, planned, shipping`
  - milestone **`status`** ∈ `done, next, gated, parked, unplanned`

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
