// Eleventy's engine-level configuration (decision 9), applied by `src/build.mjs` to every
// Eleventy instance it creates.
//
// The arrangement here is the whole reason decision 10 holds structurally rather than by
// vigilance. Atlas is a generator that lives in its own repository and holds the layouts and the
// theme (decisions 38, 39); the project it builds holds only content (decision 40). So Eleventy's
// **input directory is the generator's own `theme/`** — never the project — and every page is
// added as a virtual template with an explicit permalink.
//
// Three consequences, in order of how much they matter:
//
//   1. Eleventy never walks the project directory, so it is not merely discouraged from picking
//      up a project's standalone `.html` files as templates: it cannot see them. Those files are
//      copied byte-for-byte by `src/build.mjs` with `copyFileSync` and never reach a template
//      engine at all. Decision 10 is the rule Eleventy would otherwise break silently, and this
//      is the only arrangement in which breaking it is impossible.
//   2. The includes directory is the input directory, and Eleventy excludes its includes
//      directory from template discovery — so the six layouts in `theme/` are available to
//      `{% extends %}` and are never themselves rendered as pages. Remove this line and the
//      layouts become pages.
//   3. The project's Markdown is rendered by `src/markdown.mjs`, not by Eleventy's own Markdown
//      pipeline, because decision 11 requires GitHub's rendering of a corpus that carries no
//      frontmatter. Only `njk` is a template format here; nothing else is even considered.

export default function configureAtlasEleventy(eleventyConfig) {
  // The theme directory is both input and includes. See consequence 2 above.
  eleventyConfig.setIncludesDirectory('.');

  // Nunjucks and nothing else. Markdown belongs to src/markdown.mjs (decision 11), and a project's
  // HTML belongs to copyFileSync (decision 10).
  eleventyConfig.setTemplateFormats(['njk']);

  // `theme/milestone.njk` and `theme/document.njk` take the rendered record as `content`, which is
  // also one of Eleventy's reserved data names — it is what a layout receives from the template it
  // wraps. Atlas uses no Eleventy layouts at all (the six layouts compose with Nunjucks
  // `{% extends %}`), so nothing else ever writes that name and there is nothing to collide with;
  // the alternative is renaming a variable in two reviewed layouts to suit a framework Atlas
  // barely uses.
  eleventyConfig.setFreezeReservedData(false);

  return eleventyConfig;
}
