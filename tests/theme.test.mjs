import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Nunjucks is not a dependency of this package and is deliberately not added as one: it arrives
// with @11ty/eleventy, which bundles it as the engine decision 9 names, and npm hoists it to
// the top of node_modules. If this import ever stops resolving, the cause is a change to
// Eleventy's own engine or dependency layout, not a missing entry in package.json.
import nunjucks from 'nunjucks';

import { loadConfig, resolveWorkstreams } from '../src/config.mjs';
import { computeLadder } from '../src/depth.mjs';
import { renderMarkdown, headingAnchors } from '../src/markdown.mjs';
import { orderByTriage } from '../src/triage.mjs';
import { MILESTONE_STATUSES, WORKSTREAM_STAGES } from '../src/schema.mjs';

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

function entry(codename, overrides = {}) {
  const slug = codename.toLowerCase();
  return {
    slug,
    dir: `/fake/${slug}`,
    manifestPath: `/fake/${slug}/workstream.json`,
    manifest: {
      codename,
      what: `${codename}, a workstream invented for this test`,
      stage: 'shipping',
      position: 'Invented for this test',
      gate: `Nothing gates ${codename} but this test`,
      label: `workstream:${slug}`,
      design: [{ name: `${slug}/Overview v1`, where: 'design-project' }],
      milestones: [],
      ...overrides,
    },
  };
}

function renderDepth(entries) {
  return env.render('depth.njk', {
    ...site,
    title: 'Project depth',
    workstreams: entries,
    ladder: computeLadder(entries),
  });
}

// Task 7 moved decision 27's mapping out of `mobile.njk` and into `src/triage.mjs`, so the page
// is now handed its cards already classified and already in order. The assertions below are
// unchanged: they still read the rendered HTML, so they pin the same behaviour they always did —
// only the place that decides it moved.
function renderMobile(entries) {
  const ladder = computeLadder(entries);
  return env.render('mobile.njk', {
    ...site,
    title: 'Triage',
    triaged: orderByTriage(entries.map((stream, i) => ({ ...stream, column: ladder.columns[i] }))),
  });
}

const depthHtml = renderDepth(workstreams);
const mobileHtml = renderMobile(workstreams);

const beacon = workstreams.find((w) => w.slug === 'beacon');
const beaconPlan = readFileSync(path.join(beacon.dir, 'm1-plan.md'), 'utf8');

const workstreamHtml = env.render('workstream.njk', {
  ...site,
  title: beacon.manifest.codename,
  workstream: beacon,
  issues: issuesLabelled(beacon.manifest.label),
});

const milestoneHtml = env.render('milestone.njk', {
  ...site,
  title: 'Milestone 1',
  workstream: beacon,
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

test('tokens.css: the chart owns both scrolls, so its sticky headers have a scrollport to stick to', () => {
  // Per CSS Overflow 3, a non-visible value on one axis computes the other to auto, so
  // `overflow-x: auto` already makes .chart-scroll a scroll container on BOTH axes. With no height
  // bound it never scrolls vertically, and `position: sticky; top: 0` inside it resolves against a
  // scrollport that cannot move — the headers would silently never stick.
  const scroller = DECLARATION_RULES.find((r) => r.selector.split(',').some((x) => x.trim() === '.chart-scroll'));
  assert.ok(scroller, 'no .chart-scroll rule');

  const declarations = new Map(declarationsIn(scroller.body));
  assert.ok(
    declarations.has('max-height'),
    '.chart-scroll must bound its own height, or nothing inside it can stick to the top of it',
  );

  // Anything claiming the top of that scrollport must actually be sticky. Resolved across every
  // rule for the selector, as the cascade would, since the stacking order is stated separately
  // from the appearance.
  const claimsTop = new Set(
    DECLARATION_RULES.filter((r) => declarationsIn(r.body).some(([p, v]) => p === 'top' && v === '0'))
      .flatMap((r) => r.selector.split(',').map((x) => x.trim())),
  );
  assert.ok(claimsTop.size > 0, 'nothing claims the top of the chart');
  for (const selector of claimsTop) {
    const sticky = DECLARATION_RULES.filter((r) =>
      r.selector.split(',').some((x) => x.trim() === selector),
    ).some((r) => /position\s*:\s*sticky/.test(r.body));
    assert.ok(sticky, `${selector} sets top: 0 without position: sticky, which does nothing`);
  }
});

test('tokens.css: the sticky cells stack deliberately, and each paints on an opaque ground', () => {
  // Sticky cells overlap each other as the chart scrolls. At z-index: auto they paint in DOM
  // order, so the column headers slide over the sticky corner. The order is fixed here: the
  // corner above the column headers, the column headers above the ladder column.
  // Last declaration wins, as the cascade would resolve it, so the order holds however the rules
  // are split up.
  function zIndexOf(selector) {
    const declared = DECLARATION_RULES.filter((r) =>
      r.selector.split(',').some((x) => x.trim() === selector),
    ).flatMap((r) => declarationsIn(r.body).filter(([property]) => property === 'z-index'));
    assert.ok(declared.length > 0, `${selector} is sticky but sets no z-index, so it paints in DOM order`);
    return Number(declared[declared.length - 1][1]);
  }

  const corner = zIndexOf('.ladder-head');
  const columns = zIndexOf('.column-head');
  const ladder = zIndexOf('.ladder-cell');
  assert.ok(corner > columns, `the sticky corner (${corner}) must paint above the column headers (${columns})`);
  assert.ok(columns > ladder, `the column headers (${columns}) must paint above the ladder column (${ladder})`);

  // A sticky cell with a transparent ground shows the content it is meant to cover sliding under it.
  for (const selector of ['.ladder-head', '.ladder-cell', '.column-head']) {
    const opaque = DECLARATION_RULES.filter((r) =>
      r.selector.split(',').some((x) => x.trim() === selector),
    ).some((r) => /background\s*:\s*var\(\s*--[\w-]+\s*\)/.test(r.body));
    assert.ok(opaque, `${selector} is sticky but has no opaque background`);
  }
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

// --- decision 22/23/24: the desktop depth chart -------------------------------------------------

function depthCells(html, codename) {
  const re = /<td\b[^>]*data-row="([^"]+)"[^>]*data-column="([^"]+)"[^>]*data-state="([^"]+)"[^>]*>/g;
  return [...html.matchAll(re)]
    .filter((m) => m[2] === codename)
    .map((m) => ({ row: m[1], state: m[3] }));
}

test('depth: one column per workstream, one row per ladder row, in the order computeLadder returned', () => {
  const headings = [...depthHtml.matchAll(/<th\b[^>]*data-column="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    headings,
    ladder.columns.map((c) => c.codename),
    'the chart must render the columns computeLadder returned, in that order',
  );

  for (const column of ladder.columns) {
    assert.deepEqual(
      depthCells(depthHtml, column.codename).map((c) => c.row),
      ladder.rows.map((r) => r.id),
      `column ${column.codename} must have a cell for every ladder row, in ladder order`,
    );
  }

  // The layout pairs ladder.columns[i] with workstreams[i]. If that pairing ever slipped, every
  // heading would link at the wrong workstream while still looking right.
  ladder.columns.forEach((column, i) => {
    const heading = new RegExp(
      `<th\\b[^>]*data-column="${column.codename}"[^>]*>([\\s\\S]*?)</th>`,
    ).exec(depthHtml);
    assert.ok(heading, `no heading rendered for ${column.codename}`);
    assert.match(
      heading[1],
      new RegExp(`href="/workstream/${workstreams[i].slug}/"`),
      `column ${column.codename} links at the wrong workstream`,
    );
  });
});

test('depth: the completed bar covers every row through barTo and stops there', () => {
  for (const column of ladder.columns) {
    const cells = depthCells(depthHtml, column.codename);
    const covered = cells.filter((c) => c.state === 'covered').map((c) => c.row);

    const barIndex = column.barTo === null ? -1 : ladder.rows.findIndex((r) => r.id === column.barTo);
    const expected = ladder.rows.slice(0, barIndex + 1).map((r) => r.id);

    assert.deepEqual(covered, expected, `column ${column.codename}: the bar must end exactly at ${column.barTo}`);
  }
});

test('depth: the arrowhead marks headAt, one row past the last covered row and never on it', () => {
  for (const column of ladder.columns) {
    const cells = depthCells(depthHtml, column.codename);

    const heads = cells.filter((c) => c.state === 'head');
    assert.equal(heads.length, 1, `column ${column.codename} must have exactly one arrowhead`);
    assert.equal(heads[0].row, column.headAt, `column ${column.codename}: the head must sit on headAt`);

    const headIndex = cells.findIndex((c) => c.state === 'head');
    let lastCovered = -1;
    cells.forEach((c, i) => {
      if (c.state === 'covered') lastCovered = i;
    });
    assert.equal(
      headIndex,
      lastCovered + 1,
      `column ${column.codename}: the head must sit one row past the bar — the off-by-one this chart exists to get right`,
    );
  }
});

test('depth: every column carries its note at its tip', () => {
  for (const column of ladder.columns) {
    const cellRe = new RegExp(
      `<td\\b[^>]*data-row="${column.headAt}"[^>]*data-column="${column.codename}"[^>]*>([\\s\\S]*?)</td>`,
    );
    const match = cellRe.exec(depthHtml);
    assert.ok(match, `no head cell rendered for ${column.codename}`);

    const text = stripTags(match[1]);
    assert.ok(
      text.includes(column.note),
      `column ${column.codename}: decision 25 wants the reason it stopped at its tip; the cell reads "${text}"`,
    );
    assert.ok(
      text.includes(column.tipLabel),
      `column ${column.codename}: the tip must name what is next (${column.tipLabel})`,
    );
  }
});

test('depth: the chart sits inside a horizontally scrolling container', () => {
  const scrollIndex = depthHtml.indexOf('class="chart-scroll"');
  const tableIndex = depthHtml.indexOf('<table');
  assert.ok(scrollIndex !== -1, 'the chart is not wrapped in a .chart-scroll container');
  assert.ok(scrollIndex < tableIndex, 'the .chart-scroll wrapper must come before the table it wraps');
});

// --- decision 27: the mobile view is sorted by what needs the owner ------------------------------

test('mobile: workstreams are ordered by what needs the owner, not alphabetically', () => {
  const order = attrValues(mobileHtml, 'data-workstream');

  // Anchor has run out of milestones and needs a decision; Beacon and Tide are moving; Harbor is
  // still designing. Alphabetically that would be Anchor, Beacon, Harbor, Tide; in declaration
  // order it would be Beacon, Tide, Harbor, Anchor. Decision 27 wants neither.
  assert.deepEqual(order, ['Anchor', 'Beacon', 'Tide', 'Harbor']);

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

// --- status is never colour alone ----------------------------------------------------------------

test('chips: every status chip carries a text label, never colour alone', () => {
  let seen = 0;
  for (const [name, html] of Object.entries(ALL_PAGES)) {
    const chips = [...html.matchAll(/<span\b[^>]*class="[^"]*\bchip\b[^"]*"[^>]*>([\s\S]*?)<\/span>/g)];
    for (const [, inner] of chips) {
      const text = stripTags(inner);
      assert.notEqual(text, '', `${name}: a chip rendered with no text — colour would be its only signal`);
      seen += 1;
    }
  }
  assert.ok(seen >= 10, `expected chips across the pages, saw ${seen}`);
});

test('chips: every value in the closed vocabularies renders its own human label', () => {
  const statusLabels = {
    done: 'Done',
    next: 'Next',
    gated: 'Gated',
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
  const html = env.render('workstream.njk', { ...site, title: 'Vector', workstream: everyStatus, issues: [] });

  for (const status of MILESTONE_STATUSES) {
    const re = new RegExp(`<span\\b[^>]*data-status="${status}"[^>]*>([\\s\\S]*?)</span>`);
    const match = re.exec(html);
    assert.ok(match, `no chip rendered for status "${status}"`);
    assert.equal(stripTags(match[1]), statusLabels[status], `the "${status}" chip must read its human label`);
  }

  const stagesHtml = renderDepth(WORKSTREAM_STAGES.map((stage, i) => entry(`Stage${i}`, { stage })));
  for (const stage of WORKSTREAM_STAGES) {
    const re = new RegExp(`<span\\b[^>]*data-stage="${stage}"[^>]*>([\\s\\S]*?)</span>`);
    const match = re.exec(stagesHtml);
    assert.ok(match, `no chip rendered for stage "${stage}"`);
    assert.equal(stripTags(match[1]), stageLabels[stage], `the "${stage}" chip must read its human label`);
  }
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
      workstream: beacon,
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
  const ladderCells = [...depthHtml.matchAll(/<th scope="row" class="ladder-cell">([\s\S]*?)<\/th>/g)].map(
    (m) => m[1],
  );
  assert.equal(ladderCells.length, ladder.rows.length, 'expected one ladder cell per row');
  ladder.rows.forEach((row, i) => {
    if (row.kind !== 'milestone') return;
    assert.match(
      ladderCells[i],
      /<span class="[^"]*\bnum\b[^"]*">\d+<\/span>/,
      `ladder row ${row.id}: its depth number stacks into a column, so it must be tabular`,
    );
  });

  assert.ok(
    !/class="cell-label"/.test(depthHtml),
    'a milestone id in a chart cell was rendered without .num, so ids will not line up down a column',
  );

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

// Names from a real project. None may appear in the generator, and none may reach a page built
// from a project that never mentioned them.
const REAL_PROJECT_NAMES = ['vennusign', 'keystone', 'menus', 'murphy', 'platform operations'];

test('decision 40: no theme file hard-codes a project name', () => {
  for (const file of themeFiles()) {
    const lower = file.text.toLowerCase();
    for (const name of REAL_PROJECT_NAMES) {
      assert.ok(!lower.includes(name), `theme/${file.name} names the project "${name}"`);
    }
  }
});

test("decision 40: no theme file hard-codes the fixture's own content either", () => {
  // The fixture's vocabulary is the test of the rule: if the generator can render the fixture
  // without any of these words appearing in a template, it holds no project content at all.
  const fixtureWords = ['lighthouse', 'beacon', 'tide', 'harbor', 'anchor'];
  for (const file of themeFiles()) {
    const lower = file.text.toLowerCase();
    for (const word of fixtureWords) {
      assert.ok(
        !new RegExp(`\\b${word}\\b`).test(lower),
        `theme/${file.name} contains the fixture's own word "${word}" — the layouts must take that from data`,
      );
    }
  }
});

test('decision 40: no generated page carries a project name its data never supplied', () => {
  for (const [name, html] of Object.entries(ALL_PAGES)) {
    const lower = html.toLowerCase();
    for (const projectName of REAL_PROJECT_NAMES) {
      assert.ok(!lower.includes(projectName), `${name} rendered the name "${projectName}"`);
    }
  }
});
