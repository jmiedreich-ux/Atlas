# Atlas

Atlas is a reusable generator that turns a project repository into a static site, built from
the repository's own Markdown and its GitHub issues — never hand-maintained. It holds no
project content of its own; a project provides a fixed convention (config and manifests) and
Atlas builds the site from it.

Atlas ships as a versioned composite GitHub Action, consumed in one line:

```yaml
uses: jmiedreich-ux/atlas@v1
```

Full convention documentation — the files a consuming project provides and the shape of its
config — lands in a later milestone task.
