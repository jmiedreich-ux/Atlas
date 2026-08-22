// Renders the project's Markdown the way GitHub already renders it (decision 11), because the
// corpus this consumes — 609 files, none carrying frontmatter — renders correctly on GitHub today
// and must not have to change to suit Atlas.
//
// markdown-it is used because it follows CommonMark's actual list-nesting rule — a nested item is
// continued once it is indented past its parent marker's own width, which is two spaces for a
// "- " bullet and three for a "1. " ordinal — rather than a fixed four-space rule that would
// silently flatten the corpus's many two- and three-space nested lists (decision 9).

import MarkdownIt from 'markdown-it';

// The class Task 6's theme targets to make a wide table scroll horizontally instead of the whole
// page (decision 11): the wrapper is added here, in the renderer, because Task 6 depends on it
// existing on every rendered table regardless of layout.
const TABLE_SCROLL_CLASS = 'md-table-scroll';

// A link destination counts as absolute — and is left untouched — when it names its own scheme
// (http:, https:, mailto:, ...) or is protocol-relative ("//host/..."). Anything else is resolved
// against the rendering page's own location.
const ABSOLUTE_HREF_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;

function isAbsoluteHref(href) {
  return ABSOLUTE_HREF_PATTERN.test(href) || href.startsWith('//');
}

// Mirrors the shape of GitHub's own heading slugs closely enough for this corpus: lowercase,
// letters/numbers/marks/underscores/hyphens/spaces survive, everything else is dropped, and
// runs of whitespace become a single hyphen.
function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_\- ]+/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

// The plain-text content of a heading's inline token stream: markup tokens (emphasis, links,
// raw HTML, ...) contribute nothing of their own, but the text inside them still comes through
// because every token in the stream — markup or not — is visited in document order.
function headingPlainText(inlineToken) {
  if (!inlineToken || !inlineToken.children) return '';
  let out = '';
  for (const child of inlineToken.children) {
    if (child.type === 'text' || child.type === 'code_inline') {
      out += child.content;
    } else if (child.type === 'softbreak' || child.type === 'hardbreak') {
      out += ' ';
    }
  }
  return out;
}

// Assigns the next id for `slug`, disambiguating repeats the way GitHub does: the first
// occurrence of a slug keeps it bare, and each further occurrence appends "-1", "-2", ... The
// `usedSlugs` map is per-document state, supplied fresh by the caller so ids never leak between
// unrelated renders.
function nextHeadingId(slug, usedSlugs) {
  const base = slug || 'section';
  const count = usedSlugs.get(base) || 0;
  usedSlugs.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

// A core rule, run during parsing (so both `.render()` and `.parse()` see it): walks the token
// stream once, and for every heading assigns a stable `id` attribute derived from its own plain
// text and position among same-slug headings in this document — never from a running index alone,
// so a heading keeps its id across a rebuild as long as neither its text nor its position among
// same-named headings changes. This is what keeps a `#d15`-style deep link into a decisions
// document working.
function assignHeadingIds(state) {
  const usedSlugs = state.env.__mdHeadingSlugs || (state.env.__mdHeadingSlugs = new Map());
  const { tokens } = state;
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].type === 'heading_open') {
      const text = headingPlainText(tokens[i + 1]);
      const id = nextHeadingId(slugify(text), usedSlugs);
      tokens[i].attrSet('id', id);
    }
  }
}

// Resolves a relative link destination against `hrefBase` (the rendering page's own location, a
// slash-separated path relative to the site root, no leading or trailing slash) into a
// site-root-absolute path. A `.md` target becomes the generated page's own URL — Atlas emits
// clean, directory-style URLs, so `other.md` becomes `/other/`. Anything else (`.html` included)
// is left as the resolved root-absolute path, because decision 10 copies standalone HTML
// byte-for-byte to that same location rather than rendering it, so the link must point at the
// copied file, not a page Atlas never produces.
function rewriteHref(raw, hrefBase) {
  if (!raw || raw.startsWith('#') || isAbsoluteHref(raw)) {
    return raw;
  }

  const baseDir = String(hrefBase || '').replace(/^\/+/, '').replace(/\/+$/, '');
  const base = new URL(`http://atlas.invalid/${baseDir ? `${baseDir}/` : ''}`);

  let resolved;
  try {
    resolved = new URL(raw, base);
  } catch {
    // Not a URL this can make sense of (e.g. a bare fragment-like string malformed some other
    // way) — leave it exactly as written rather than guess.
    return raw;
  }

  let { pathname } = resolved;
  if (/\.md$/i.test(pathname)) {
    pathname = pathname.replace(/\.md$/i, '/');
  }
  return pathname + resolved.search + resolved.hash;
}

function buildMarkdownIt() {
  const md = new MarkdownIt({
    html: true, // decision 11/3: raw inline HTML — <sub> citations above all — must survive.
    linkify: true, // GitHub autolinks bare URLs; match that.
    typographer: false, // GitHub does not smarten quotes/dashes in ordinary rendering.
  });

  md.core.ruler.push('atlas_heading_ids', assignHeadingIds);

  const defaultTableOpen =
    md.renderer.rules.table_open ||
    ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
  const defaultTableClose =
    md.renderer.rules.table_close ||
    ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));

  md.renderer.rules.table_open = (tokens, idx, options, env, self) =>
    `<div class="${TABLE_SCROLL_CLASS}">${defaultTableOpen(tokens, idx, options, env, self)}`;
  md.renderer.rules.table_close = (tokens, idx, options, env, self) =>
    `${defaultTableClose(tokens, idx, options, env, self)}</div>`;

  const defaultLinkOpen =
    md.renderer.rules.link_open ||
    ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));

  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const hrefIndex = token.attrIndex('href');
    if (hrefIndex >= 0) {
      token.attrs[hrefIndex][1] = rewriteHref(token.attrs[hrefIndex][1], env.hrefBase);
    }
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  return md;
}

// One instance is enough: all per-document state (heading-id dedupe, hrefBase) lives on the
// `env` object markdown-it creates fresh for each `.render()`/`.parse()` call, never on the
// instance itself, so nothing leaks between unrelated documents.
const markdownIt = buildMarkdownIt();

/**
 * Render Markdown the way GitHub renders it (decisions 9, 11): two- and three-space nested lists,
 * raw inline HTML (including `<sub>` citations), pipe tables, and fenced code with its language
 * preserved. Relative links are rewritten to Atlas's own URLs; absolute links and same-page
 * fragments are left untouched.
 *
 * @param {string} text - the Markdown source.
 * @param {{ hrefBase?: string }} [options] - `hrefBase` is the rendering page's own location, as
 *   a slash-separated path relative to the site root (e.g. `docs/features/beacon`), used to
 *   resolve the relative links in `text`. Defaults to the site root.
 * @returns {string} HTML.
 */
export function renderMarkdown(text, { hrefBase = '' } = {}) {
  return markdownIt.render(text, { hrefBase });
}

/**
 * The headings in `text`, in document order, with the same stable ids `renderMarkdown` assigns
 * them — so a table of contents (or a `#d15`-style deep link) built from this always matches what
 * actually rendered.
 *
 * @param {string} text - the Markdown source.
 * @returns {{ id: string, text: string, level: number }[]}
 */
export function headingAnchors(text) {
  const tokens = markdownIt.parse(text, {});
  const anchors = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].type === 'heading_open') {
      const id = tokens[i].attrGet('id');
      const level = Number(tokens[i].tag.slice(1));
      anchors.push({ id, text: headingPlainText(tokens[i + 1]), level });
    }
  }
  return anchors;
}
