// Eleventy's engine-level configuration (decision 9), applied by `src/build.mjs` to every
// Eleventy instance it creates.
//
// The layout of the generator's own `theme/` directory is load-bearing, and the reason is worth
// stating precisely, because getting it wrong shipped a build that worked on one machine and
// failed on the runtime CI actually uses.
//
// Atlas is a generator that lives in its own repository and holds the layouts and the theme
// (decisions 38, 39); the project it builds holds only content (decision 40). So Eleventy's
// **input directory is the generator's own `theme/`** — never the project — and every page is
// added as a virtual template with an explicit permalink.
//
//   * Eleventy never walks the project directory. A project's standalone `.html` files are not
//     merely discouraged from being picked up as templates: they cannot be, because nothing that
//     could pick them up ever sees them. They are copied byte-for-byte by `src/build.mjs` with
//     `copyFileSync`, from a list Eleventy is never given. That is decision 10, held structurally.
//   * The six layouts live in `theme/_includes/`, which is Eleventy's **default** includes
//     directory. Eleventy excludes its includes directory from template discovery
//     (`EleventyFiles#getIncludesAndDataDirs`), so the layouts are available to `{% extends %}`
//     and are never rendered as pages of their own.
//
//     They used to sit directly in `theme/` with `setIncludesDirectory('.')`, which looked
//     equivalent and was not: that same method filters with `entry !== this.inputDir`, commented
//     "never ignore the input directory (even if config file returns "" for these)", so when
//     includes equals input Eleventy **skips the exclusion entirely** and discovers every layout
//     as a page. `milestone.njk` then rendered with no `milestone` in scope and the build died.
//     It passed only where the glob happened to match nothing.
//
//     A cwd-relative ignore glob would also work, but `path.relative(process.cwd(), ...)` is the
//     wrong tool here: decision 39 says the generator runs as a composite action, so the working
//     directory is the *consuming project's*, which need not share a filesystem root with the
//     action's own checkout — and where it does not, `path.relative` degrades to an absolute path.
//     A directory name Eleventy already understands needs no path arithmetic at all.
//   * The project's Markdown is rendered by `src/markdown.mjs`, not by Eleventy's own Markdown
//     pipeline, because decision 11 requires GitHub's rendering of a corpus that carries no
//     frontmatter. Only `njk` is a template format here; nothing else is even considered.

export default function configureAtlasEleventy(eleventyConfig) {
  // Nunjucks and nothing else. Markdown belongs to src/markdown.mjs (decision 11), and a project's
  // HTML belongs to copyFileSync (decision 10).
  eleventyConfig.setTemplateFormats(['njk']);

  // Note what is deliberately NOT here: `setFreezeReservedData(false)`. Eleventy reserves a set of
  // data names — `content` among them — and refuses to let a template override one. Atlas hands
  // the rendered record to its layouts as `record` rather than `content` for exactly that reason.
  // Turning the guard off is eight lines cheaper and costs the clear error Eleventy raises the
  // moment a reserved name is written; decision 9 makes Eleventy the engine every page goes
  // through, so its guards stay on.

  return eleventyConfig;
}
