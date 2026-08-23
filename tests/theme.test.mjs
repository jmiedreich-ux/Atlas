import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Nunjucks, declared in devDependencies. It arrives with @11ty/eleventy anyway — it is the engine
// decision 9 names — and this import used to rely on that: on npm's hoisting putting Eleventy's
// transitive copy at the top of node_modules. That holds under `npm ci` and breaks under pnpm,
// Yarn PnP, `--install-strategy=nested`, or any Eleventy release that vendors or swaps it. When it
// broke, the largest test file in the repository died at import with a message pointing at nothing
// in package.json. A devDependency costs no download and keeps decision 9's two RUNTIME
// dependencies exactly two.
import nunjucks from 'nunjucks';

import { loadConfig, resolveWorkstreams } from '../src/config.mjs';
import { milestoneUrl, workstreamUrl } from '../src/build.mjs';
import { CHART, computeChart } from '../src/chart.mjs';
import { formatDay } from '../src/dates.mjs';
import { computeLadder } from '../src/depth.mjs';
import { renderMarkdown, headingAnchors } from '../src/markdown.mjs';
import { TRIAGE_ORDER, orderByTriage } from '../src/triage.mjs';
import { MILESTONE_STATUSES, WORKSTREAM_STAGES, validateWorkstream } from '../src/schema.mjs';

// Every name below is either the fixture's invented nautical vocabulary or invented for this
// test file alone. The generator holds no project content of its own (decision 40), and the
// tests at the bottom of this file are what enforce that.
//
// There is no browser in this environment, so nothing here is a visual check: every assertion is
// against generated HTML text, or against `theme/tokens.css` read and parsed as text.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'fixture');
const THEME_DIR = path.join(REPO_ROOT, 'theme');
// The six layouts live in `theme/_includes/`, Eleventy's default includes directory — which is
// what keeps Eleventy from discovering them as pages of their own. See `.eleventy.js`.
const LAYOUT_DIR = path.join(THEME_DIR, '_includes');

const TOKENS_CSS = readFileSync(path.join(THEME_DIR, 'tokens.css'), 'utf8');

// Task 7 wires Eleventy. Here the same `.njk` files are rendered through Nunjucks directly, so a
// layout can be asserted without standing up the whole pipeline.
const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(LAYOUT_DIR, { noCache: true }), {
  autoescape: true,
});

// --- fixture-derived page data ---------------------------------------------------------------

const config = loadConfig(FIXTURE_ROOT);
const workstreams = resolveWorkstreams(config);
const ladder = computeLadder(workstreams);
const site = { project: config.project, repo: config.repo };

const issues = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'issues.json'), 'utf8'));

function issuesLabelled(label) {
  return issues.filter(
    (item) => !item.pull_request && (item.labels ?? []).some((l) => l.name === label),
  );
}

// --- hand-built workstream entries (the shape resolveWorkstreams produces) ---------------------

function milestone(overrides = {}) {
  return {
    id: 'M1',
    label: 'M1',
    depth: 1,
    title: 'A milestone invented for this test',
    status: 'next',
    plan: 'm1-plan.md',
    issue: null,
    pr: null,
    acceptance: { kind: 'demo-script', record: null },
    ...overrides,
  };
}

// Every manifest this file builds goes through the real schema before a layout renders it. Four
// test files carried their own manifest builder and not one ran through `validateWorkstream`, so a
// field the schema requires could be renamed, or a vocabulary tightened, and these doubles would
// go on rendering a shape the generator no longer accepts.
function validated(candidate) {
  const result = validateWorkstream(candidate);
  assert.ok(
    result.ok,
    `this test's own manifest is not one the generator would accept: ${JSON.stringify(result.errors)}`,
  );
  return result.value;
}

function entry(codename, overrides = {}) {
  const slug = codename.toLowerCase();
  return {
    slug,
    dir: `/fake/${slug}`,
    manifestPath: `/fake/${slug}/workstream.json`,
    manifest: validated({
      codename,
      what: `${codename}, a workstream invented for this test`,
      stage: 'shipping',
      position: 'Invented for this test',
      gate: `Nothing gates ${codename} but this test`,
      label: `workstream:${slug}`,
      design: [{ name: `${slug}/Overview v1`, where: 'design-project' }],
      milestones: [],
      ...overrides,
    }),
  };
}

// The shape `src/build.mjs` hands the layouts: each workstream carrying its own ladder column, its
// own URL, and its milestones already enriched with theirs. Built here rather than hand-made, so a
// layout is rendered against what the build actually produces — and the URLs come from build.mjs's
// own exported helpers, so this cannot become a second URL convention.
function assemble(entries) {
  const ladder = computeLadder(entries);
  return entries.map((stream, index) => ({
    ...stream,
    url: workstreamUrl(stream.slug),
    column: ladder.columns[index],
    milestones: stream.manifest.milestones.map((entry) => ({
      manifest: entry,
      url: milestoneUrl(stream.slug, entry.id),
      planUrl: null,
      recordUrl: null,
      hrefBase: `docs/features/${stream.slug}`,
    })),
  }));
}

// #780 rebuilt this surface out of an HTML table into drawn SVG paths, so what the layout is
// handed is the DRAWING — `src/chart.mjs`'s coordinates and paths — rather than the ladder. The
// layout positions nothing of its own; `tests/chart.test.mjs` checks the geometry, and what is
// checked here is that the drawing reaches the page intact.
function renderDepth(entries) {
  const assembled = assemble(entries);
  return env.render('depth.njk', {
    ...site,
    title: 'Feature planning',
    chart: computeChart(computeLadder(entries), assembled),
  });
}

// Task 7 moved decision 27's mapping out of `mobile.njk` and into `src/triage.mjs`, so the page
// is now handed its cards already classified and already in order. The assertions below are
// unchanged: they still read the rendered HTML, so they pin the same behaviour they always did —
// only the place that decides it moved.
function renderMobile(entries) {
  return env.render('mobile.njk', {
    ...site,
    title: 'Triage',
    triaged: orderByTriage(assemble(entries)),
  });
}

function renderWorkstream(stream, issues = []) {
  return env.render('workstream.njk', {
    ...site,
    title: stream.manifest.codename,
    workstream: assemble([stream])[0],
    issues,
  });
}

const depthHtml = renderDepth(workstreams);
const mobileHtml = renderMobile(workstreams);

const beacon = workstreams.find((w) => w.slug === 'beacon');
const beaconPlan = readFileSync(path.join(beacon.dir, 'm1-plan.md'), 'utf8');

const workstreamHtml = renderWorkstream(beacon, issuesLabelled(beacon.manifest.label));

const milestoneHtml = env.render('milestone.njk', {
  ...site,
  title: 'Milestone 1',
  workstream: assemble([beacon])[0],
  milestone: beacon.manifest.milestones[0],
  record: renderMarkdown(beaconPlan, { hrefBase: 'docs/features/beacon' }),
  anchors: headingAnchors(beaconPlan),
});

const decisionsPath = path.join(FIXTURE_ROOT, 'docs', 'design', 'approved', 'lighthouse-decisions.md');
const decisionsText = readFileSync(decisionsPath, 'utf8');
const documentHtml = env.render('document.njk', {
  ...site,
  title: 'Decisions on record',
  doc: { title: 'Decisions on record', path: 'docs/design/approved/lighthouse-decisions.md' },
  record: renderMarkdown(decisionsText, { hrefBase: 'docs/design/approved' }),
  anchors: headingAnchors(decisionsText),
});

const ALL_PAGES = {
  'depth.njk': depthHtml,
  'mobile.njk': mobileHtml,
  'workstream.njk': workstreamHtml,
  'milestone.njk': milestoneHtml,
  'document.njk': documentHtml,
};

// --- text helpers ------------------------------------------------------------------------------

function stripTags(html) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function attrValues(html, attr) {
  return [...html.matchAll(new RegExp(`${attr}="([^"]*)"`, 'g'))].map((m) => m[1]);
}

// --- CSS parsing ------------------------------------------------------------------------------

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Every declaration block in the stylesheet, flattened, each tagged with whether it sits inside
 * an at-rule (`@media`, `@supports`). That flag is the whole point: a custom property defined
 * only inside a media block is exactly the bug these tests exist to catch.
 */
function parseRules(css) {
  const rules = [];
  const walk = (text, insideAtRule) => {
    let selector = '';
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '{') {
        let depth = 1;
        let j = i + 1;
        while (j < text.length && depth > 0) {
          if (text[j] === '{') depth += 1;
          else if (text[j] === '}') depth -= 1;
          j += 1;
        }
        const body = text.slice(i + 1, j - 1);
        const sel = selector.trim();
        if (sel.startsWith('@')) {
          rules.push({ selector: sel, body, insideAtRule, isAtRule: true });
          walk(body, true);
        } else {
          rules.push({ selector: sel, body, insideAtRule, isAtRule: false });
        }
        selector = '';
        i = j;
        continue;
      }
      if (ch === '}') {
        selector = '';
        i += 1;
        continue;
      }
      selector += ch;
      i += 1;
    }
  };
  walk(stripCssComments(css), false);
  return rules;
}

const CSS_RULES = parseRules(TOKENS_CSS);
const DECLARATION_RULES = CSS_RULES.filter((r) => !r.isAtRule);

function customPropertiesIn(body) {
  return [...body.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]);
}

// A rule's declarations as a sorted [property, value] list, so two blocks can be compared.
function declarationsIn(body) {
  return body
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const at = d.indexOf(':');
      return [d.slice(0, at).trim(), d.slice(at + 1).trim().replace(/\s+/g, ' ')];
    })
    .sort((a, b) => a[0].localeCompare(b[0]));
}

// Tokens defined on a bare `:root` — the only definitions that apply in the unstamped, default
// "system" state, which is the state a page is in when the viewer has made no explicit choice.
const BARE_ROOT_TOKENS = new Set(
  DECLARATION_RULES.filter((r) => !r.insideAtRule && r.selector === ':root').flatMap((r) =>
    customPropertiesIn(r.body),
  ),
);

const VARS_USED = new Set([...TOKENS_CSS.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));

// The four blocks whose whole job is to define the palette, matched exactly rather than by
// prefix: `:root .empty` and `:root[data-theme="dark"] .card` are component rules that merely
// start with `:root`, and a literal colour in either is the bug this distinction exists to catch.
const PALETTE_SELECTORS = new Set([
  ':root',
  ':root:not([data-theme="light"])',
  ':root[data-theme="dark"]',
  ':root[data-theme="light"]',
]);

// --- decision 28: three-state dark mode, done at token level -----------------------------------

test('tokens.css: every var() the stylesheet uses resolves to a token defined on bare :root', () => {
  const undefinedOnBareRoot = [...VARS_USED].filter((name) => !BARE_ROOT_TOKENS.has(name)).sort();
  assert.deepEqual(
    undefinedOnBareRoot,
    [],
    'these tokens are used but have no definition on a bare :root, so they resolve to nothing in ' +
      'the default "system" state, where no data-theme attribute is stamped: ' +
      undefinedOnBareRoot.join(', '),
  );
  assert.ok(VARS_USED.size > 20, `expected the components to be styled through tokens, saw ${VARS_USED.size}`);
});

test('tokens.css: every token a dark block redefines is also defined on bare :root', () => {
  const darkRules = DECLARATION_RULES.filter(
    (r) => r.insideAtRule || /\[data-theme=/.test(r.selector),
  );
  assert.ok(darkRules.length >= 2, 'expected both a media-query block and a [data-theme] block');

  const redefined = new Set(darkRules.flatMap((r) => customPropertiesIn(r.body)));
  assert.ok(redefined.size > 0, 'expected the dark blocks to redefine tokens');

  const onlyInDark = [...redefined].filter((name) => !BARE_ROOT_TOKENS.has(name)).sort();
  assert.deepEqual(
    onlyInDark,
    [],
    `these tokens exist only in a dark block and would be undefined in light: ${onlyInDark.join(', ')}`,
  );
});

test('tokens.css: all three theme states are present — bare :root, a guarded media block, and [data-theme="dark"]', () => {
  assert.ok(
    DECLARATION_RULES.some((r) => !r.insideAtRule && r.selector === ':root'),
    'no bare :root block: the light palette would only exist behind a media query',
  );

  const mediaRule = CSS_RULES.find(
    (r) => r.isAtRule && /@media[^{]*prefers-color-scheme\s*:\s*dark/.test(r.selector),
  );
  assert.ok(mediaRule, 'no (prefers-color-scheme: dark) block');

  const guarded = parseRules(mediaRule.body).some((r) =>
    /^:root:not\(\[data-theme=["']?light["']?\]\)$/.test(r.selector.trim()),
  );
  assert.ok(
    guarded,
    'the prefers-color-scheme block must be guarded as :root:not([data-theme="light"]), or an ' +
      'explicit light choice loses to the system setting',
  );

  assert.ok(
    DECLARATION_RULES.some((r) => /^:root\[data-theme=["']?dark["']?\]$/.test(r.selector.trim())),
    'no :root[data-theme="dark"] block, so an explicit dark choice never wins',
  );
});

test('tokens.css: the dark blocks redefine tokens and nothing else', () => {
  // "Only tokens are redefined here" is the rule that keeps the three states honest. A component
  // rule smuggled into the prefers-color-scheme block would style dark differently from an
  // explicitly-chosen dark, and no other test in this file would notice.
  const mediaRule = CSS_RULES.find(
    (r) => r.isAtRule && /@media[^{]*prefers-color-scheme\s*:\s*dark/.test(r.selector),
  );
  assert.ok(mediaRule, 'no (prefers-color-scheme: dark) block');

  const inside = parseRules(mediaRule.body).filter((r) => !r.isAtRule);
  assert.ok(inside.length > 0, 'the prefers-color-scheme block is empty');

  const strays = inside
    .map((r) => r.selector.trim())
    .filter((selector) => selector !== ':root:not([data-theme="light"])');
  assert.deepEqual(
    strays,
    [],
    `the prefers-color-scheme block must hold nothing but the guarded palette; it also styles: ${strays.join(', ')}`,
  );

  // The same rule stated the other way round: what those blocks declare is tokens, plus the one
  // UA-facing property tokens cannot reach.
  for (const selector of [':root:not([data-theme="light"])', ':root[data-theme="dark"]']) {
    const block = DECLARATION_RULES.find((r) => r.selector.trim() === selector);
    assert.ok(block, `no ${selector} block`);
    const notAToken = declarationsIn(block.body)
      .map(([property]) => property)
      .filter((property) => !property.startsWith('--') && property !== 'color-scheme');
    assert.deepEqual(notAToken, [], `${selector} declares more than tokens: ${notAToken.join(', ')}`);
  }
});

test('tokens.css: the two dark blocks define exactly the same tokens, to the same values', () => {
  // The three-state rule forces the dark palette to be written twice — once behind
  // prefers-color-scheme and once behind an explicit choice. Nothing in CSS keeps the two in
  // step, so this does.
  const mediaRule = CSS_RULES.find(
    (r) => r.isAtRule && /@media[^{]*prefers-color-scheme\s*:\s*dark/.test(r.selector),
  );
  assert.ok(mediaRule, 'no (prefers-color-scheme: dark) block');

  const guarded = parseRules(mediaRule.body).find((r) =>
    /^:root:not\(\[data-theme=["']?light["']?\]\)$/.test(r.selector.trim()),
  );
  const explicit = DECLARATION_RULES.find((r) => /^:root\[data-theme=["']?dark["']?\]$/.test(r.selector.trim()));
  assert.ok(guarded && explicit, 'both dark blocks must exist');

  assert.deepEqual(
    declarationsIn(guarded.body),
    declarationsIn(explicit.body),
    'the system-dark palette and the explicitly-chosen dark palette have drifted apart',
  );
});

test('tokens.css: an explicit theme choice swaps color-scheme too, not just the tokens', () => {
  // The one part of the three-state story tokens cannot reach: scrollbars and default form-control
  // chrome are painted by the UA from color-scheme. With data-theme="dark" stamped under a light
  // system setting, a page whose color-scheme still said "light dark" would resolve to light and
  // paint light chrome on a dark page.
  function schemeOf(selector) {
    const rule = DECLARATION_RULES.find((r) => r.selector.trim() === selector);
    assert.ok(rule, `no ${selector} block`);
    const found = declarationsIn(rule.body).find(([property]) => property === 'color-scheme');
    assert.ok(found, `${selector} never sets color-scheme`);
    return found[1];
  }

  assert.equal(schemeOf(':root'), 'light dark', 'the default state must let the system decide');
  assert.equal(schemeOf(':root:not([data-theme="light"])'), 'dark');
  assert.equal(schemeOf(':root[data-theme="dark"]'), 'dark');
  assert.equal(schemeOf(':root[data-theme="light"]'), 'light');
});

// --- decision 28: the palette is the locked contract's, not an invented one -----------------------

// The Sky UI design-token contract's own light values, transcribed from the locked file. This is a
// second, independent copy on purpose: the point of decision 28 is that Atlas does not drift away
// from the contract, and a test that read the values back out of `tokens.css` would agree with any
// drift. If the contract changes, this table and `tokens.css` both change, deliberately.
const CONTRACT_LIGHT = {
  '--sky-color-primary': '#87ceeb',
  '--sky-color-surface': '#f8fafc',
  '--sky-color-surface-raised': '#ffffff',
  '--sky-color-ink': '#0f172a',
  '--sky-color-secondary': '#e0f2fe',
  '--sky-color-border': '#e2e8f0',
  '--sky-color-text-secondary': '#475569',
  '--sky-color-text-muted': '#64748b',
  '--sky-color-live-surface': '#e0f4e9',
  '--sky-color-off-surface': '#fbe7e5',
  '--sky-color-warning-surface': '#fdf1dc',
  '--sky-color-promotion': '#7c5cbf',
  '--sky-positive-text': '#18603f',
  '--sky-danger-text': '#8a2929',
  '--sky-warning-text': '#7d5911',
  '--sky-color-shell': '#e8eef4',
  '--sky-color-fill-subtle': '#f4f7fa',
  '--sky-color-border-control': '#cbd5e1',
  '--sky-action-link-text': '#1d6fb8',
  '--sky-focus-color': '#096f91',
  '--sky-focus-width': '2px',
  '--sky-focus-offset': '2px',
  // The semantic aliases are `var()` of a palette token in the contract, and must stay that way:
  // an alias flattened to a hex stops following the dark palette.
  '--sky-page-background': 'var(--sky-color-surface)',
  '--sky-card-background': 'var(--sky-color-surface-raised)',
  '--sky-text-primary': 'var(--sky-color-ink)',
  '--sky-text-secondary': 'var(--sky-color-text-secondary)',
  '--sky-text-muted': 'var(--sky-color-text-muted)',
  '--sky-badge-background': 'var(--sky-color-secondary)',
  '--sky-badge-text': 'var(--sky-color-ink)',
  '--sky-focus-ring': 'var(--sky-focus-width) solid var(--sky-focus-color)',
  // Spacing and shape, which the contract also fixes. Atlas used to carry three of these names at
  // different values, which is the same collision the colours had.
  '--sky-space-1': '0.25rem',
  '--sky-space-2': '0.5rem',
  '--sky-space-3': '0.75rem',
  '--sky-space-4': '1rem',
  '--sky-space-5': '1.5rem',
  '--sky-space-6': '2rem',
  '--sky-space-7': '3rem',
  '--sky-radius-sm': '0.5rem',
  '--sky-radius-md': '0.75rem',
  '--sky-radius-lg': '1rem',
  '--sky-radius-pill': '999px',
  '--sky-card-radius': 'var(--sky-radius-lg)',
};

// The one shadow the contract does not define at this weight; its light value is the contract's
// card elevation, checked separately because its value is a list rather than a single token.
const CONTRACT_SHADOW = '--sky-shadow-card';

function bareRootDeclarations() {
  const rule = DECLARATION_RULES.find((r) => !r.insideAtRule && r.selector === ':root');
  assert.ok(rule, 'no bare :root block');
  return new Map(declarationsIn(rule.body));
}

// The contract's own dark set — `:root[data-sky-theme="midnight"]` in the locked file — transcribed
// the same way and for the same reason as CONTRACT_LIGHT above. Half the palette was undefended:
// the only dark assertions were "a dark block exists" and "it redefines more than ten tokens", so
// nudging --sky-color-surface off midnight's #111827 in BOTH dark blocks survived green. That is
// precisely the defect finding I7 was raised about, and it applied to dark as much as to light.
const CONTRACT_MIDNIGHT = {
  '--sky-color-surface': '#111827',
  '--sky-color-surface-raised': '#1e293b',
  '--sky-color-ink': '#f8fafc',
  '--sky-color-secondary': '#17344a',
  '--sky-color-border': '#475569',
  '--sky-color-text-secondary': '#cbd5e1',
  '--sky-color-text-muted': '#94a3b8',
  '--sky-color-live-surface': '#123d2d',
  '--sky-color-off-surface': '#4a2024',
  '--sky-color-warning-surface': '#493518',
  '--sky-positive-text': '#65d99c',
  '--sky-danger-text': '#ff8a83',
  '--sky-warning-text': '#f4c15d',
  '--sky-badge-text': '#f8fafc',
  '--sky-focus-color': '#38bdf8',
};

// The tokens midnight does NOT define, which Atlas therefore has to derive. Listed by name so that
// the derived set cannot grow, shrink, or lose its explanation without a test noticing: a derived
// colour with no note is one nobody can audit, and deleting the notes used to be free.
const DERIVED_IN_DARK = {
  '--sky-color-promotion': '#c3b6ef',
  '--sky-color-shell': '#0d1523',
  '--sky-color-fill-subtle': '#182234',
  '--sky-color-border-control': '#6b7c93',
  '--sky-action-link-text': '#7dd3fc',
  '--sky-shadow-card': '0 1px 2px rgb(0 0 0 / 0.5), 0 10px 24px rgb(0 0 0 / 0.45)',
  '--atlas-tone-exploring-bg': '#2a2247',
  // The feature planning drawing's two carrying states (#780). Derived rather than quoted because
  // the contract names neither: the drawing's states are not the contract's. `--atlas-tone-ahead`
  // and `--atlas-tone-stopped` are absent here on purpose — both are aliases of contract tokens
  // and move with the palette, so restating them in dark would be a second place to get wrong.
  '--atlas-tone-done': '#5fa8d8',
  '--atlas-tone-live': '#3fe08f',
};

function darkBlockDeclarations() {
  const blocks = {};
  for (const selector of [':root:not([data-theme="light"])', ':root[data-theme="dark"]']) {
    const rule = DECLARATION_RULES.find((r) => r.selector.trim() === selector);
    assert.ok(rule, `no ${selector} block`);
    blocks[selector] = new Map(declarationsIn(rule.body));
  }
  return blocks;
}

test('tokens.css: the dark palette carries the contract\'s own midnight values', () => {
  for (const [selector, declared] of Object.entries(darkBlockDeclarations())) {
    for (const [name, expected] of Object.entries(CONTRACT_MIDNIGHT)) {
      assert.equal(
        declared.get(name),
        expected,
        `${selector}: ${name} does not match the locked contract's midnight set`,
      );
    }
  }
});

test('tokens.css: the dark palette redefines exactly the contract\'s tokens and the derived ones', () => {
  // Neither list may quietly grow. A token added to dark that is in neither is either a midnight
  // value nobody transcribed or a derivation nobody explained.
  const accountedFor = [...Object.keys(CONTRACT_MIDNIGHT), ...Object.keys(DERIVED_IN_DARK)].sort();

  for (const [selector, declared] of Object.entries(darkBlockDeclarations())) {
    const redefined = [...declared.keys()].filter((name) => name.startsWith('--')).sort();
    assert.deepEqual(
      redefined,
      accountedFor,
      `${selector}: the dark palette and these two tables disagree about what dark redefines`,
    );

    for (const [name, expected] of Object.entries(DERIVED_IN_DARK)) {
      assert.equal(declared.get(name), expected, `${selector}: the derived value for ${name} moved`);
    }
  }
});

test('tokens.css: every derived dark value says what it was derived from', () => {
  // Deleting five of the seven DERIVED: notes used to survive green. The note is the only thing
  // separating an invented colour from a quoted one, so each is checked against the token it
  // introduces rather than counted in aggregate.
  // The guarded block's raw text, comments intact — brace-counted rather than matched with a
  // regex, because a greedy one runs straight past the closing brace into the explicit dark block,
  // where the same tokens are restated WITHOUT their notes. That is not a hypothetical: it is what
  // the first draft of this test did, and it reported every note missing.
  // Anchored at the start of a line, because the file's own header comment DESCRIBES this block in
  // prose — an unanchored search matches the description, and the brace count then isolates the
  // light palette instead. That too is what the first draft did.
  const opensAt = TOKENS_CSS.search(/^@media[^{]*prefers-color-scheme\s*:\s*dark[^{]*\{/m);
  assert.notEqual(opensAt, -1, 'no (prefers-color-scheme: dark) block in the raw stylesheet');
  const cursor = TOKENS_CSS.indexOf('{', opensAt);
  let depth = 0;
  let closesAt = cursor;
  for (; closesAt < TOKENS_CSS.length; closesAt += 1) {
    if (TOKENS_CSS[closesAt] === '{') depth += 1;
    else if (TOKENS_CSS[closesAt] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const guarded = TOKENS_CSS.slice(cursor + 1, closesAt);
  assert.ok(guarded.includes('color-scheme: dark'), 'the guarded block was not isolated');
  assert.ok(
    !guarded.includes('[data-theme="dark"]'),
    'the guarded block was not isolated — it ran into the explicit dark block',
  );

  // Walked line by line over the RAW text: a DERIVED: note opens, and the next token definition is
  // the one it explains.
  const noteFor = new Map();
  let pending = false;
  for (const line of guarded.split('\n')) {
    if (line.includes('DERIVED:')) pending = true;
    const definition = /^\s*(--[\w-]+)\s*:/.exec(line);
    if (definition) {
      noteFor.set(definition[1], pending);
      pending = false;
    }
  }

  for (const name of Object.keys(DERIVED_IN_DARK)) {
    assert.equal(
      noteFor.get(name),
      true,
      `${name} is derived — midnight does not define it — but carries no DERIVED: note saying from what`,
    );
  }
  for (const name of Object.keys(CONTRACT_MIDNIGHT)) {
    assert.equal(
      noteFor.get(name),
      false,
      `${name} is marked DERIVED, but the contract's midnight set defines it — it should be quoted, not invented`,
    );
  }
});

// --- #780: a colour for done, and stopped told apart from in progress -------------------------

// The four states the feature planning drawing has to say apart WITHOUT the reader consulting the
// key beneath it. Named here as the drawing's own tokens rather than read out of the stylesheet,
// because a list read from the file it is checking agrees with any drift in it.
const CHART_TONES = ['--atlas-tone-done', '--atlas-tone-live', '--atlas-tone-ahead', '--atlas-tone-stopped'];

test('tokens.css: the chart’s four states are four different colours, in light and in dark', () => {
  // #780: "a colour for done — finished work needs its own arrow colour, distinct from in
  // progress", and "stopped and in progress were clearer in the earlier mock than they are now."
  //
  // M2.1 drew finished work in `--sky-action-link-text`, so a finished ribbon was the same ink as
  // every link on the page and had no colour of its own at all. The drawing now has four tokens,
  // and this checks the only property that makes them worth having: that they differ.
  const resolve = (declared, name, fallback) => {
    let value = declared.get(name) ?? fallback.get(name);
    // A token defined as an alias moves with the palette; follow it to the colour it lands on.
    for (let hops = 0; hops < 5 && /^var\(/.test(value ?? ''); hops += 1) {
      const alias = /^var\(\s*(--[\w-]+)/.exec(value)[1];
      value = declared.get(alias) ?? fallback.get(alias);
    }
    return value;
  };

  const light = bareRootDeclarations();
  const states = { light: [light, light], ...darkBlockDeclarations() };

  for (const [selector, declared] of Object.entries(states)) {
    const block = Array.isArray(declared) ? declared[0] : declared;
    const values = CHART_TONES.map((name) => {
      const value = resolve(block, name, light);
      assert.ok(value, `${selector}: ${name} resolves to nothing`);
      return value.toLowerCase();
    });
    assert.equal(
      new Set(values).size,
      CHART_TONES.length,
      `${selector}: two of the chart's four states are drawn in the same colour — ${values.join(', ')}`,
    );
  }
});

test('tokens.css: finished work has an arrow colour of its own, not the page’s link colour', () => {
  // The specific thing #780 asked for. Aliasing the link token would satisfy "there is a token
  // called done" while changing not one pixel, so what is checked is the VALUE.
  const light = bareRootDeclarations();
  // Asserted present FIRST. `notEqual(undefined, '#1d6fb8')` passes, so without this the guard
  // below could never fail — which is the shape of defect this milestone was warned about twice.
  assert.ok(light.get('--atlas-tone-done'), 'the drawing has no token for finished work at all');
  assert.ok(light.get('--sky-action-link-text'), 'the contract has no link colour to compare against');
  assert.notEqual(
    light.get('--atlas-tone-done'),
    light.get('--sky-action-link-text'),
    'finished work is still drawn in the link colour, which is what #780 called having no colour of its own',
  );
  assert.notEqual(
    light.get('--atlas-tone-done'),
    'var(--sky-action-link-text)',
    'finished work still resolves to the link colour through an alias',
  );
});

test('tokens.css: the key beneath the chart is drawn from the same tokens as the chart', () => {
  // A key that disagrees with the drawing is worse than no key. It disagreed: the swatches were
  // coloured from the link blue and the positive green while the ribbons moved to their own
  // tokens, and — worse — the drawing's own rules listed `.key-swatch` alongside the ribbons and
  // set `fill` on it, which does nothing at all to a `<span>`. So the key had TWO rules, one inert
  // and one stale, and looked plausible in the stylesheet either way.
  const declarationFor = (selector, property) => {
    const rules = DECLARATION_RULES.filter((r) => r.selector.trim() === selector);
    assert.ok(rules.length > 0, `no ${selector} rule`);
    const found = rules
      .map((r) => new Map(declarationsIn(r.body)).get(property))
      .filter(Boolean);
    assert.equal(found.length, 1, `${selector} sets ${property} in ${found.length} places, not one`);
    return found[0];
  };

  for (const tone of ['done', 'live', 'ahead']) {
    assert.equal(
      declarationFor(`.key-swatch.tone-${tone}`, 'background'),
      `var(--atlas-tone-${tone})`,
      `the key's "${tone}" swatch is not the colour the drawing uses for it`,
    );
  }
  assert.match(
    declarationFor('.key-skip', 'border'),
    /var\(--atlas-tone-stopped\)/,
    "the key's skipped swatch is not the colour the drawing marks a stopped milestone in",
  );
});

test('tokens.css: the ribbon going round a stopped milestone is a ribbon, not a hairline', () => {
  // #780's approved mock: "the ribbon leaves its lane, curves around a crossed circular marker
  // sitting in the milestone's row, and rejoins below it." M2.1 drew that at a 10px stroke against
  // a 36px ribbon and left a comment claiming it was "the same weight as the body it bridges",
  // which was false — so a stopped milestone read as the ribbon ENDING and a hairline appearing,
  // and that is the separation between stopped and in progress that the build lost.
  const rule = DECLARATION_RULES.find((r) => r.selector.trim() === '.ribbon-detour');
  assert.ok(rule, 'no .ribbon-detour rule at all');
  const width = Number(new Map(declarationsIn(rule.body)).get('stroke-width'));
  assert.ok(Number.isFinite(width), 'the detour has no stroke-width');
  assert.ok(
    width >= CHART.ribbonWidth / 2,
    `the detour is drawn at ${width} against a ${CHART.ribbonWidth} ribbon, which reads as a break rather than a way round`,
  );
  // And it must still be narrower than the ribbon: it is the work going ROUND, not more of it.
  assert.ok(width < CHART.ribbonWidth, 'the detour is as wide as the ribbon, so nothing says the work went round');
});

test('tokens.css: every --sky- token carries the locked contract\'s own light value', () => {
  const declared = bareRootDeclarations();

  for (const [name, expected] of Object.entries(CONTRACT_LIGHT)) {
    assert.equal(
      declared.get(name),
      expected,
      `${name} does not match the locked design-token contract, which is what decision 28 asks for`,
    );
  }
});

test('tokens.css: nothing invented is smuggled into the contract\'s namespace', () => {
  // The defect this replaces: an invented palette using the `--sky-` prefix, so two files
  // disagreed about what `--sky-surface` meant. A token Atlas made up must be `--atlas-`.
  const known = new Set([...Object.keys(CONTRACT_LIGHT), CONTRACT_SHADOW]);
  const invented = [...bareRootDeclarations().keys()]
    .filter((name) => name.startsWith('--sky-'))
    .filter((name) => !known.has(name))
    .sort();

  assert.deepEqual(
    invented,
    [],
    `these are not names the locked contract defines, so they must be --atlas-: ${invented.join(', ')}`,
  );

  // And the converse: Atlas's own tokens exist, and are the only ones outside the contract.
  const atlasOwn = [...bareRootDeclarations().keys()].filter((name) => name.startsWith('--atlas-'));
  assert.ok(atlasOwn.length > 0, "Atlas's own tokens must be namespaced --atlas-");

  const strays = [...bareRootDeclarations().keys()]
    .filter((name) => name.startsWith('--'))
    .filter((name) => !name.startsWith('--sky-') && !name.startsWith('--atlas-'));
  assert.deepEqual(strays, [], `a token in neither namespace: ${strays.join(', ')}`);
});

test('tokens.css: Segoe is kept, as a deliberate divergence that is written down', () => {
  // The contract's --sky-font-family leads with Inter. Decision 28 names Segoe UI, and the owner
  // has confirmed that preference. It is deliberately Atlas's OWN token rather than a
  // redefinition of the contract's, so a later reader cannot mistake it for a stale copy — and
  // the reason is in the file, so nobody "corrects" it back.
  const declared = bareRootDeclarations();

  assert.ok(
    declared.get('--atlas-font-sans')?.startsWith('"Segoe UI"'),
    `the body face must lead with Segoe UI (decision 28); saw ${declared.get('--atlas-font-sans')}`,
  );
  assert.equal(
    declared.get('--sky-font-family'),
    undefined,
    'the contract\'s own font token must not be redefined here: the divergence has to be visible',
  );
  assert.ok(
    /deliberate divergence/i.test(TOKENS_CSS) && /Inter/.test(TOKENS_CSS),
    'the divergence from the contract must be recorded in the file, or it reads as an oversight',
  );
  // No webfont: decision 28's stated reason for choosing it.
  assert.ok(!/@import|@font-face|fonts\.googleapis/.test(TOKENS_CSS), 'Segoe needs no webfont');
});

test('tokens.css: Sky is a fill/focus accent, never text on light', () => {
  // The contract's own rule, in its own words. `--sky-color-primary` is #87ceeb, which cannot
  // carry text on any of the light grounds in this file.
  const asText = DECLARATION_RULES.filter((rule) =>
    declarationsIn(rule.body).some(
      ([property, value]) =>
        /(^|-)color$/.test(property) &&
        property !== 'background-color' &&
        property !== 'border-color' &&
        /var\(\s*--sky-color-primary\s*\)/.test(value),
    ),
  ).map((rule) => rule.selector.trim());

  assert.deepEqual(
    asText,
    [],
    `the contract reserves Sky for fills and focus; these use it as text: ${asText.join(', ')}`,
  );

  // And it IS used as a fill somewhere, or the accent has simply been dropped.
  assert.ok(
    /var\(\s*--sky-color-primary\s*\)/.test(TOKENS_CSS.slice(TOKENS_CSS.indexOf('box-sizing'))),
    'the Sky accent is defined but never used as a fill',
  );
});

test('tokens.css: every token the dark set derives is one the contract has no dark value for', () => {
  // The contract's dark set is `[data-sky-theme="midnight"]`. Everything Atlas redefines for dark
  // is either taken from it verbatim or marked DERIVED with what it was derived from — so a
  // reader can tell an invented colour from a quoted one.
  const explicit = DECLARATION_RULES.find((r) =>
    /^:root\[data-theme=["']?dark["']?\]$/.test(r.selector.trim()),
  );
  assert.ok(explicit, 'no :root[data-theme="dark"] block');

  const redefined = declarationsIn(explicit.body)
    .map(([property]) => property)
    .filter((property) => property.startsWith('--'));
  assert.ok(redefined.length > 10, 'the dark palette must actually redefine the palette');

  // Every DERIVED marker in the file names a token, and every token it names is redefined in dark.
  const derivedNote = /DERIVED:/g;
  const notes = TOKENS_CSS.match(derivedNote) ?? [];
  assert.ok(notes.length > 0, 'a derived dark value with no note is an invented colour nobody can audit');
});

// --- computed contrast, in both themes ------------------------------------------------------------
//
// There is no browser here, so this is arithmetic on the hex values in `tokens.css` — WCAG 2.1's
// relative-luminance formula — not a measurement of a rendered page. It is still the check that
// would have caught what it caught: six pairings that actually occur in the built markup computed
// under AA's 4.5, and no test could see any of them.
//
// The two halves that CAN drift are both read from the stylesheet: what each token resolves to in
// each theme, and which token each class takes its colour and its ground from. Only the third —
// which text class sits on which ground — is written down here, because that lives in the layouts
// and there is no DOM to ask. It was derived by scanning the built fixture site.

function relativeLuminance(hex) {
  const compact = hex.replace('#', '');
  const full = compact.length === 3 ? [...compact].map((c) => c + c).join('') : compact;
  const channels = [0, 2, 4]
    .map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground, background) {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort(
    (a, b) => b - a,
  );
  return (lighter + 0.05) / (darker + 0.05);
}

// Token -> hex, for one theme, following `var()` aliases as the cascade would.
function palette(theme) {
  const bare = bareRootDeclarations();
  const values = new Map(bare);
  if (theme === 'dark') {
    const dark = DECLARATION_RULES.find((r) => /^:root\[data-theme=["']?dark["']?\]$/.test(r.selector.trim()));
    assert.ok(dark, 'no :root[data-theme="dark"] block');
    for (const [name, value] of declarationsIn(dark.body)) values.set(name, value);
  }

  const resolve = (name, seen = new Set()) => {
    assert.ok(!seen.has(name), `${name} resolves in a circle`);
    const raw = values.get(name);
    assert.ok(raw, `${name} is used but defined nowhere`);
    const alias = /^var\(\s*(--[\w-]+)\s*\)$/.exec(raw.trim());
    return alias ? resolve(alias[1], new Set([...seen, name])) : raw.trim();
  };
  return resolve;
}

// Which token a class takes its text colour, and its ground, from — read from the component rules
// so that changing a rule changes what this test measures.
//
// `fill` counts as both. Half this stylesheet now paints an SVG (#780), where text takes its
// colour from `fill` and a shape takes its ground from `fill` as well; what matters is which token
// the paint comes from, not which property name CSS uses for it. Resolved across EVERY rule for
// the selector, last declaration winning, as the cascade would — the tone classes are deliberately
// grouped into shared rules, and a lookup that stopped at the first would read the wrong one.
function tokenFor(selector, property) {
  const rules = DECLARATION_RULES.filter((r) => r.selector.split(',').some((s) => s.trim() === selector));
  assert.ok(rules.length > 0, `no rule for ${selector}`);

  const wanted = property === 'color' ? ['color', 'fill'] : ['background', 'background-color', 'fill'];
  let raw;
  for (const rule of rules) {
    for (const [name, value] of declarationsIn(rule.body)) {
      if (wanted.includes(name)) raw = value;
    }
  }
  assert.ok(raw, `${selector} sets no ${property}`);
  const token = /var\(\s*(--[\w-]+)\s*\)/.exec(raw);
  assert.ok(token, `${selector}'s ${property} is not a token: ${raw}`);
  return token[1];
}

// Text class on ground class. Derived by scanning the built fixture site for which text-bearing
// class actually appears inside which painted container — not by pairing tokens by role, which is
// how five of the six failures went unnoticed: `--sky-text-muted` is fine on the contract's plain
// surfaces (4.55, 4.76) and fails on the status tints these labels actually sit on.
//
// #780 rebuilt the first surface out of an HTML table into drawn SVG, so the pairings on it are
// now SVG text on an SVG fill: a `fill` rather than a `color`, and a `fill` rather than a
// `background`. `tokenFor` below reads both, because what matters is which token the paint comes
// from and not which property name CSS happens to use for it.
const OCCURRING_PAIRS = [
  // The ladder gutter paints its own opaque ground so the lanes do not show through it.
  ['.lad-stage', '.ladder-ground'],
  ['.lad-num', '.ladder-ground'],
  ['.band-name', '.ladder-ground'],
  ['.col-h', '.lane-head-box'],
  ['.chip-text', '.chip-box'],
  // The dates, the skip note and the balloon all sit over the execution band, which is the tint
  // that covers the whole bottom of the drawing.
  ['.dt', '.band-execution'],
  ['.dt-b', '.band-execution'],
  ['.skip-t', '.band-execution'],
  ['.skip-t', '.skip-ring'],
  ['.bl-k', '.balloon-body'],
  ['.balloon.tone-live .bl-k', '.balloon-body'],
  ['.bl-t', '.balloon-body'],
  ['.meta-label', '.gate-callout'],
  ['.meta-label', '.contents'],
  ['.card-what', '.card'],
  ['.track-count', '.card'],
  ['.lede', 'body'],
  ['.breadcrumb', 'body'],
  ['.chip-done', '.chip-done'],
  ['.chip-awaiting-decision', '.chip-awaiting-decision'],
  ['.chip-parked', '.chip-parked'],
  ['.chip-blocked', '.chip-blocked'],
  ['.chip-designing', '.chip-designing'],
  ['.chip-next', '.chip-next'],
  ['.chip-unplanned', '.chip-unplanned'],
];

test('tokens.css: every text-on-ground pairing the site actually renders clears WCAG AA', () => {
  // 4.5:1. None of this text is WCAG "large" — the smallest of it is 0.7rem uppercase and the
  // largest 1rem — so the large-text exemption of 3:1 does not apply to any of it.
  const failures = [];

  for (const theme of ['light', 'dark']) {
    const resolve = palette(theme);
    for (const [textSelector, groundSelector] of OCCURRING_PAIRS) {
      const foreground = resolve(tokenFor(textSelector, 'color'));
      const background = resolve(tokenFor(groundSelector, 'background'));
      const ratio = contrastRatio(foreground, background);
      if (ratio < 4.5) {
        failures.push(
          `${theme}: ${textSelector} on ${groundSelector} — ${foreground} on ${background} = ${ratio.toFixed(2)}`,
        );
      }
    }
  }

  assert.deepEqual(failures, [], `these pairings fall under AA:\n  ${failures.join('\n  ')}`);
});

test('tokens.css: the contrast check is reading real colours, not agreeing with itself', () => {
  // The failure mode this whole review has been about. If `palette` or `tokenFor` silently
  // returned the same value for foreground and ground, every ratio would be 1 and the test above
  // would fail loudly rather than pass — but if they returned nothing, `assert.ok` inside them
  // fires. What is checked here is that the arithmetic itself is right, against known answers.
  assert.equal(contrastRatio('#000000', '#ffffff').toFixed(2), '21.00');
  assert.equal(contrastRatio('#ffffff', '#ffffff').toFixed(2), '1.00');
  assert.equal(contrastRatio('#767676', '#ffffff').toFixed(2), '4.54'); // the classic AA boundary
  assert.equal(contrastRatio('#ffffff', '#000000').toFixed(2), '21.00', 'order must not matter');

  // And the pairings really do resolve to different colours in both themes.
  for (const theme of ['light', 'dark']) {
    const resolve = palette(theme);
    for (const [textSelector, groundSelector] of OCCURRING_PAIRS) {
      const foreground = resolve(tokenFor(textSelector, 'color'));
      const background = resolve(tokenFor(groundSelector, 'background'));
      assert.match(foreground, /^#[0-9a-f]{3,8}$/i, `${theme}: ${textSelector} did not resolve to a colour`);
      assert.match(background, /^#[0-9a-f]{3,8}$/i, `${theme}: ${groundSelector} did not resolve to a colour`);
      assert.notEqual(foreground, background, `${theme}: ${textSelector} on ${groundSelector} is invisible`);
    }
  }
});

test('tokens.css: the drawing owns its sideways scroll, and the ladder is pinned to its left edge', () => {
  // #780 rebuilt this surface into two SVGs side by side inside one horizontal scroller: the
  // ladder gutter, which stays put, and the lanes, which scroll under it. The ladder names the row
  // every ribbon is measured against, so a ladder that scrolls away takes the drawing's meaning
  // with it.
  //
  // `left: 0`, NOT `top: 0`. M1's version bounded the box's height so that sticky column headers
  // had a vertical scrollport to resolve against; the drawing is now as tall as it needs to be and
  // the PAGE scrolls it, so there is no vertical scrollport at all and a `top: 0` inside would
  // resolve against a box that can never move — which is exactly the bug M1's own comment
  // described.
  const scroller = DECLARATION_RULES.find((r) => r.selector.split(',').some((x) => x.trim() === '.chart-scroll'));
  assert.ok(scroller, 'no .chart-scroll rule');

  const declarations = new Map(declarationsIn(scroller.body));
  assert.match(scroller.body, /overflow-x\s*:\s*auto/, '.chart-scroll must scroll sideways itself');
  assert.equal(declarations.get('display'), 'flex', 'the ladder and the lanes must sit side by side');
  assert.ok(
    !declarations.has('max-height'),
    'the drawing no longer scrolls vertically, so bounding its height only clips it',
  );

  // Anything claiming an edge of that scrollport must actually be sticky, or the declaration does
  // nothing at all.
  const claimsEdge = new Set(
    DECLARATION_RULES.filter((r) =>
      declarationsIn(r.body).some(([p, v]) => (p === 'left' || p === 'top') && v === '0'),
    ).flatMap((r) => r.selector.split(',').map((x) => x.trim())),
  );
  assert.ok(claimsEdge.has('.planning-ladder'), 'the ladder does not claim the left edge of the scroller');
  for (const selector of claimsEdge) {
    const sticky = DECLARATION_RULES.filter((r) =>
      r.selector.split(',').some((x) => x.trim() === selector),
    ).some((r) => /position\s*:\s*sticky/.test(r.body));
    assert.ok(sticky, `${selector} claims an edge without position: sticky, which does nothing`);
  }
});

test('tokens.css: the pinned ladder paints above the lanes, on a ground they cannot show through', () => {
  // At `z-index: auto` a sticky element paints in DOM order, and the ladder is written FIRST — so
  // every lane would slide over the top of it. And a transparent ground shows the ribbons passing
  // underneath even once the stacking is right.
  const rulesFor = (selector) =>
    DECLARATION_RULES.filter((r) => r.selector.split(',').some((x) => x.trim() === selector));

  const zIndex = rulesFor('.planning-ladder').flatMap((r) =>
    declarationsIn(r.body).filter(([property]) => property === 'z-index'),
  );
  assert.ok(zIndex.length > 0, '.planning-ladder is sticky but sets no z-index, so it paints in DOM order');
  assert.ok(Number(zIndex[zIndex.length - 1][1]) > 0, 'the pinned ladder must paint above the lanes');

  const opaque = rulesFor('.ladder-ground').some((r) => /fill\s*:\s*var\(\s*--[\w-]+\s*\)/.test(r.body));
  assert.ok(opaque, 'the ladder has no opaque ground, so the lanes show through it as they scroll past');
});

test('tokens.css: body sets an explicit background from a token', () => {
  const bodyRules = DECLARATION_RULES.filter((r) =>
    r.selector.split(',').some((s) => s.trim() === 'body'),
  );
  assert.ok(bodyRules.length > 0, 'no body rule at all');

  const declaresBackground = bodyRules.some((r) =>
    /background(-color)?\s*:\s*var\(\s*--[\w-]+\s*\)/.test(r.body),
  );
  assert.ok(
    declaresBackground,
    'body must set its own background from a token; a transparent body borrows whatever ground the host paints',
  );

  const declaresColour = bodyRules.some((r) => /(^|[^-])color\s*:\s*var\(\s*--[\w-]+\s*\)/.test(r.body));
  assert.ok(declaresColour, 'body must set its own text colour from a token too');
});

test('tokens.css: no rule outside :root carries a literal colour', () => {
  // Values only: `white-space` is a property name, not a colour.
  const literal = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\b(white|black|red|green|blue|grey|gray|silver|navy|teal|orange|yellow|purple)\b/;
  const offenders = DECLARATION_RULES.filter((r) => !PALETTE_SELECTORS.has(r.selector.trim()))
    .filter((r) => declarationsIn(r.body).some(([, value]) => literal.test(value)))
    .map((r) => r.selector);
  assert.deepEqual(
    offenders,
    [],
    `these rules hard-code a colour instead of using a token, so they cannot follow the theme: ${offenders.join(', ')}`,
  );
});

test('tokens.css: columns of digits are set in tabular numerals', () => {
  const tabular = DECLARATION_RULES.filter((r) => /font-variant-numeric\s*:\s*tabular-nums/.test(r.body));
  assert.ok(tabular.length > 0, 'nothing asks for tabular numerals, so digits will not line up in columns');
  assert.ok(
    tabular.some((r) => r.selector.includes('.num')),
    `the .num class the layouts put on digits must be tabular; saw: ${tabular.map((r) => r.selector).join(', ')}`,
  );
});

test('tokens.css: wide content scrolls inside its own container, never the page body', () => {
  const scroller = DECLARATION_RULES.find((r) => r.selector.split(',').some((s) => s.trim() === '.chart-scroll'));
  assert.ok(scroller, 'no .chart-scroll rule');
  assert.match(scroller.body, /overflow-x\s*:\s*auto/, '.chart-scroll must scroll horizontally itself');
  assert.match(scroller.body, /max-width\s*:\s*100%/, '.chart-scroll must be bounded by its parent');

  const bodyRules = DECLARATION_RULES.filter((r) => r.selector.split(',').some((s) => s.trim() === 'body'));
  assert.ok(
    bodyRules.some((r) => /overflow-x\s*:\s*hidden/.test(r.body)),
    'body must not scroll sideways',
  );
});

// --- decisions 22/23/24 and #780: the feature planning drawing ----------------------------------
//
// This surface is a DRAWING now, not a table. `tests/chart.test.mjs` checks the geometry — which
// arrows exist, where each ends, that a head grows out of its own body. What is checked here is
// that the drawing reaches the page intact, and that the thing #780 put above everything else on
// its list stays true: it is not a chart and they are not grid cells.

function laneMarkup(html, slug) {
  // A lane is one <g class="lane"> and the next one begins at the next `data-slug`, so the slice
  // between them is exactly this feature's own markup — dots, dates, skip marker and balloon
  // included. Read by splitting rather than by a lazy regex, which would stop at the first nested
  // </g> and silently check a fragment.
  const parts = html.split(/<g class="lane" data-slug="/).slice(1);
  const mine = parts.find((part) => part.startsWith(`${slug}"`));
  assert.ok(mine, `no lane rendered for ${slug}`);
  return mine;
}

test('planning: nothing on this surface is rendered in a table cell', () => {
  // #780's framing, and it sat above everything else on the list: "it was implemented as an HTML
  // table — workstreams as columns, ladder rows as <tr>, every intersection a <td> — and every
  // visual complaint above follows from that." A rebuild that quietly kept one table would
  // reintroduce every one of them.
  for (const tag of ['<table', '<td', '<tr', '<thead', '<tbody', '<caption']) {
    assert.ok(!depthHtml.includes(tag), `the feature planning page still renders ${tag}`);
  }
  assert.match(depthHtml, /<svg[^>]*class="planning-chart"/, 'the features are not drawn at all');
});

test('planning: one lane per feature, in the order computeLadder returned, each placed by one translate', () => {
  const chart = computeChart(ladder, assemble(workstreams));

  const slugs = [...depthHtml.matchAll(/<g class="lane" data-slug="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(slugs, workstreams.map((w) => w.slug), 'the lanes are not the features, in order');

  // One transform per lane, and nothing else positioning it: that is what lets the ordering move a
  // whole feature by rewriting one number.
  const transforms = [...depthHtml.matchAll(/<g class="lane" data-slug="[^"]+" transform="translate\((\d+),0\)"/g)].map(
    (m) => Number(m[1]),
  );
  assert.deepEqual(transforms, chart.lanes.map((lane) => lane.x));

  // And each header links at its own feature.
  workstreams.forEach((stream) => {
    assert.match(
      laneMarkup(depthHtml, stream.slug),
      new RegExp(`<a href="${workstreamUrl(stream.slug)}"><text class="col-h"[^>]*>${stream.manifest.codename}</text></a>`),
      `${stream.slug}'s header links at the wrong feature`,
    );
  });
});

test('planning: the milestone identifiers are in the ladder column, and in no feature’s own lane', () => {
  // #780, correcting an earlier comment of its own: "the milestone ids belong in the ladder column
  // only. Repeating them inside each workstream's cells is the actual problem; the cells should
  // carry fill and nothing else."
  const ladderMarkup = depthHtml.slice(
    depthHtml.indexOf('class="planning-ladder"'),
    depthHtml.indexOf('class="planning-chart"'),
  );
  const captions = [...ladderMarkup.matchAll(/<text class="[^"]*lad-(?:stage|num)[^"]*"[^>]*>([^<]+)<\/text>/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(captions, computeChart(ladder, assemble(workstreams)).rows.map((r) => r.caption));
  assert.ok(captions.includes('M1'), 'the ladder does not name the milestone depths at all');

  // The rule governs what ATLAS SAYS, not what a record says. Decision 2: Atlas is never the
  // record, so it does not edit the owner's own sentences — and a gate reading "Owner sign-off on
  // the M4 demo before M5 starts" is the owner's sentence, quoted verbatim into the balloon. Once
  // the balloon carried the gate, scanning every text node in the lane made this test fail on a
  // manifest doing nothing wrong, which would have been "fixed" by censoring a record.
  //
  // The class on a text node is what tells the two apart, so it is what the exclusion is written
  // against: `col-h`, `bl-s` and `bl-t` carry a record's own words through unaltered; everything
  // else in a lane — the dates, the skip marker's caption and reason — is Atlas composing, and
  // that is where an identifier would be a repetition of the ladder.
  const QUOTED_VERBATIM = /^(?:col-h|bl-s|bl-t)$/;

  for (const stream of workstreams) {
    const lane = laneMarkup(depthHtml, stream.slug);
    // Anywhere in the composed TEXT, not just as a whole text node. The first version of this
    // required an exact `>M3<`, so the skip marker's own "M3 skipped" walked straight past it —
    // which is precisely the repetition the rule forbids.
    const spoken = [...lane.matchAll(/<text class="([^"]*)"[^>]*>([^<]*)<\/text>/g)]
      .filter((m) => !QUOTED_VERBATIM.test(m[1]))
      .map((m) => m[2])
      .join(' | ');
    assert.ok(spoken.length > 0, `${stream.slug}: nothing in this lane is Atlas's own words, so this rule checks nothing`);
    for (const milestone of stream.manifest.milestones) {
      assert.ok(
        !new RegExp(`(?<![\\w.])${milestone.label}(?![\\w.])`).test(spoken),
        `${stream.slug}'s lane says the milestone id ${milestone.label}; that belongs in the ladder alone (lane reads: ${spoken})`,
      );
    }
    assert.ok(!/Passed/.test(lane), `${stream.slug}'s lane still carries the word "Passed"`);
  }
});

test('planning: every measurement on the page came from the drawing, never from the template', () => {
  // The trap this closes, found in review. The template hard-coded a ribbon's left edge as
  // `lane.centre - 18` — half of `CHART.ribbonWidth` — while reading the WIDTH from the drawing.
  // Raising `ribbonWidth` to 44 therefore moved the arrowhead, which is computed, and left the
  // body four pixels off-centre behind it, with the whole suite green. What shipped was correct;
  // the trap was for whoever changed a constant next.
  //
  // So: every number the markup carries is read back and compared against the drawing that was
  // handed to it. A literal written in the template is identical to the emitted value TODAY and
  // diverges the moment the constant it duplicates moves — which is exactly when this fails.
  const chart = computeChart(ladder, assemble(workstreams));

  const attr = (markup, name) => {
    const found = new RegExp(`\\b${name}="(-?[\\d.]+)"`).exec(markup);
    assert.ok(found, `expected a ${name} on: ${markup}`);
    return Number(found[1]);
  };

  // The header, identical for every lane because a lane is drawn about its own origin.
  const heads = [...depthHtml.matchAll(/<rect class="lane-head-box"[^>]*>/g)].map((m) => m[0]);
  assert.equal(heads.length, chart.lanes.length, 'expected one header per feature');
  for (const markup of heads) {
    assert.equal(attr(markup, 'x'), chart.head.x);
    assert.equal(attr(markup, 'width'), chart.head.width);
    assert.equal(attr(markup, 'height'), chart.head.height);
    assert.equal(attr(markup, 'rx'), chart.head.radius);
  }

  // The gutter's row captions.
  const captions = [...depthHtml.matchAll(/<text class="[^"]*lad-(?:stage|num)[^"]*"[^>]*>/g)].map((m) => m[0]);
  assert.equal(captions.length, chart.rows.length);
  captions.forEach((markup, i) => {
    assert.equal(attr(markup, 'x'), chart.ladderCaptionX);
    assert.equal(attr(markup, 'y'), chart.rows[i].captionY);
  });

  for (const lane of chart.lanes) {
    const markup = laneMarkup(depthHtml, lane.slug);
    const bodies = [...markup.matchAll(/<rect class="ribbon-body[^>]*>/g)].map((m) => m[0]);

    // Both ribbons: the body's left edge, its width and its corner radius, all from the drawing.
    for (const [arrow, name] of [
      [lane.solid, 'solid'],
      [lane.faint, 'faint'],
    ]) {
      if (!arrow) continue;
      const mine = bodies.filter((body) => attr(body, 'width') === arrow.width);
      assert.ok(mine.length > 0, `${lane.slug}: no ${name} ribbon body at all`);
      for (const body of mine) {
        assert.equal(attr(body, 'x'), arrow.x, `${lane.slug}: the ${name} body's left edge is not the drawing's`);
        assert.equal(attr(body, 'rx'), arrow.radius, `${lane.slug}: the ${name} body's radius is not the drawing's`);
      }
    }

    // And the property the whole trap turned on: a body is centred under its own head.
    const arrowHeads = [...markup.matchAll(/<path class="ribbon-head[^"]*" d="M (-?[\d.]+) [\d.]+ L (-?[\d.]+) /g)];
    assert.ok(arrowHeads.length > 0, `${lane.slug}: no arrowhead`);
    for (const [, left, right] of arrowHeads) {
      assert.equal(
        (Number(left) + Number(right)) / 2,
        lane.centre,
        `${lane.slug}: an arrowhead is not centred on its own lane`,
      );
    }
    for (const body of bodies) {
      assert.equal(
        attr(body, 'x') + attr(body, 'width') / 2,
        lane.centre,
        `${lane.slug}: a ribbon body is off-centre from the head it grows into`,
      );
    }

    // The dots, their radius, and each date line's own baseline and column.
    const dots = [...markup.matchAll(/<circle class="dot[^"]*"[^>]*>/g)].map((m) => m[0]);
    assert.equal(dots.length, lane.dots.length, `${lane.slug}: wrong number of milestone dots`);
    dots.forEach((dot, i) => {
      assert.equal(attr(dot, 'cx'), lane.centre);
      assert.equal(attr(dot, 'cy'), lane.dots[i].y);
      assert.equal(attr(dot, 'r'), lane.dots[i].r, `${lane.slug}: a dot's radius is not the drawing's`);
    });

    const textLines = [...markup.matchAll(/<text class="(?:dt-b num|dt)"[^>]*>/g)].map((m) => m[0]);
    const emittedBaselines = [
      ...lane.dots.flatMap((d) => d.lines.map((line) => line.y)),
      ...lane.skips.map((s) => s.reasonY),
    ];
    assert.equal(textLines.length, emittedBaselines.length, `${lane.slug}: wrong number of text lines beside the ribbon`);
    for (const line of textLines) {
      assert.equal(attr(line, 'x'), lane.textX, `${lane.slug}: a text line is not in the drawing's own column`);
      assert.ok(emittedBaselines.includes(attr(line, 'y')), `${lane.slug}: a text line sits at a baseline nothing emitted`);
    }

    // The skip markers.
    const rings = [...markup.matchAll(/<circle class="skip-ring"[^>]*>/g)].map((m) => m[0]);
    assert.equal(rings.length, lane.skips.length);
    rings.forEach((ring, i) => {
      assert.equal(attr(ring, 'cy'), lane.skips[i].y);
      assert.equal(attr(ring, 'r'), lane.skips[i].r, `${lane.slug}: a skip marker's radius is not the drawing's`);
    });

    // And the balloon's pin.
    if (lane.balloon) {
      const pin = /<circle class="balloon-pin"[^>]*>/.exec(markup)[0];
      assert.equal(attr(pin, 'cx'), lane.balloon.dot.x);
      assert.equal(attr(pin, 'r'), lane.balloon.dot.r);
    }
  }
});
test('planning: every feature has a ribbon and an arrowhead, drawn as paths rather than glyphs', () => {
  for (const stream of workstreams) {
    const lane = laneMarkup(depthHtml, stream.slug);
    assert.match(lane, /<rect class="ribbon-body tone-/, `${stream.slug} has no ribbon`);
    assert.match(lane, /<path class="ribbon-head tone-[a-z]+" d="M /, `${stream.slug} has no arrowhead`);
    // The M1 failure this replaces: a text glyph standing in for the head.
    assert.ok(!/&#9660;/.test(lane), `${stream.slug} draws its head as a text glyph`);
  }
});

test('planning: the faint second arrow is drawn only where records remain beyond the work', () => {
  const chart = computeChart(ladder, assemble(workstreams));
  for (const lane of chart.lanes) {
    const markup = laneMarkup(depthHtml, lane.slug);
    const heads = [...markup.matchAll(/<path class="ribbon-head tone-/g)].length;
    assert.equal(
      heads,
      lane.faint ? 2 : 1,
      `${lane.slug}: a feature with ${lane.faint ? 'records ahead' : 'nothing recorded ahead'} drew ${heads} heads`,
    );
  }
  assert.ok(chart.lanes.some((l) => l.faint), 'the fixture no longer exercises the faint reach at all');
  assert.ok(chart.lanes.some((l) => !l.faint), 'the fixture no longer exercises the single arrow at all');
});

test('planning: the faint arrow is drawn FIRST, so the solid one is painted on top of it', () => {
  // #780: the two arrows overlay. SVG has no z-index — the painter's order IS the document order —
  // so an overlay that is emitted the wrong way round draws the faint arrow over the solid one and
  // the page shows a pale bar where the work is. `src/chart.mjs` cannot express this; only the
  // order of the elements in the markup can, which is why it is asserted here.
  const chart = computeChart(ladder, assemble(workstreams));
  const withFaint = chart.lanes.filter((l) => l.faint);
  assert.ok(withFaint.length > 0, 'the fixture no longer exercises the overlay at all');

  for (const lane of withFaint) {
    const markup = laneMarkup(depthHtml, lane.slug);
    // The faint body carries the faint arrow's own width; the solid body carries the solid one's.
    const faintBody = markup.indexOf(`<rect class="ribbon-body tone-ahead" x="${lane.faint.x}"`);
    const solidHead = markup.indexOf(`<path class="ribbon-head tone-${lane.solid.head.tone}" d="${lane.solid.head.d}"`);
    const faintHead = markup.indexOf(`<path class="ribbon-head tone-ahead" d="${lane.faint.head.d}"`);
    assert.ok(faintBody >= 0, `${lane.slug}: no faint body in the markup`);
    assert.ok(solidHead >= 0, `${lane.slug}: no solid head in the markup`);
    assert.ok(faintHead >= 0, `${lane.slug}: no faint head in the markup`);
    assert.ok(
      faintBody < solidHead && faintHead < solidHead,
      `${lane.slug}: the faint arrow is painted over the solid one, not under it`,
    );
  }
});

test('planning: a skipped milestone is marked in its own row, with the reason beside it', () => {
  const reef = laneMarkup(depthHtml, 'reef');
  assert.match(reef, /<circle class="skip-ring"/, 'the milestone the work went round was not marked');
  // "Skipped", not "M3 skipped": the marker already sits on that milestone's own row, and #780
  // puts the identifiers in the ladder column and nowhere else.
  assert.match(reef, /<text class="skip-t"[^>]*>Skipped<\/text>/);
  assert.match(reef, /#703 · parked/, 'the marker does not say why, or where to read the reason');
  assert.match(reef, /<path class="ribbon-detour"/, 'the ribbon does not visibly go round the marker');

  // A feature with no gap has none of it.
  assert.ok(!/skip-ring/.test(laneMarkup(depthHtml, 'anchor')), 'a feature with no gap was given a marker');
});

test('planning: the stored dates reach the page beside the milestone they belong to', () => {
  const reef = laneMarkup(depthHtml, 'reef');
  // The span states its year once, because both ends fall in it — see `formatDayRange`.
  assert.match(reef, /4 May → 8 May 2026/, "the closed milestone's two stored days are missing");
  assert.match(reef, /4 days/, 'how long it took is missing');

  const tide = laneMarkup(depthHtml, 'tide');
  assert.match(tide, /in progress/, 'the milestone in flight does not say so');

  // Every date on the page is one on record. Checked as a set rather than against today's year,
  // which the fixture's own dates may share — a guard skipped whenever the fixture is current is
  // a guard that cannot fail in the year anyone runs it.
  const recorded = new Set(
    workstreams.flatMap((w) =>
      w.manifest.milestones.flatMap((m) => [m.started, m.completed].filter(Boolean)),
    ),
  );
  const rendered = [...depthHtml.matchAll(/>(\d{1,2} [A-Z][a-z]{2} \d{4})/g)].map((m) => m[1]);
  assert.ok(rendered.length > 0, 'no dates reached the page at all');
  for (const day of rendered) {
    assert.ok(
      [...recorded].some((iso) => formatDay(iso) === day),
      `the page shows "${day}", which is on no record — something was derived rather than read`,
    );
  }
});

test('planning: a balloon points at the step it describes, and none is drawn with nothing to say', () => {
  const chart = computeChart(ladder, assemble(workstreams));
  for (const lane of chart.lanes) {
    const markup = laneMarkup(depthHtml, lane.slug);
    const drawn = /<g class="balloon tone-/.test(markup);
    assert.equal(drawn, lane.balloon !== null, `${lane.slug}: the balloon and the drawing disagree`);
    if (!lane.balloon) continue;
    assert.ok(
      markup.includes(`<circle class="balloon-pin" cx="${lane.balloon.dot.x}" cy="${lane.balloon.dot.y}"`),
      `${lane.slug}: the balloon does not attach to the ribbon at the step it describes`,
    );
  }
  assert.ok(chart.lanes.some((l) => l.balloon === null), 'the fixture no longer exercises "nothing next, no balloon"');
});

test('planning: the drawing sits inside a horizontally scrolling container, with the ladder pinned to it', () => {
  const scrollIndex = depthHtml.indexOf('class="chart-scroll"');
  const ladderIndex = depthHtml.indexOf('class="planning-ladder"');
  const lanesIndex = depthHtml.indexOf('class="planning-chart"');
  assert.ok(scrollIndex !== -1, 'the drawing is not wrapped in a .chart-scroll container');
  assert.ok(scrollIndex < ladderIndex, 'the .chart-scroll wrapper must come before what it wraps');
  assert.ok(ladderIndex < lanesIndex, 'the ladder must come before the lanes that scroll under it');
});

test('planning: the header block is the title, and the page opens on the chart', () => {
  // #780: "cut the header block on Feature planning to just the title. Remove the explanatory
  // paragraph and the drag/order instruction paragraph, and remove the 'back to the generated
  // order' button from that block. The page should open on the chart, not on two paragraphs
  // explaining it."
  //
  // Checked as a SHAPE rather than by hunting for the two strings that used to be there: whatever
  // sits between the heading and the chart's own controls has to be nothing.
  const heading = depthHtml.indexOf('</h1>');
  const controls = depthHtml.indexOf('<div class="planning-controls">');
  const chart = depthHtml.indexOf('<div class="chart-scroll"');
  assert.ok(heading !== -1, 'the page lost its heading');
  assert.ok(controls !== -1, 'there is no controls strip for the chart');
  assert.ok(controls < chart, 'the chart controls sit below the chart they belong to');

  const between = depthHtml.slice(heading + 5, controls).trim();
  assert.equal(between, '', `the header block still carries prose before the chart: ${between}`);
  assert.ok(!/class="lede"/.test(depthHtml), 'the explanatory paragraph is still in the header block');
});

test('planning: the two things the header block was carrying got honest homes, not deletion', () => {
  // #780 was explicit that removing that block must not drop what it carried. Two things:
  //
  //   * the per-device caveat, which "matters more once ordering is something the owner actually
  //     relies on";
  //   * the reset control, whose home is "beside the feature headers where the ordering happens".
  //
  // And a third the issue does not mention, because it is not visible: the drag/arrow-key
  // instruction is what `aria-describedby` on every feature header points at. Deleting the
  // paragraph would have silently taken the only explanation a screen-reader user gets of how the
  // control works — a visual instruction to remove, not an accessible name to drop.
  // Sliced rather than matched with a lazy regex: the strip holds a nested <div>, so
  // `([\s\S]*?)</div>` would stop at the first inner close and check a third of it.
  const from = depthHtml.indexOf('<div class="planning-controls">');
  const to = depthHtml.indexOf('<div class="chart-scroll"');
  assert.ok(from !== -1 && to > from, 'there is no controls strip');
  const controlsBlock = [null, depthHtml.slice(from, to)];

  assert.match(controlsBlock[1], /this device only/i, 'the per-device caveat has no home a reader will meet');
  assert.match(controlsBlock[1], /<button[^>]*data-order-reset/, 'the reset control is not with the chart');

  // The instruction survives for assistive technology, and the reference still resolves.
  const described = /<g class="lane-head"[^>]*aria-describedby="([^"]+)"/.exec(depthHtml);
  assert.ok(described, 'a feature header no longer describes itself at all');
  const target = new RegExp(`id="${described[1]}"`);
  assert.match(depthHtml, target, `aria-describedby points at ${described[1]}, which is not on the page`);
  const instruction = new RegExp(`<[^>]*id="${described[1]}"[^>]*>([^<]*)`).exec(depthHtml);
  assert.match(instruction[1], /arrow key/i, 'the instruction the header points at no longer explains the keys');
});

test('planning: a hidden feature can never go missing without the page saying so', () => {
  // Decision 49, and the whole risk of the capability: "a page that silently omits a workstream is
  // worse than one that shows too many." The page ships the place where that is said — always in
  // the reader's line of sight, above the chart rather than below it, because a control for
  // getting something back is no use under the thing it is missing from.
  //
  // What is checked here is that the SHIPPED page carries the affordance and the explanation. The
  // behaviour that fills it is `theme/order.js`, whose rules are unit-tested in
  // `tests/order.test.mjs` and which was also driven in a browser for this milestone.
  const from = depthHtml.indexOf('<div class="planning-controls">');
  const to = depthHtml.indexOf('<div class="chart-scroll"');
  const controls = depthHtml.slice(from, to);

  assert.match(controls, /<div class="hidden-bar"[^>]*data-hidden-bar/, 'nothing on the page can say what is hidden');
  // Empty and hidden as shipped: the strip appears only once something is actually hidden, so a
  // page with nothing hidden does not carry a permanent empty affordance.
  assert.match(controls, /data-hidden-bar hidden><\/div>/, 'the hidden-features strip ships with content or shown');

  // The way IN is on the keyboard too, and the instruction every header points at names the key.
  const described = /<g class="lane-head"[^>]*aria-describedby="([^"]+)"/.exec(depthHtml)[1];
  const instruction = new RegExp(`<[^>]*id="${described}"[^>]*>([^<]*)`).exec(depthHtml)[1];
  assert.match(instruction, /\bH\b/, 'nothing tells a keyboard reader how to hide a feature');
  assert.match(instruction, /hidden features can be brought back/i, 'the instruction does not say there is a way back');

  // And the announcement region the module speaks through is the one the ordering already uses.
  assert.match(controls, /data-order-said[^>]*aria-live="polite"/, 'hiding has nowhere to be announced');
});

test('planning: a feature can be reordered by keyboard as well as by drag, and the page says where the order lives', () => {
  // The owner's own request, and he knows what it is. What must not happen is a reader
  // discovering on their phone that the order they set at their desk did not come with them.
  assert.match(
    depthHtml,
    /remembered on this device only/i,
    'the page does not say that the order is per-device',
  );
  assert.match(depthHtml, /<button[^>]*data-order-reset/, 'there is no visible way back to the generated order');

  // Drag alone is not enough: every header is focusable and announces what the arrow keys do.
  const handles = [...depthHtml.matchAll(/<g class="lane-head"[^>]*>/g)].map((m) => m[0]);
  assert.equal(handles.length, workstreams.length, 'expected one draggable header per feature');
  for (const handle of handles) {
    assert.match(handle, /tabindex="0"/, 'a feature header cannot be reached by keyboard');
    assert.match(handle, /aria-label="[^"]*arrow keys[^"]*"/, 'a feature header does not say what the keys do');
  }

  // A move rewrites a transform on an SVG group, which a screen reader has no reason to announce,
  // so there is somewhere on the page for the module to say it.
  assert.match(
    depthHtml,
    /<p class="order-said"[^>]*aria-live="polite"[^>]*>/,
    'a keyboard move has nowhere to be announced',
  );
  for (const handle of handles) {
    assert.match(handle, /data-name="[^"]+"/, 'a header carries no name for the announcement to use');
  }

  // And the behaviour is one static file on this surface alone.
  assert.match(depthHtml, /<script type="module" src="\/order\.js"><\/script>/);
  assert.ok(!mobileHtml.includes('order.js'), 'the phone view loads the ordering script it has no use for');
});

test('tokens.css: a drag that starts on a header is the drag, not the browser own pan', () => {
  // Found in review, and it would have killed the feature on the one device decision 4 says this
  // is read on. `.chart-scroll` scrolls sideways, so without `touch-action: none` on the handle the
  // browser claims a touch that starts there for its pan gesture and the drag arrives as
  // `pointercancel` — nothing happens, on a phone, silently.
  const scroller = DECLARATION_RULES.find((r) => r.selector.split(',').some((x) => x.trim() === '.chart-scroll'));
  assert.match(scroller.body, /overflow-x\s*:\s*auto/, 'this test is about a sideways scroller; there is not one');

  const handle = DECLARATION_RULES.filter((r) => r.selector.split(',').some((x) => x.trim() === '.lane-head'));
  assert.ok(handle.length > 0, 'no .lane-head rule');
  assert.ok(
    handle.some((r) => /touch-action\s*:\s*none/.test(r.body)),
    'the drag handle does not claim the touch, so a touch drag is taken by the scroller instead',
  );

  // Scoped to the handle: the drawing must still pan normally everywhere else.
  const blanket = DECLARATION_RULES.filter((r) => /touch-action\s*:\s*none/.test(r.body)).flatMap((r) =>
    r.selector.split(',').map((x) => x.trim()),
  );
  assert.deepEqual(blanket, ['.lane-head'], `touch-action: none must apply to the handle alone; saw ${blanket}`);
});

test('planning: the key states in words what the colours say, so colour is never the only signal', () => {
  for (const phrase of ['finished', 'in progress', 'on record, not started', 'skipped']) {
    assert.ok(depthHtml.includes(phrase), `the key does not name "${phrase}"`);
  }
});
// --- decision 27: the mobile view is sorted by what needs the owner ------------------------------

test('mobile: workstreams are ordered by what needs the owner, not alphabetically', () => {
  const order = attrValues(mobileHtml, 'data-workstream');

  // Anchor has run out of milestones and needs a decision; Beacon and Tide are moving; Reef is
  // parked on something outside itself; Harbor is still designing; Shoal has not started.
  // Alphabetically that would be Anchor, Beacon, Harbor, Reef, Shoal, Tide; in declaration order
  // it would be Beacon, Tide, Reef, Harbor, Anchor, Shoal. Decision 27 wants neither.
  assert.deepEqual(order, ['Anchor', 'Beacon', 'Tide', 'Reef', 'Harbor', 'Shoal']);

  const alphabetical = [...order].sort();
  assert.notDeepEqual(order, alphabetical, 'the cards came out in alphabetical order');
  assert.notDeepEqual(
    order,
    workstreams.map((w) => w.manifest.codename),
    'the cards came out in manifest declaration order',
  );
});

test('mobile: a not-started workstream sorts last even when it sorts first alphabetically', () => {
  const entries = [
    entry('Alpha', { stage: 'not-started' }),
    entry('Bravo', { stage: 'shipping', milestones: [milestone({ status: 'done' })] }),
    entry('Charlie', { stage: 'shipping', milestones: [milestone({ status: 'parked' })] }),
    entry('Delta', { stage: 'shipping', milestones: [milestone({ status: 'next' })] }),
    entry('Echo', { stage: 'designing' }),
  ];

  const order = attrValues(renderMobile(entries), 'data-workstream');
  assert.deepEqual(
    order,
    ['Bravo', 'Delta', 'Charlie', 'Echo', 'Alpha'],
    'decision 27: the decision waiting on the owner first, then moving, blocked, designing, not started',
  );
});

test('the chart and the phone view agree about whether a feature has a next milestone', () => {
  // #780's second defect on first render, and the point of it is not the label. A feature with
  // four milestones, all done and nothing recorded beyond, correctly gets NO balloon on the chart
  // — and the phone view said "Next: M5". The two surfaces were computed from different readings
  // of one field, which is the drift decision 29 exists to prevent, happening in front of the
  // reader.
  //
  // So they are checked against each other rather than each against a value, and on the FIXTURE,
  // which carries the case that found it.
  const chart = computeChart(ladder, assemble(workstreams));
  const cards = [...mobileHtml.matchAll(/<article\b[^>]*data-workstream="([^"]+)"[^>]*>([\s\S]*?)<\/article>/g)];
  assert.equal(cards.length, workstreams.length, 'expected one card per workstream');

  let pastItsRecords = 0;
  for (const [, codename, body] of cards) {
    const lane = chart.lanes.find((l) => l.codename === codename);
    assert.ok(lane, `no lane drawn for ${codename}`);
    const column = ladder.columns.find((c) => c.codename === codename);

    const namesANextStep = /class="card-next"/.test(body);
    if (column.tipLabel === null) {
      pastItsRecords += 1;
      assert.equal(
        namesANextStep,
        false,
        `${codename}: nothing is recorded for this feature to do next, and the phone view named one anyway`,
      );
      assert.equal(
        lane.balloon,
        null,
        `${codename}: the phone view says nothing is next while the chart draws a balloon saying one is`,
      );
    } else {
      assert.ok(namesANextStep, `${codename}: the phone view dropped a next step that is on record`);
      assert.ok(
        stripTags(/<p class="card-next">([\s\S]*?)<\/p>/.exec(body)[1]).includes(column.tipLabel),
        `${codename}: the phone view names a next step the ladder did not give it`,
      );
    }
  }
  assert.ok(pastItsRecords > 0, 'the fixture no longer carries a feature that has run past its records');
});

test('mobile: the gate is the last line of every card', () => {
  const cards = [...mobileHtml.matchAll(/<article\b[^>]*data-workstream="([^"]+)"[^>]*>([\s\S]*?)<\/article>/g)];
  assert.equal(cards.length, workstreams.length, 'expected one card per workstream');

  for (const [, codename, body] of cards) {
    const manifest = workstreams.find((w) => w.manifest.codename === codename).manifest;
    const lines = [...body.matchAll(/<p\b[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/p>/g)];
    const last = lines[lines.length - 1];
    assert.ok(last, `card ${codename} has no lines at all`);
    assert.match(last[1], /card-gate/, `card ${codename}: the last line must be the gate, decision 27`);
    assert.ok(
      stripTags(last[2]).includes(manifest.gate),
      `card ${codename}: the gate line must carry the manifest's gate`,
    );
  }
});

// --- decision 24: the two surfaces agree about what is complete ---------------------------------

// One segment per milestone, in the order the card drew them, and whether each is filled.
function trackSegments(html) {
  return [...html.matchAll(/<span class="track-seg([^"]*)"><\/span>/g)].map((m) =>
    m[1].includes('is-filled'),
  );
}

test('mobile: the track fills exactly the milestones that are finished, never the first N segments', () => {
  // The bug this pins: the phone counted the done milestones and filled the FIRST that many
  // segments, so with M1 `next` and M2 `done` it filled M1 — the one that is not done — and left
  // M2 — the one that is — empty. Both surfaces read the same `covered` flags from
  // `computeLadder`, so they cannot disagree.
  //
  // M2.1 moved the numbers under it (#780): the bar no longer stops at the first gap, so this
  // column reads 1 of 3 rather than 0 of 3. What the test pins is unchanged, and the shape still
  // separates the two implementations — a fill-the-first-N would light M1, not M2.
  const gapped = entry('Gapped', {
    stage: 'shipping',
    milestones: [
      milestone({ id: 'M1', label: 'M1', depth: 1, status: 'next' }),
      milestone({ id: 'M2', label: 'M2', depth: 2, status: 'done' }),
      milestone({ id: 'M3', label: 'M3', depth: 3, status: 'parked' }),
    ],
  });

  const html = renderMobile([gapped]);
  const segments = trackSegments(html);
  assert.equal(segments.length, 3, 'one segment per milestone');
  assert.deepEqual(
    segments,
    [false, true, false],
    'only the finished milestone may be filled, and it is the second one',
  );
  assert.ok(
    html.includes('<span class="num">1</span> of <span class="num">3</span> milestones complete'),
    'the card must count what is finished, not how far the bar reaches',
  );
  assert.ok(html.includes('aria-label="1 of 3 milestones complete"'), 'the track label must agree too');

  // And the chart's own answer, so the two are read side by side rather than one at a time.
  const [column] = computeLadder([gapped]).columns;
  assert.equal(column.barTo, 'depth-2', 'the bar reaches the real edge of finished work');
  assert.equal(column.headAt, 'depth-3');
  assert.equal(column.completedCount, 1);
});

test('mobile: a completed run fills exactly its own segments, in the order the manifest lists', () => {
  // Listed out of depth order on purpose. Nothing requires a manifest to list its milestones in
  // depth order, and a page that fills "the first completedCount segments" instead of reading
  // `covered` would fill M3 here — the one that is not complete — and leave M2 empty. That is the
  // same class of bug as counting every done milestone, one step further along.
  const run = entry('Run', {
    stage: 'shipping',
    milestones: [
      milestone({ id: 'M3', label: 'M3', depth: 3, status: 'next' }),
      milestone({ id: 'M1', label: 'M1', depth: 1, status: 'done' }),
      milestone({ id: 'M2', label: 'M2', depth: 2, status: 'done' }),
    ],
  });

  const html = renderMobile([run]);
  assert.deepEqual(trackSegments(html), [false, true, true]);
  assert.ok(
    html.includes('<span class="num">2</span> of <span class="num">3</span> milestones complete'),
  );
});

// --- status is never colour alone ----------------------------------------------------------------

test('chips: every status chip carries a text label, never colour alone', () => {
  // Per page, not a total across all of them. The floor used to be `seen >= 10` over every page at
  // once, which stayed true with the triage chip removed from the phone view entirely — the other
  // pages carried the count on their own. A page that stopped rendering chips is exactly what this
  // is for.
  const expected = {
    // #780 took the status chips OUT of the drawing — "the cells should carry fill and nothing
    // else" — so what is left on this surface is one stage chip per feature's header, drawn inside
    // the SVG because a drawing cannot hold a <span>.
    'depth.njk': 'a stage chip per feature header',
    'mobile.njk': 'a triage chip per card',
    'workstream.njk': 'a stage chip, plus a status chip per milestone row',
    'milestone.njk': 'this milestone\'s own status',
    'document.njk': null, // a record page renders a record; it has no vocabulary to chip
  };
  assert.deepEqual(
    Object.keys(expected).sort(),
    Object.keys(ALL_PAGES).sort(),
    'a layout was added or removed and this table was not updated',
  );

  for (const [name, html] of Object.entries(ALL_PAGES)) {
    // `<span>` on a document page, `<g>` inside the drawing: one chip, two elements, one label
    // table (`chipLabel` in base.njk). Both are matched, because "colour alone is not a status"
    // has to hold wherever a chip is rendered.
    const chips = [
      ...html.matchAll(/<(span|g)\b[^>]*class="[^"]*\bchip\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/g),
    ].map((m) => [m[0], m[2]]);

    if (expected[name] === null) {
      assert.equal(chips.length, 0, `${name}: renders chips, and this table says it has none to render`);
      continue;
    }

    assert.ok(chips.length > 0, `${name}: no chips at all, but it should carry ${expected[name]}`);
    for (const [, inner] of chips) {
      assert.notEqual(
        stripTags(inner),
        '',
        `${name}: a chip rendered with no text — colour would be its only signal`,
      );
    }
  }

  // And the counts follow the data, so a page cannot pass by rendering one chip and stopping.
  const cards = [...mobileHtml.matchAll(/<article class="card"/g)];
  const triageChips = [...mobileHtml.matchAll(/<span\b[^>]*data-triage="/g)];
  assert.equal(triageChips.length, cards.length, 'every card on the phone view carries its own chip');
  assert.equal(cards.length, workstreams.length, 'a card per workstream');

  const stageChips = [...depthHtml.matchAll(/<g\b[^>]*data-stage="/g)];
  assert.equal(stageChips.length, workstreams.length, 'every feature on the drawing carries its stage');
});

test('chips: every triage state renders its own human label, decision 27\'s headline included', () => {
  // The status and stage halves of this vocabulary were already covered; the triage half — the
  // label on the single card decision 27 puts FIRST — was not, and "Waiting on you" could be
  // changed to anything without a test noticing. The states come from `TRIAGE_ORDER` so a new one
  // cannot be added without landing here; the labels are written out, because a label read back
  // out of the template would agree with any wording.
  const triageLabels = {
    'awaiting-decision': 'Waiting on you',
    moving: 'Moving',
    blocked: 'Blocked',
    designing: 'Designing',
    'not-started': 'Not started',
  };
  assert.deepEqual(
    Object.keys(triageLabels).sort(),
    [...TRIAGE_ORDER].sort(),
    'this table and src/triage.mjs disagree about which states exist',
  );

  // One workstream per state, each built so `classifyTriage` puts it in exactly that state.
  const byState = {
    'not-started': entry('Alfa', { stage: 'not-started' }),
    designing: entry('Bravo', { stage: 'designing' }),
    'awaiting-decision': entry('Charlie', { stage: 'planned' }),
    moving: entry('Delta', {
      stage: 'shipping',
      milestones: [milestone({ id: 'M1', label: 'M1', depth: 1, status: 'next' })],
    }),
    blocked: entry('Echo', {
      stage: 'shipping',
      milestones: [milestone({ id: 'M1', label: 'M1', depth: 1, status: 'parked' })],
    }),
  };

  const html = renderMobile(Object.values(byState));

  for (const state of TRIAGE_ORDER) {
    const match = new RegExp(`<span\\b[^>]*data-triage="${state}"[^>]*>([\\s\\S]*?)</span>`).exec(html);
    assert.ok(match, `no chip rendered for triage state "${state}"`);
    assert.equal(
      stripTags(match[1]),
      triageLabels[state],
      `the "${state}" chip must read its human label`,
    );
  }

  // And the state each card was actually classified into is the one it was built to be, so this
  // test cannot pass by rendering five chips that all say the same thing about the wrong cards.
  for (const [state, stream] of Object.entries(byState)) {
    const card = new RegExp(
      `<article class="card" data-workstream="${stream.manifest.codename}" data-triage="([^"]*)"`,
    ).exec(html);
    assert.ok(card, `no card for ${stream.manifest.codename}`);
    assert.equal(card[1], state, `${stream.manifest.codename} was classified as ${card[1]}`);
  }
});

test('chips: every value in the closed vocabularies renders its own human label', () => {
  const statusLabels = {
    done: 'Done',
    next: 'Next',
    blocked: 'Blocked',
    parked: 'Parked',
    unplanned: 'Unplanned',
  };
  const stageLabels = {
    'not-started': 'Not started',
    designing: 'Designing',
    planned: 'Planned',
    shipping: 'Shipping',
  };

  const everyStatus = entry('Vector', {
    stage: 'shipping',
    milestones: MILESTONE_STATUSES.map((status, i) =>
      milestone({ id: `M${i + 1}`, label: `M${i + 1}`, depth: i + 1, status, plan: `m${i + 1}-plan.md` }),
    ),
  });
  const html = renderWorkstream(everyStatus);

  for (const status of MILESTONE_STATUSES) {
    const re = new RegExp(`<span\\b[^>]*data-status="${status}"[^>]*>([\\s\\S]*?)</span>`);
    const match = re.exec(html);
    assert.ok(match, `no chip rendered for status "${status}"`);
    assert.equal(stripTags(match[1]), statusLabels[status], `the "${status}" chip must read its human label`);
  }

  // The stage chips live inside the drawing now, so they are drawn as a <g> — one macro, one
  // label table, two elements (see `chipLabel` in base.njk). The words must be the same words.
  const stagesHtml = renderDepth(WORKSTREAM_STAGES.map((stage, i) => entry(`Stage${i}`, { stage })));
  for (const stage of WORKSTREAM_STAGES) {
    const re = new RegExp(`<g\\b[^>]*data-stage="${stage}"[^>]*>([\\s\\S]*?)</g>`);
    const match = re.exec(stagesHtml);
    assert.ok(match, `no chip rendered for stage "${stage}"`);
    assert.equal(stripTags(match[1]), stageLabels[stage], `the "${stage}" chip must read its human label`);
  }

  // And the two spellings agree, because they read the same table rather than two copies of it.
  const workstreamStage = /<span\b[^>]*data-stage="shipping"[^>]*>([\s\S]*?)<\/span>/.exec(html);
  const drawnStage = /<g\b[^>]*data-stage="shipping"[^>]*>([\s\S]*?)<\/g>/.exec(stagesHtml);
  assert.ok(workstreamStage && drawnStage, 'one of the two chip spellings did not render at all');
  assert.equal(stripTags(workstreamStage[1]), stripTags(drawnStage[1]));
});

// --- the document pages ---------------------------------------------------------------------------

test('workstream: a design entry is a named reference, never a link and never rendered', () => {
  // Decision 21: CI cannot reach the design project, so its entries are named, not fetched.
  for (const design of beacon.manifest.design) {
    assert.ok(workstreamHtml.includes(design.name), `the design entry "${design.name}" is not named on the page`);
  }
  const linked = [...workstreamHtml.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)].map((m) => stripTags(m[1]));
  for (const design of beacon.manifest.design) {
    assert.ok(
      !linked.includes(design.name),
      `the design entry "${design.name}" was rendered as a link to something CI cannot reach`,
    );
  }
});

test('workstream: every milestone links to its own page, and open issues are listed by number', () => {
  for (const m of beacon.manifest.milestones) {
    assert.ok(
      workstreamHtml.includes(`href="/workstream/${beacon.slug}/${m.id.toLowerCase()}/"`),
      `milestone ${m.id} has no link to its own page`,
    );
    assert.ok(workstreamHtml.includes(m.title), `milestone ${m.id} does not show its title`);
  }
  for (const issue of issuesLabelled(beacon.manifest.label)) {
    assert.ok(workstreamHtml.includes(issue.html_url), `issue ${issue.number} is not linked`);
    assert.ok(workstreamHtml.includes(issue.title), `issue ${issue.number} does not show its title`);
  }
});

test('milestone: the heading spells out "Milestone" and never mangles a label that is not M<n>', () => {
  // Decision 19: headings spell "Milestone 6.3" and the bare id is reserved for chips and cells.
  // Turning "M6.3" into "6.3" must therefore strip a leading M only when a number follows it — an
  // unanchored strip eats the M in "PM3", and a merely anchored one eats the M in "MVP".
  function headingFor(label) {
    const html = env.render('milestone.njk', {
      ...site,
      title: label,
      workstream: assemble([beacon])[0],
      milestone: { ...beacon.manifest.milestones[0], label },
      content: '',
      anchors: [],
    });
    const match = /<h1>([\s\S]*?)<\/h1>/.exec(html);
    assert.ok(match, `no h1 rendered for ${label}`);
    return stripTags(match[1]);
  }

  assert.ok(headingFor('M1').startsWith('Milestone 1 ·'), headingFor('M1'));
  assert.ok(headingFor('M6.3').startsWith('Milestone 6.3 ·'), headingFor('M6.3'));

  // Neither of these follows the M<n> convention, so neither may be cut into.
  assert.ok(headingFor('MVP').startsWith('Milestone MVP ·'), headingFor('MVP'));
  assert.ok(headingFor('PM3').startsWith('Milestone PM3 ·'), headingFor('PM3'));
});

test('document: rendered Markdown is emitted as HTML, not escaped into visible tags', () => {
  for (const [name, html] of [
    ['document.njk', documentHtml],
    ['milestone.njk', milestoneHtml],
  ]) {
    assert.ok(html.includes('<h1'), `${name}: the rendered document lost its headings`);
    assert.ok(!html.includes('&lt;p&gt;'), `${name}: the rendered HTML was escaped instead of emitted`);
  }
  for (const anchor of headingAnchors(decisionsText)) {
    assert.ok(documentHtml.includes(`href="#${anchor.id}"`), `the contents list is missing #${anchor.id}`);
  }
});

test('document: the link to the file resolves on any default branch', () => {
  // Decision 2 rests on this one link: "where this page and that file disagree, the file is
  // right" is worth nothing if the link 404s. A hardcoded branch name forces a branch model on
  // every consumer, which decision 43 says Atlas does not do, and nothing in `atlas.config.json`
  // lets a consumer name theirs. GitHub resolves `HEAD` to whatever the repository's own default
  // branch is, so one spelling is correct for a `main` consumer and a `master` one alike.
  const toTheFile = attrValues(documentHtml, 'href').filter((href) =>
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\//.test(href),
  );
  assert.ok(toTheFile.length > 0, 'the record page does not link to the file it rendered');
  for (const href of toTheFile) {
    assert.match(
      href,
      /^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/HEAD\//,
      `a record page must reach its file on any default branch, so the ref is HEAD: ${href}`,
    );
  }
});

test('base: every page declares a language, a viewport and the stylesheet', () => {
  for (const [name, html] of Object.entries(ALL_PAGES)) {
    assert.match(html, /^<!doctype html>/i, `${name}: no doctype`);
    assert.match(html, /<html[^>]*\blang="en"/, `${name}: no lang on <html>`);
    assert.match(html, /<meta[^>]*name="viewport"[^>]*width=device-width/, `${name}: no viewport`);
    assert.match(html, /<link[^>]*rel="stylesheet"[^>]*href="\/tokens\.css"/, `${name}: no stylesheet link`);
    assert.match(html, /<title>[^<]+<\/title>/, `${name}: no title`);
  }
});

test('base: the digits the layouts line up in columns are marked for tabular numerals', () => {
  // Not "somewhere on the page there is a .num" — that passes however many digits are left
  // unmarked. Each place where digits actually stack into a column is checked on its own.
  // The ladder gutter, whose milestone identifiers stack straight down the left of the drawing.
  const ladderCaptions = [...depthHtml.matchAll(/<text class="([^"]*)"[^>]*>(M\d+|[A-Z][a-z ]+)<\/text>/g)];
  const numbered = ladderCaptions.filter(([, , caption]) => /^M\d+$/.test(caption));
  assert.equal(
    numbered.length,
    ladder.rows.filter((r) => r.kind === 'milestone').length,
    'expected one numbered ladder caption per milestone row',
  );
  for (const [, classes, caption] of numbered) {
    assert.match(
      classes,
      /\bnum\b/,
      `ladder caption ${caption} stacks into a column, so it must be marked tabular`,
    );
  }

  // And the dates, which stack down each feature's own lane. Both lines of a closed milestone's
  // pair are digits; only the day itself is a column, so only it is required to be tabular.
  const strongDates = [...depthHtml.matchAll(/<text class="([^"]*)"[^>]*>\d+ [A-Z][a-z]{2} \d{4}/g)];
  assert.ok(strongDates.length > 0, 'no dates reached the drawing at all');
  for (const [, classes] of strongDates) {
    assert.match(classes, /\bnum\b/, 'a date stacks down a lane, so it must be marked tabular');
  }

  // Exactly the cards that have milestones, not "at least three": a floor stays true while a
  // card quietly loses its marking.
  const withMilestones = workstreams.filter((w) => w.manifest.milestones.length > 0).length;
  const counts = [...mobileHtml.matchAll(
    /<p class="track-count"><span class="num">\d+<\/span> of <span class="num">\d+<\/span>/g,
  )];
  assert.equal(
    counts.length,
    withMilestones,
    `every card with milestones must show a tabular depth count, saw ${counts.length} of ${withMilestones}`,
  );

  // Every row of the milestone table, column by column, rather than a count of marked cells
  // across the whole page: the milestone-id column and both number columns are checked on the
  // row they belong to.
  const rows = [...workstreamHtml.matchAll(/<tr>\s*<th scope="row"([^>]*)>([\s\S]*?)<\/tr>/g)];
  assert.equal(rows.length, beacon.manifest.milestones.length, 'expected one table row per milestone');
  rows.forEach(([whole, thAttributes], i) => {
    const id = beacon.manifest.milestones[i].label;
    assert.match(
      thAttributes,
      /class="[^"]*\bnum\b[^"]*"/,
      `${id}: the milestone-id column stacks down the table, so it must be tabular`,
    );
    const numberCells = [...whole.matchAll(/<td class="[^"]*\bnum\b[^"]*">/g)];
    assert.equal(
      numberCells.length,
      2,
      `${id}: both the issue and the pull-request column must be tabular, saw ${numberCells.length}`,
    );
  });
});

// --- decision 40: the generator holds no project content ------------------------------------------

function themeFiles() {
  return [
    ...readdirSync(THEME_DIR)
      .filter((name) => statSync(path.join(THEME_DIR, name)).isFile())
      .map((name) => ({ name, text: readFileSync(path.join(THEME_DIR, name), 'utf8') })),
    ...readdirSync(LAYOUT_DIR).map((name) => ({
      name: `_includes/${name}`,
      text: readFileSync(path.join(LAYOUT_DIR, name), 'utf8'),
    })),
  ];
}

// Names from a real project. None may appear anywhere in the generator, and none may reach a page
// built from a project that never mentioned them.
const REAL_PROJECT_NAMES = ['vennusign', 'keystone', 'menus', 'murphy', 'platform operations'];

// The owner's own handle is different in kind. `action.yml` and the README legitimately carry
// `jmiedreich-ux/atlas`, because that IS the action's published coordinate (decision 46) — but a
// LAYOUT naming a person is project content by another route, and so is a rendered page.
const PERSONAL_NAMES = ['jmiedreich'];

// Every file the generator ships, not just the theme. The guard used to read as though it covered
// the repository while scanning `theme/` alone, so `src/`, `action.yml` and the workflow were
// never looked at.
function generatorFiles() {
  const files = [];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === 'node_modules' || name === '.git') continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full, `${prefix}${name}/`);
      else files.push({ name: `${prefix}${name}`, text: readFileSync(full, 'utf8') });
    }
  };
  walk(path.join(REPO_ROOT, 'src'), 'src/');
  walk(THEME_DIR, 'theme/');
  walk(path.join(REPO_ROOT, '.github'), '.github/');
  // The fixture too. It is the project the generator ships as its own demo, so a real project's
  // name reaching it is the same leak by a shorter route — and it is the corpus the tag publishes.
  walk(path.join(REPO_ROOT, 'fixture'), 'fixture/');
  for (const name of ['action.yml', '.eleventy.js', 'package.json', 'README.md']) {
    files.push({ name, text: readFileSync(path.join(REPO_ROOT, name), 'utf8') });
  }
  return files;
}

test('decision 40: nothing the generator ships hard-codes a project name', () => {
  const scanned = generatorFiles();
  // A guard that scanned an empty list would pass silently, which is the failure mode this whole
  // section exists to catch elsewhere.
  assert.ok(scanned.length > 15, `expected to scan the generator, saw ${scanned.length} files`);
  assert.ok(scanned.some((f) => f.name === 'action.yml'));
  assert.ok(scanned.some((f) => f.name.startsWith('src/')));
  assert.ok(scanned.some((f) => f.name.startsWith('.github/')));
  assert.ok(scanned.some((f) => f.name.startsWith('fixture/')));

  for (const file of scanned) {
    const lower = file.text.toLowerCase();
    for (const name of REAL_PROJECT_NAMES) {
      assert.ok(!lower.includes(name), `${file.name} names the project "${name}"`);
    }
  }
});

test('decision 40: no layout names a person, whatever the action.yml may have to say', () => {
  for (const file of themeFiles()) {
    const lower = file.text.toLowerCase();
    for (const name of [...REAL_PROJECT_NAMES, ...PERSONAL_NAMES]) {
      assert.ok(!lower.includes(name), `theme/${file.name} names "${name}"`);
    }
  }
});

test("decision 40: no theme file hard-codes the fixture's own content either", () => {
  // The fixture's vocabulary is the test of the rule: if the generator can render the fixture
  // without any of these words appearing in a template, it holds no project content at all.
  const fixtureWords = ['lighthouse', 'beacon', 'tide', 'reef', 'harbor', 'anchor', 'shoal'];
  for (const file of themeFiles()) {
    const lower = file.text.toLowerCase();
    for (const word of fixtureWords) {
      // Not `\b`, which counts a hyphen as a word boundary and so reads the SVG attribute
      // `text-anchor` as the fixture's workstream "Anchor". A hyphenated identifier is one token
      // in both SVG and CSS, and neither is project content a layout could have hard-coded.
      assert.ok(
        !new RegExp(`(?<![-\\w])${word}(?![-\\w])`).test(lower),
        `theme/${file.name} contains the fixture's own word "${word}" — the layouts must take that from data`,
      );
    }
  }
});

test('decision 40: no generated page carries a project name its data never supplied', () => {
  for (const [name, html] of Object.entries(ALL_PAGES)) {
    const lower = html.toLowerCase();
    for (const projectName of [...REAL_PROJECT_NAMES, ...PERSONAL_NAMES]) {
      assert.ok(!lower.includes(projectName), `${name} rendered the name "${projectName}"`);
    }
  }
});
