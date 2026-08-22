# Atlas

Atlas is a reusable generator that turns a project repository into a static site, built from
the repository's own Markdown and its GitHub issues — never hand-maintained. It holds no
project content of its own; a project provides a fixed convention (config and manifests) and
Atlas builds the site from it.

Atlas ships as a versioned composite GitHub Action, consumed in one line:

```yaml
uses: jmiedreich-ux/Atlas@v1
```

Full convention documentation — the files a consuming project provides and the shape of its
config — lands in a later milestone task.

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
