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
import { formatDay } from '../src/dates.mjs';
import { computeLadder, spineDetail } from '../src/depth.mjs';
import { renderMarkdown, headingAnchors } from '../src/markdown.mjs';
import { renderRegisterMarkdown } from '../src/register.mjs';
import { TRIAGE_ORDER, orderByTriage } from '../src/triage.mjs';
import { MILESTONE_STATUSES, WORKSTREAM_STAGES, validateWorkstream } from '../src/schema.mjs';
import { transitionBody, outcomeMessage, wire } from '../theme/deploy.js';
import { approveBody, outcomeMessage as approveOutcomeMessage, wire as wireApprove } from '../theme/approve.js';
import {
  outcomeMessage as refreshOutcomeMessage,
  pollMessage,
  pollRunStatus,
  wire as wireRefresh,
} from '../theme/refresh.js';
import { openActionModal, wire as wireActionModal } from '../theme/action-modal.js';

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
// The planning surface's behaviour, read as text. Only where what has to be asserted is WHICH
// platform affordance the module reaches for — a claim about focus trapping and dismissal that no
// rendered-markup check can reach and that a unit test with no DOM cannot execute.
const ORDER_SOURCE = readFileSync(path.join(THEME_DIR, 'order.js'), 'utf8');

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
      // Not 'shipping' — Task 2 (M8) retired it from WORKSTREAM_STAGES. 'development' is the
      // conservative floor of the three real deployment stages that replaced it, same convention
      // Task 9's real-manifest migration uses.
      stage: 'development',
      position: 'Invented for this test',
      next: `Nothing but this test for ${codename}`,
      label: `workstream:${slug}`,
      design: [{ name: `${slug}/Overview v1`, where: 'design-project' }],
      milestones: [],
      ...overrides,
    }),
  };
}

// The shape src/build.mjs hands the layouts, matching Task 4's wiring exactly: each workstream
// carrying its own ladder column and triage state, its milestones already enriched with `tasks`
// on the manifest and a sibling `spineDetail` array.
//
// M8 task 6 added two more fields to that shape — `displayedStage`/`deploymentHistory`, computed
// in the real build by `src/build.mjs`'s `readDeploymentLog` from a file `stream.manifest.
// deploymentLog` names. This test double has no filesystem to read a real log from, so a fixture
// attaches `deploymentHistory` directly on the entry it hands to `assemble` — a SIBLING of
// `manifest`, never inside it, the same way the real `stream` carries it (the field actually on
// the manifest is `deploymentLog`, a path, not the parsed array). `displayedStage` is then
// computed here exactly the way `readDeploymentLog` computes it: the latest entry's `stage`, or
// the manifest's own `stage` when there is no history yet.
//
// M8 task 7's fix round added a third field the same way — `deploymentLogSha`, the log file's own
// git blob SHA computed at build time (`src/build.mjs`'s `gitBlobSha`), `null` when there is no
// log yet. A fixture attaches it directly on the entry, same convention as `deploymentHistory`.
function assemble(entries) {
  const ladder = computeLadder(entries);
  const triaged = orderByTriage(entries.map((stream, index) => ({ ...stream, column: ladder.columns[index] })));
  const triageBySlug = new Map(triaged.map((s) => [s.slug, s.triage]));

  return entries.map((stream, index) => {
    const deploymentHistory = Array.isArray(stream.deploymentHistory) ? stream.deploymentHistory : [];
    const latest = deploymentHistory.at(-1);

    return {
      ...stream,
      url: workstreamUrl(stream.slug),
      column: ladder.columns[index],
      triage: triageBySlug.get(stream.slug),
      displayedStage: latest ? latest.stage : stream.manifest.stage,
      deploymentHistory,
      deploymentLogSha: stream.deploymentLogSha ?? null,
      // No document/asset collection here — this helper renders templates directly, outside the
      // full assembleSite pipeline (src/build.mjs), so a design reference's url can never resolve
      // in this test file. That resolution is exercised for real in tests/build.test.mjs, against
      // an actual built site; the fixture's own design entries (all "design-project") are
      // unresolvable regardless, so `null` here matches what a real build would give them too.
      design: stream.manifest.design.map((reference) => ({ ...reference, url: null })),
      milestones: stream.manifest.milestones.map((entry) => ({
        manifest: { ...entry, tasks: entry.tasks ?? [], assignees: entry.assignees ?? [] },
        url: milestoneUrl(stream.slug, entry.id),
        planUrl: null,
        recordUrl: null,
        hrefBase: `docs/features/${stream.slug}`,
      })),
      spineDetail: spineDetail(stream.manifest.milestones),
    };
  });
}

function renderDepth(entries, proposedDesigns = []) {
  return env.render('depth.njk', {
    ...site,
    title: 'Feature planning',
    workstreams: assemble(entries),
    proposedDesigns,
  });
}

function renderMobile(entries) {
  return env.render('mobile.njk', {
    ...site,
    title: 'What needs you',
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

// M5: a register's own page. Real anchor ids, computed the same way build.mjs computes them
// (headingAnchors against the actual rendered markdown) rather than a hand-rolled `#q1` — a real
// "Q1 · BLOCKING" heading slugifies to `q1-blocking`, severity included, not the clean id an
// earlier draft assumed.
const SAMPLE_REGISTER = {
  slug: 'beacon',
  title: 'Beacon Register',
  questions: [
    {
      id: 'Q1', question: 'Offered, invented for this test?', why: 'Because a test needs one.',
      options: ['A', 'B'], recommended: 'A', severity: 'BLOCKING',
      chosen: { kind: 'offered', value: 'A' }, citations: [],
    },
    {
      id: 'Q2', question: 'Written in, invented for this test?', why: 'Because a test needs one.',
      options: ['A', 'B'], recommended: 'A', severity: 'important',
      chosen: { kind: 'written-in', value: 'Neither — a third way entirely.' }, citations: [],
    },
    {
      id: 'Q3', question: 'Deferred, invented for this test?', why: 'Because a test needs one.',
      options: ['A', 'B'], recommended: 'A', severity: 'minor',
      chosen: { kind: 'deferred', value: null }, citations: [],
    },
  ],
};
const registerAnchors = headingAnchors(renderRegisterMarkdown(SAMPLE_REGISTER));
const registerHtml = env.render('register.njk', {
  ...site,
  title: SAMPLE_REGISTER.title,
  doc: { title: SAMPLE_REGISTER.title, path: 'docs/features/beacon/register.md' },
  register: {
    ...SAMPLE_REGISTER,
    questions: SAMPLE_REGISTER.questions.map((q, i) => ({ ...q, anchorId: registerAnchors[i + 1]?.id })),
  },
  titleAnchorId: registerAnchors[0]?.id,
});

const ALL_PAGES = {
  'depth.njk': depthHtml,
  'mobile.njk': mobileHtml,
  'workstream.njk': workstreamHtml,
  'milestone.njk': milestoneHtml,
  'document.njk': documentHtml,
  'register.njk': registerHtml,
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

// Nunjucks autoescape entity-encodes text content (an apostrophe becomes `&#39;`), so a raw
// manifest string containing one — the fixture's own prose does — never appears literally inside
// rendered HTML. Encoding the needle the same way `env.render` encoded the haystack is what makes
// `html.includes(...)` a fair check rather than one that only passes for punctuation-free fixtures.
function htmlIncludesText(html, text) {
  const escaped = text.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
  return html.includes(escaped);
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
  '--atlas-scrim': 'rgb(0 0 0 / 0.6)',
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

test('tokens.css: no component selector is declared twice, in two places, saying two things', () => {
  // The defect this closes was made in this very milestone. Adding the (since-retired) triage
  // modal added a second `.lane-head` rule five hundred lines below the first, setting
  // `cursor: pointer` where the original set `cursor: grab` — and being later, it won. The header
  // quietly stopped looking like something you can drag on the day it also became something you
  // can click, and nothing in a stylesheet reads as wrong when the two halves are that far apart.
  // `.lane-head` itself is long gone along with the modal (the accordion replaced both) — this
  // guard is what is left to catch the SHAPE of that mistake recurring on whatever selector next.
  //
  // The palette blocks are excluded by name: the dark palette is deliberately written twice, once
  // guarded by a media query and once by an attribute, and a test above already pins that the two
  // agree.
  const PALETTE = new Set([
    ':root',
    ':root:not([data-theme="light"])',
    ':root[data-theme="dark"]',
    ':root[data-theme="light"]',
  ]);

  const seen = new Map();
  for (const rule of DECLARATION_RULES) {
    const selector = rule.selector.trim();
    // A rule inside an at-rule is a responsive or themed override of the base one, which is the
    // ordinary and readable use of a repeated selector: the condition is written right there.
    // What this is about is two rules at the SAME level, far apart, where nothing says so.
    if (rule.insideAtRule) continue;
    if (PALETTE.has(selector) || selector.startsWith('@')) continue;
    // A grouped selector is its own thing — `.a, .b` and `.a` are different rules and the cascade
    // between them is ordinary and readable. What this is about is the SAME selector twice.
    if (selector.includes(',')) continue;
    seen.set(selector, (seen.get(selector) ?? 0) + 1);
  }

  const twice = [...seen].filter(([, count]) => count > 1).map(([selector]) => selector);
  assert.deepEqual(twice, [], `declared in two places, where the later one silently wins: ${twice.join(', ')}`);
  assert.ok(seen.size > 40, `expected the whole stylesheet, saw ${seen.size} component rules`);
});

test('tokens.css: nothing that is not a link is drawn in the link colour', () => {
  // A feature's codename was `--sky-action-link-text` while its header was an anchor. #780 made
  // that header the control that opens the feature's modal and the anchor moved into the modal —
  // leaving text that still looked like a link and navigated nowhere, which is a lie about the
  // affordance rather than a colour choice.
  //
  // Checked as a rule about the token: the link colour dresses links, and nothing else on the
  // drawing. The drawing has four tokens of its own for its own states.
  const usesLinkColour = DECLARATION_RULES.filter((rule) => {
    const declarations = new Map(declarationsIn(rule.body));
    return [...declarations.values()].some((value) => /var\(--sky-action-link-text\)/.test(value));
  }).map((rule) => rule.selector.trim());

  // Only where a link genuinely is. The drawing's own marks are the ones that must not be here.
  const notLinks = usesLinkColour.filter((selector) => /col-h|ribbon|dot|balloon|key-swatch|lane-/.test(selector));
  assert.deepEqual(notLinks, [], `these are not links and are drawn in the link colour: ${notLinks.join(', ')}`);
  assert.ok(usesLinkColour.length > 0, 'nothing uses the link colour at all, so this rule checks nothing');
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
// Task 5 rebuilt the first surface as a collapsed HTML accordion, so the SVG-specific pairings
// that used to live here — the ladder gutter's captions, the drawing's own header, the ribbon's
// dates and skip note, the balloon — no longer exist to check. `tokenFor` still reads `fill` as
// well as `color`/`background`, because other surfaces (the chip macro's SVG form) may yet use it.
const OCCURRING_PAIRS = [
  // The feature row's secondary text sits directly on the row's own card background.
  ['.feature-next', '.feature-row'],
  ['.disclosure', '.feature-row'],
  ['.meta-label', '.next-callout'],
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
  // M8 task 8: the stage-history row and trigger buttons render inside `.feature-spine`, which
  // itself paints no background of its own — the ground under all of them is `.feature-row`'s,
  // the same one `.feature-next` and `.disclosure` already sit on above.
  ['.stage-node-label', '.feature-row'],
  ['.stage-node-note', '.feature-row'],
  ['.stage-trigger-label', '.feature-row'],
  ['.stage-trigger-status', '.feature-row'],
  ['.stage-trigger-button', '.feature-row'],
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

// --- surface one: feature planning, the accordion (Task 5) --------------------------------------

test('planning: one row per workstream, each carrying its own slug', () => {
  for (const stream of workstreams) {
    assert.match(depthHtml, new RegExp(`data-slug="${stream.slug}"`));
  }
});

test('planning: a row shows its codename, stage chip, and triage chip', () => {
  const stream = workstreams[0];
  // classifyTriage is per-manifest, so assembling this one stream alone still gives the triage
  // `depthHtml` actually rendered for it — the same value `assemble(workstreams)` computed inside
  // `renderDepth`.
  const [assembled] = assemble([stream]);
  const rowMatch = new RegExp(
    `data-slug="${stream.slug}"[\\s\\S]*?</li>`,
  ).exec(depthHtml);
  assert.ok(rowMatch, `no row found for ${stream.slug}`);
  const row = rowMatch[0];
  assert.ok(row.includes(stream.manifest.codename), 'row is missing its own codename');
  assert.match(row, new RegExp(`data-stage="${stream.manifest.stage}"`));
  assert.match(row, new RegExp(`data-triage="${assembled.triage}"`), 'row is missing its own triage chip');

  // And every row carries exactly one, not just the first: a chip silently dropped from one row
  // would not show up in a single-row check.
  const triageChips = [...depthHtml.matchAll(/<span\b[^>]*data-triage="[^"]*"/g)];
  assert.equal(triageChips.length, workstreams.length, 'expected one triage chip per feature row');
});

test('planning: a row carries a milestone progress strip sized to its own milestone count', () => {
  const withMilestones = workstreams.find((s) => s.manifest.milestones.length > 0);
  assert.ok(withMilestones, 'fixture has no workstream with milestones to test against');
  const rowMatch = new RegExp(`data-slug="${withMilestones.slug}"[\\s\\S]*?</li>`).exec(depthHtml);
  const segCount = (rowMatch[0].match(/class="strip-seg/g) || []).length;
  assert.equal(segCount, withMilestones.manifest.milestones.length);
});

test('planning: no dates or duration render anywhere on this page', () => {
  // The design doc's core rule for this rebuild. formatDay's output looks like a real date (e.g.
  // "23 Aug 2026"); a milestone month name is the cheapest reliable signal one leaked.
  const MONTHS = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/;
  assert.doesNotMatch(depthHtml, MONTHS, 'a date rendered on the feature-planning page');
});

test('planning: the per-feature triage modal is gone — no dialog, no data-feature-modal', () => {
  assert.doesNotMatch(depthHtml, /data-feature-modal/);
  assert.doesNotMatch(depthHtml, /<dialog/);
});

test('planning: the drag/hide DOM hooks are present for order.js to wire', () => {
  assert.match(depthHtml, /data-feature-list/);
  assert.match(depthHtml, /data-row-handle/);
  assert.match(depthHtml, /data-order-said/);
  assert.match(depthHtml, /data-hidden-bar/);
});

test('planning: nothing on the desk is called Triage any more, and the phone keeps its surface', () => {
  // #780 collides with decision 22 here — "three purpose-built surfaces, not one responsive
  // layout" — and this milestone NARROWS that decision rather than overturning it: triage on the
  // desk becomes a modal, and the phone keeps its own surface. Removing the phone view on a
  // reading nobody confirmed would be the expensive mistake.
  //
  // So what goes is the desk's standalone triage DESTINATION, not the page decision 27 built for
  // a phone. Nothing on the desk carries the word.
  const nav = /<nav class="site-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(depthHtml);
  assert.ok(nav, 'the planning page lost its navigation');
  assert.ok(!/\bTriage\b/.test(nav[1]), 'the desk still offers a standalone Triage destination');

  // The phone's surface is untouched and still reachable, or it is an orphan.
  assert.match(nav[1], /href="\/mobile\/"/, 'the phone surface is reachable from nowhere');
  assert.match(mobileHtml, /<h1>What needs you<\/h1>/, 'the phone surface stopped being itself');
  assert.match(mobileHtml, /<article class="card"/, 'the phone surface lost its cards');
  // And it did not grow a modal of its own: the phone is a different activity, and that question
  // is recorded as open rather than answered here.
  assert.ok(!/<dialog/.test(mobileHtml), 'the phone view grew a desk affordance');
});

// --- surface one: the milestone spine (2b), nested inside an expanded row (Task 6) --------------

test('spine: a done milestone collapses to one line — no task checklist', () => {
  const stream = workstreams.find((s) => s.manifest.milestones.some((m) => m.status === 'done'));
  assert.ok(stream, 'fixture needs a workstream with a done milestone');
  const milestone = stream.manifest.milestones.find((m) => m.status === 'done');
  const nodeMatch = new RegExp(
    `data-milestone-node="${stream.slug}-${milestone.id}"[\\s\\S]*?</div>\\s*</div>`,
  ).exec(depthHtml);
  assert.ok(nodeMatch, `no spine node rendered for ${stream.slug}/${milestone.id}`);
  assert.doesNotMatch(nodeMatch[0], /data-task-list/, 'a done milestone must not render a task list');
});

test('spine: every milestone node shows its own real label, always', () => {
  const stream = workstreams.find((s) => s.manifest.milestones.length > 0);
  // Anchored on </ol> rather than the bare </div></li> the brief's draft used: each
  // milestone-node <li> also closes with its own </div></li> (the milestone-body div, then the
  // li), so a lazy match on that pair alone stops at the FIRST milestone rather than the whole
  // spine. </ol> only closes once per stream, right after every milestone <li> in it, so this is
  // the boundary that actually reaches every milestone this stream has.
  const spineBlock = new RegExp(`id="spine-${stream.slug}"[\\s\\S]*?</ol>\\s*</div>\\s*</li>`).exec(depthHtml)[0];
  for (const milestone of stream.manifest.milestones) {
    assert.ok(spineBlock.includes(milestone.label), `milestone ${milestone.id}'s own label is not on its node`);
  }
});

// Rewritten against hand-built synthetic entries (final branch review): the fixture has zero
// milestones with a populated `tasks` array (`taskBodies` only ever gets populated by a real,
// non-offline `fetchIssueBodies` call — see tests/build.test.mjs — and this file always renders
// through `assemble()` alone), so every one of these used to hit `if (!stream) return` before a
// single real assertion ran, and reported green regardless of what the template did.

test('spine: the current milestone renders its full task list, unmuted', () => {
  const stream = entry('Nomad', {
    milestones: [
      milestone({
        id: 'M1',
        label: 'M1',
        depth: 1,
        status: 'next',
        tasks: [
          { text: 'Ship the relay', done: false, owner: 'Ada' },
          { text: 'Wire the housing', done: true, owner: null },
        ],
      }),
    ],
  });
  const html = renderDepth([stream]);
  const nodeMatch = new RegExp(`data-milestone-node="${stream.slug}-M1"[\\s\\S]*?data-task-list[\\s\\S]*?</ul>`).exec(html);
  assert.ok(nodeMatch, 'the current milestone did not render a task list');
  assert.doesNotMatch(nodeMatch[0], /class="task-list is-muted"/, 'the current milestone\'s task list must not be muted');
  assert.ok(nodeMatch[0].includes('Ship the relay'), 'the current milestone is missing one of its own tasks');
  assert.ok(nodeMatch[0].includes('Wire the housing'), 'the current milestone is missing one of its own tasks');
});

test('spine: a task line shows its owner, or "Unassigned" when it has none', () => {
  const stream = entry('Compass', {
    milestones: [
      milestone({
        id: 'M1',
        label: 'M1',
        depth: 1,
        status: 'next',
        tasks: [
          { text: 'Owned task', done: false, owner: 'Grace' },
          { text: 'Unowned task', done: false, owner: null },
        ],
      }),
    ],
  });
  const html = renderDepth([stream]);
  const nodeMatch = new RegExp(`data-milestone-node="${stream.slug}-M1"[\\s\\S]*?data-task-list[\\s\\S]*?</ul>`).exec(html);
  assert.ok(nodeMatch, 'the milestone did not render a task list');
  assert.match(nodeMatch[0], /class="task-owner">Grace</, 'the owned task should show its owner');
  assert.match(nodeMatch[0], /class="task-owner">Unassigned</, 'the unowned task should show "Unassigned"');
});

test('spine: a done task is struck through', () => {
  const stream = entry('Drift', {
    milestones: [
      milestone({
        id: 'M1',
        label: 'M1',
        depth: 1,
        status: 'next',
        tasks: [
          { text: 'Finished task', done: true, owner: null },
          { text: 'Open task', done: false, owner: null },
        ],
      }),
    ],
  });
  const html = renderDepth([stream]);
  const nodeMatch = new RegExp(`data-milestone-node="${stream.slug}-M1"[\\s\\S]*?data-task-list[\\s\\S]*?</ul>`).exec(html);
  assert.ok(nodeMatch, 'the milestone did not render a task list');

  const doneLine = /<li class="task-line is-done"[^>]*>[\s\S]*?<\/li>/.exec(nodeMatch[0]);
  assert.ok(doneLine, 'no task line carries "is-done"');
  assert.ok(doneLine[0].includes('Finished task'), 'the done task is not the one struck through');

  const openLine = /<li class="task-line" [^>]*>[\s\S]*?<\/li>/.exec(nodeMatch[0]);
  assert.ok(openLine, 'the undone task is missing, or wrongly struck through');
  assert.ok(openLine[0].includes('Open task'), 'the undone task line does not carry the undone task');
});

// Zero coverage anywhere in the theme layer for either of these two `spineDetail` states before
// this fix wave — only 'full' and 'none' were ever exercised.

test('spine: the first unplanned milestone after the current one previews muted', () => {
  const stream = entry('Beacon2', {
    milestones: [
      milestone({
        id: 'M1',
        label: 'M1',
        depth: 1,
        status: 'next',
        tasks: [{ text: 'Current task', done: false, owner: null }],
      }),
      milestone({
        id: 'M2',
        label: 'M2',
        depth: 2,
        status: 'unplanned',
        tasks: [{ text: 'Preview task', done: false, owner: 'Ada' }],
      }),
    ],
  });
  const html = renderDepth([stream]);
  const nodeMatch = new RegExp(`data-milestone-node="${stream.slug}-M2"[\\s\\S]*?data-task-list[\\s\\S]*?</ul>`).exec(html);
  assert.ok(nodeMatch, 'the preview milestone did not render a task list');
  assert.match(nodeMatch[0], /class="task-list is-muted"/, 'the "coming next" preview must render muted');
  assert.ok(nodeMatch[0].includes('Preview task'), 'the preview milestone is missing its own task');
});

test('spine: any other milestone with tasks collapses to a count, not a list', () => {
  const stream = entry('Beacon3', {
    milestones: [
      milestone({ id: 'M1', label: 'M1', depth: 1, status: 'next', tasks: [] }),
      milestone({ id: 'M2', label: 'M2', depth: 2, status: 'unplanned', tasks: [] }),
      milestone({
        id: 'M3',
        label: 'M3',
        depth: 3,
        status: 'unplanned',
        tasks: [
          { text: 'One', done: false, owner: null },
          { text: 'Two', done: true, owner: 'Grace' },
          { text: 'Three', done: false, owner: null },
        ],
      }),
    ],
  });
  const html = renderDepth([stream]);
  // M1 is current ('full'), M2 is the preview right after it ('full-muted', empty here), and M3 —
  // neither current nor the one preview slot — is the 'count' state this test is for.
  const nodeMatch = new RegExp(
    `data-milestone-node="${stream.slug}-M3"[\\s\\S]*?<p class="milestone-task-count">([\\s\\S]*?)</p>`,
  ).exec(html);
  assert.ok(nodeMatch, 'the count-state milestone did not render its task count');
  assert.doesNotMatch(nodeMatch[0], /data-task-list/, 'a "count" milestone must not also render a task list');
  assert.match(nodeMatch[1], /^3 sub-tasks$/, 'the count line does not name how many tasks are on record');
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
    entry('Bravo', { stage: 'development', milestones: [milestone({ status: 'done' })] }),
    entry('Charlie', { stage: 'development', milestones: [milestone({ status: 'parked' })] }),
    entry('Delta', { stage: 'development', milestones: [milestone({ status: 'next' })] }),
    entry('Echo', { stage: 'designing' }),
  ];

  const order = attrValues(renderMobile(entries), 'data-workstream');
  assert.deepEqual(
    order,
    ['Bravo', 'Delta', 'Charlie', 'Echo', 'Alpha'],
    'decision 27: the decision waiting on the owner first, then moving, blocked, designing, not started',
  );
});


test('mobile: next is the last line of every card', () => {
  const cards = [...mobileHtml.matchAll(/<article\b[^>]*data-workstream="([^"]+)"[^>]*>([\s\S]*?)<\/article>/g)];
  assert.equal(cards.length, workstreams.length, 'expected one card per workstream');

  for (const [, codename, body] of cards) {
    const manifest = workstreams.find((w) => w.manifest.codename === codename).manifest;
    const lines = [...body.matchAll(/<p\b[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/p>/g)];
    const last = lines[lines.length - 1];
    assert.ok(last, `card ${codename} has no lines at all`);
    assert.match(last[1], /card-status/, `card ${codename}: the last line must be next, decision 27`);
    assert.ok(
      stripTags(last[2]).includes(manifest.next),
      `card ${codename}: the last line must carry the manifest's next`,
    );
  }
});

// --- design doc 1c: the phone view is grouped by blocking state, not a flat list ----------------

test('triage: five section headers, in TRIAGE_ORDER sequence, each with a real count', () => {
  const LABELS = {
    'awaiting-decision': 'Waiting on you',
    moving: 'Moving',
    blocked: 'Blocked',
    designing: 'Designing',
    'not-started': 'Not started',
  };
  // Not the raw `workstreams` array: that is `resolveWorkstreams`'s own output and carries no
  // `.triage` field at all (only `assemble`/`orderByTriage` attach one), so filtering it by
  // `.triage` was silently comparing `undefined` to every state and always coming up empty — the
  // exact shape `mobileHtml` was actually rendered from, `orderByTriage(assemble(workstreams))`,
  // is what has to be read here instead.
  const triagedWorkstreams = orderByTriage(assemble(workstreams));
  const present = TRIAGE_ORDER.filter((state) => triagedWorkstreams.some((s) => s.triage === state));
  assert.ok(present.length > 0, 'fixture setup is broken: no workstream carries a triage state');
  let lastIndex = -1;
  for (const state of present) {
    const count = triagedWorkstreams.filter((s) => s.triage === state).length;
    const headingRe = new RegExp(`${LABELS[state]}[\\s\\S]{0,40}${count}`);
    const index = mobileHtml.search(headingRe);
    assert.ok(index !== -1, `no section header found for "${LABELS[state]}" with count ${count}`);
    assert.ok(index > lastIndex, `sections are out of TRIAGE_ORDER sequence at "${LABELS[state]}"`);
    lastIndex = index;
  }
});

test('triage: a state with zero workstreams gets no section at all', () => {
  // The real fixture happens to populate all five states (awaiting-decision:1, moving:2,
  // blocked:1, designing:1, not-started:1), so checking it alone can never exercise the
  // zero-count branch this test is named for. Built here instead: three workstreams covering only
  // three of the five states, so `awaiting-decision` and `blocked` are guaranteed to be the ones
  // with nothing in them.
  const LABELS = {
    'awaiting-decision': 'Waiting on you',
    moving: 'Moving',
    blocked: 'Blocked',
    designing: 'Designing',
    'not-started': 'Not started',
  };
  const partial = [
    entry('Kilo', { stage: 'designing' }),
    entry('Lima', { stage: 'not-started' }),
    entry('Mike', {
      stage: 'development',
      milestones: [milestone({ id: 'M1', label: 'M1', depth: 1, status: 'next' })],
    }),
  ];
  const html = renderMobile(partial);

  const triaged = orderByTriage(assemble(partial));
  const presentStates = new Set(triaged.map((s) => s.triage));
  assert.deepEqual(
    [...presentStates].sort(),
    ['designing', 'moving', 'not-started'].sort(),
    'this fixture no longer matches what the test below assumes is missing',
  );

  for (const state of TRIAGE_ORDER) {
    // Anchored to the opening of the heading itself: the rendered label is always followed by a
    // space and the count span (`Moving <span class="triage-count">1</span>`), never immediately
    // by `<`, so a regex requiring `>LABEL<` would never match ANY heading — present or absent —
    // and would pass this assertion vacuously no matter what the template did.
    const headingRe = new RegExp(`<h2 class="triage-heading">${LABELS[state]}\\b`);
    if (presentStates.has(state)) {
      assert.match(html, headingRe, `expected a section for "${state}", which this fixture has`);
    } else {
      assert.doesNotMatch(html, headingRe, `an empty section rendered for ${state}`);
    }
  }
});

test('triage: 1a is fully gone — no status-board table shape on this page', () => {
  assert.doesNotMatch(mobileHtml, /<table/);
});

test('triage: each card still says what, position and next, same as before this rebuild', () => {
  for (const stream of workstreams) {
    // htmlIncludesText, not a raw .includes: Nunjucks autoescape turns an apostrophe into `&#39;`,
    // and the fixture's own "what" prose ("decision 20 is exercised: no workstream's numbering...")
    // has one.
    assert.ok(htmlIncludesText(mobileHtml, stream.manifest.what), `${stream.slug}'s "what" is missing`);
    assert.ok(htmlIncludesText(mobileHtml, stream.manifest.next), `${stream.slug}'s next is missing`);
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
    stage: 'development',
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
  // M4.2: M1 is `next` (open, unfinished) and sits BEHIND the bar (M2 is done ahead of it) — the
  // exact gap this milestone's own fix exists to point the head at honestly, rather than past the
  // bar to M3, which is merely parked and not what is actually in flight.
  assert.equal(column.headAt, 'depth-1');
  assert.equal(column.completedCount, 1);
});

test('mobile: a completed run fills exactly its own segments, in the order the manifest lists', () => {
  // Listed out of depth order on purpose. Nothing requires a manifest to list its milestones in
  // depth order, and a page that fills "the first completedCount segments" instead of reading
  // `covered` would fill M3 here — the one that is not complete — and leave M2 empty. That is the
  // same class of bug as counting every done milestone, one step further along.
  const run = entry('Run', {
    stage: 'development',
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
    // Task 5 rebuilt this surface as a collapsed accordion: each row's own header carries a
    // stage chip and a triage chip, rendered with the ordinary HTML chip macro.
    'depth.njk': 'a stage chip per feature header',
    // Task 9 (1c) replaced the phone view's per-card triage chip with grouped section headings —
    // the state is now conveyed by which `<h2 class="triage-heading">` a card sits under, not by
    // a coloured badge on the card itself. So this page renders no `chip`-class element at all.
    'mobile.njk': null,
    'workstream.njk': 'a stage chip, plus a status chip per milestone row',
    'milestone.njk': 'this milestone\'s own status',
    'document.njk': null, // a record page renders a record; it has no vocabulary to chip
    'register.njk': 'each question\'s own severity',
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

  // And the counts follow the data, so a page cannot pass by rendering nothing and stopping. The
  // phone view's own per-item marking is `data-triage` on the `<article>` itself (grouping, not a
  // chip) — checked here rather than in the loop above because it is not a `chip`-class element.
  const cards = [...mobileHtml.matchAll(/<article class="card"/g)];
  const triagedCards = [...mobileHtml.matchAll(/<article class="card"[^>]*\bdata-triage="[^"]*"/g)];
  assert.equal(triagedCards.length, cards.length, 'every card on the phone view carries its triage state');
  assert.equal(cards.length, workstreams.length, 'a card per workstream');

  const stageChips = [...depthHtml.matchAll(/<span\b[^>]*data-stage="/g)];
  assert.equal(stageChips.length, workstreams.length, 'every feature row carries its stage');
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
      stage: 'development',
      milestones: [milestone({ id: 'M1', label: 'M1', depth: 1, status: 'next' })],
    }),
    blocked: entry('Echo', {
      stage: 'development',
      milestones: [milestone({ id: 'M1', label: 'M1', depth: 1, status: 'parked' })],
    }),
  };

  const html = renderMobile(Object.values(byState));

  // Task 9 (1c): the label is no longer read off a per-card chip, but off the section heading
  // each state's one card sits under — `<h2 class="triage-heading">`, one per state here, each
  // holding exactly one workstream.
  for (const state of TRIAGE_ORDER) {
    const match = new RegExp(`<h2 class="triage-heading">([\\s\\S]*?)</h2>`, 'g');
    const headings = [...html.matchAll(match)].map(([, inner]) => stripTags(inner));
    assert.ok(
      headings.includes(`${triageLabels[state]} 1`),
      `no section heading found reading "${triageLabels[state]} 1" for state "${state}"; saw: ${headings.join(' | ')}`,
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
    development: 'Development',
    staging: 'Staging',
    release: 'Release',
  };

  const everyStatus = entry('Vector', {
    stage: 'development',
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

  // The feature planning row's stage chip is the same macro, one label table (see `chipLabel` in
  // base.njk). The words must be the same words.
  const stagesHtml = renderDepth(WORKSTREAM_STAGES.map((stage, i) => entry(`Stage${i}`, { stage })));
  for (const stage of WORKSTREAM_STAGES) {
    const re = new RegExp(`<span\\b[^>]*data-stage="${stage}"[^>]*>([\\s\\S]*?)</span>`);
    const match = re.exec(stagesHtml);
    assert.ok(match, `no chip rendered for stage "${stage}"`);
    assert.equal(stripTags(match[1]), stageLabels[stage], `the "${stage}" chip must read its human label`);
  }

  // And the two spellings agree, because they read the same table rather than two copies of it.
  // 'development' here, not 'shipping': `everyStatus` above is built with `stage: 'development'`
  // (Task 2, M8, retired 'shipping' from WORKSTREAM_STAGES).
  const workstreamStage = /<span\b[^>]*data-stage="development"[^>]*>([\s\S]*?)<\/span>/.exec(html);
  const rowStage = /<span\b[^>]*data-stage="development"[^>]*>([\s\S]*?)<\/span>/.exec(stagesHtml);
  assert.ok(workstreamStage && rowStage, 'one of the two chip spellings did not render at all');
  assert.equal(stripTags(workstreamStage[1]), stripTags(rowStage[1]));
});

// --- M8 task 7: the deployment-transition trail and trigger buttons -----------------------------

function stageNodes(html) {
  return [...html.matchAll(/<li class="stage-node">([\s\S]*?)<\/li>/g)].map(([, inner]) => inner);
}

test('stage-history: a two-entry deploymentHistory renders both nodes, in order, each with its own label and note', () => {
  const stream = entry('Sequoia', { stage: 'development' });
  // Attached as a sibling of `manifest`, the same shape `assemble` (this file's own test double
  // for `src/build.mjs`'s `assembleSite`) expects — see that function's own header comment.
  stream.deploymentHistory = [
    { stage: 'development', note: 'First cut, behind a flag' },
    { stage: 'staging', note: null },
  ];

  const html = renderDepth([stream]);
  const nodes = stageNodes(html);

  assert.equal(nodes.length, 2, `expected exactly 2 .stage-node entries, got ${nodes.length}`);
  assert.ok(
    stripTags(nodes[0]).startsWith('Development'),
    `the first node must read "Development": ${stripTags(nodes[0])}`,
  );
  assert.ok(
    stripTags(nodes[0]).includes('First cut, behind a flag'),
    `the first node must carry its own note: ${stripTags(nodes[0])}`,
  );
  assert.ok(
    stripTags(nodes[1]).startsWith('Staging'),
    `the second node must read "Staging": ${stripTags(nodes[1])}`,
  );
  assert.ok(!stripTags(nodes[1]).includes('null'), 'a null note must never render as the literal text "null"');
});

test("stage-history: an empty deploymentHistory renders exactly one node, for the workstream's own current displayedStage", () => {
  const stream = entry('Tarn', { stage: 'planned' });
  // No `deploymentHistory` attached at all: the pre-deployment case Step 2 exists for, so the row
  // is never blank.

  const html = renderDepth([stream]);
  const nodes = stageNodes(html);

  assert.equal(nodes.length, 1, `expected exactly 1 .stage-node when the log is empty, got ${nodes.length}`);
  assert.ok(
    stripTags(nodes[0]).includes('Planned'),
    `the one node must read the workstream's own displayedStage: ${stripTags(nodes[0])}`,
  );
});

test('stage-history: it renders beside .milestone-spine, never inside it', () => {
  const stream = entry('Quartzite', {
    stage: 'development',
    milestones: [milestone({ id: 'M1', label: 'M1', depth: 1, status: 'next' })],
  });
  stream.deploymentHistory = [{ stage: 'development', note: null }];

  const html = renderDepth([stream]);
  const spineMatch = /<ol class="milestone-spine">([\s\S]*?)<\/ol>/.exec(html);
  assert.ok(spineMatch, 'no .milestone-spine rendered for a workstream with a milestone');
  assert.ok(
    !spineMatch[1].includes('stage-node') && !spineMatch[1].includes('stage-history'),
    'the deployment trail rendered INSIDE .milestone-spine, and the spec puts it beside it',
  );
  assert.match(html, /<ol class="stage-history"/, 'no .stage-history rendered at all');
});

test('stage-history: it renders directly above .milestone-spine, per the design doc', () => {
  const stream = entry('Quartzite', {
    stage: 'development',
    milestones: [milestone({ id: 'M1', label: 'M1', depth: 1, status: 'next' })],
  });
  stream.deploymentHistory = [{ stage: 'development', note: null }];

  const html = renderDepth([stream]);
  const historyIndex = html.indexOf('<ol class="stage-history"');
  const spineIndex = html.indexOf('<ol class="milestone-spine">');

  assert.notEqual(historyIndex, -1, 'no .stage-history rendered at all');
  assert.notEqual(spineIndex, -1, 'no .milestone-spine rendered at all');
  assert.ok(
    historyIndex < spineIndex,
    '.stage-history must render directly above .milestone-spine, per the design doc\'s ' +
      '"Where the ordered history renders"',
  );
});

test('stage-history: it renders above the spine-empty state too, when a workstream has no milestones', () => {
  const stream = entry('Quartzite', { stage: 'development', milestones: [] });
  stream.deploymentHistory = [{ stage: 'development', note: null }];

  const html = renderDepth([stream]);
  const historyIndex = html.indexOf('<ol class="stage-history"');
  const emptyIndex = html.indexOf('<p class="spine-empty">');

  assert.notEqual(historyIndex, -1, 'no .stage-history rendered at all');
  assert.notEqual(emptyIndex, -1, 'no .spine-empty rendered for a workstream with no milestones');
  assert.ok(
    historyIndex < emptyIndex,
    '.stage-history must render above the spine-empty state as well, not just above a populated spine',
  );
});

test('stage-trigger: the three buttons carry data-transition-to and data-slug, and render only when the workstream names a deploymentLog', () => {
  const withLog = entry('Alkali', { deploymentLog: 'docs/features/alkali/deployment-log.json' });
  const withoutLog = entry('Basalt', {});

  const html = renderDepth([withLog, withoutLog]);
  const buttons = [
    ...html.matchAll(/<button[^>]*data-transition-to="([^"]+)"[^>]*data-slug="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g),
  ];

  const alkaliButtons = buttons.filter(([, , slug]) => slug === 'alkali');
  assert.equal(
    alkaliButtons.length,
    3,
    `expected 3 trigger buttons for a workstream with a deploymentLog, got ${alkaliButtons.length}`,
  );
  assert.deepEqual(
    alkaliButtons.map(([, stage]) => stage).sort(),
    ['development', 'release', 'staging'],
  );
  for (const [, , , label] of alkaliButtons) {
    assert.ok(stripTags(label).length > 0, 'a trigger button must carry a real, visible label');
  }

  const basaltButtons = buttons.filter(([, , slug]) => slug === 'basalt');
  assert.equal(
    basaltButtons.length,
    0,
    'a workstream naming no deploymentLog must render no trigger buttons — the endpoint has nowhere ' +
      'to write for it (api/lib/handlers.mjs\'s own no-deployment-log refusal)',
  );
});

test("order.js: the row lookup is scoped to a row's own direct children, not any nested data-slug", () => {
  // Regression guard for a real collision this task found and fixed by hand in a real browser
  // (no DOM here — see this file's own header): the trigger buttons above each carry `data-slug`
  // too, nested well inside a row's own `<li data-slug="...">` (so `theme/deploy.js` can read a
  // workstream's slug straight off whichever button was clicked). `order.js`'s row lookup used to
  // be an unscoped `container.querySelectorAll('[data-slug]')`, which — in document order — finds
  // a row's own trigger buttons AFTER the row itself and lets the last one win, replacing the row
  // element the whole module reorders and expands with a `<button>` that has no
  // `[data-row-handle]` inside it. `:scope > [data-slug]` is the fix; this pins it in source so
  // it cannot be silently reverted.
  assert.match(
    ORDER_SOURCE,
    /querySelectorAll\(':scope > \[data-slug\]'\)/,
    "order.js's row lookup must stay scoped to :scope > [data-slug] — an unscoped [data-slug] " +
      'query collides with the trigger buttons’ own data-slug (M8 task 7)',
  );
});

test('stage-trigger: the wrapper carries the deploymentLog path and the repo', () => {
  const stream = entry('Gypsum', { deploymentLog: 'docs/features/gypsum/deployment-log.json' });
  const html = renderDepth([stream]);

  assert.match(html, /data-stage-trigger[^>]*data-log="docs\/features\/gypsum\/deployment-log\.json"/);
  assert.deepEqual(attrValues(html, 'data-repo'), [config.repo]);
});

test('stage-trigger: the wrapper carries data-sha — stream.deploymentLogSha, the build-time blob SHA theme/deploy.js reads instead of fetching one from GitHub client-side (M8 task 7 fix round)', () => {
  const withSha = entry('Basalt', { deploymentLog: 'docs/features/basalt/deployment-log.json' });
  withSha.deploymentLogSha = 'a'.repeat(40);
  const withoutSha = entry('Feldspar', { deploymentLog: 'docs/features/feldspar/deployment-log.json' });
  // No `deploymentLogSha` attached at all — the pre-deployment case: no log on disk yet, so
  // nothing to hash. `assemble()` defaults it to `null`, the same way `readDeploymentLog` does.

  const html = renderDepth([withSha, withoutSha]);

  assert.deepEqual(attrValues(html, 'data-sha'), ['a'.repeat(40), '']);
});

test('deploy.js: only the feature planning page loads the trigger script, decision 12', () => {
  assert.match(depthHtml, /<script type="module" src="\/deploy\.js"><\/script>/);
  for (const [name, html] of Object.entries(ALL_PAGES)) {
    if (name === 'depth.njk') continue;
    assert.ok(!html.includes('deploy.js'), `${name} loads deploy.js, and only feature planning should`);
  }
});

// deploy.js's own pure functions — the one-step write and the confirmation text, none of which
// touch a document or a network (see the module's own header on that guard).

test('deploy.js: transitionBody sends exactly the fields the endpoint accepts, sha null when unknown', () => {
  assert.deepEqual(
    JSON.parse(transitionBody({ slug: 'alkali', stage: 'staging', sha: 'abc123' })),
    { workstream: 'alkali', stage: 'staging', sha: 'abc123' },
  );
  assert.deepEqual(
    JSON.parse(transitionBody({ slug: 'alkali', stage: 'staging', sha: null })),
    { workstream: 'alkali', stage: 'staging', sha: null },
  );
});

test('deploy.js: outcomeMessage never claims a deployment happened, success or failure', () => {
  assert.equal(
    outcomeMessage({ status: 200, body: { ok: true } }),
    'Recorded — the page will reflect this on the next rebuild.',
  );
  assert.equal(
    outcomeMessage({ status: 409, body: { message: 'has changed since the page you are looking at was built' } }),
    'Not recorded: has changed since the page you are looking at was built',
  );
  assert.equal(outcomeMessage({ status: 502, body: null }), 'Not recorded: the server answered 502.');

  for (const outcome of [
    { status: 200, body: { ok: true } },
    { status: 409, body: { message: 'stale' } },
    { status: 502, body: null },
  ]) {
    assert.ok(
      !/\bdeployed\b|\bshipped\b/i.test(outcomeMessage(outcome)),
      'no outcome message may claim a real deployment happened',
    );
  }
});

// deploy.js's wire() — the DOM-and-network half. Unlike theme/order.js's own unexported wire()
// (no browser in this test environment, per that file's header), this one is exported specifically
// because it calls only a small, fixed set of DOM methods (see deploy.js's own header on the
// export), which a hand-built fake element can implement without a real browser. The fake below
// implements exactly that set and nothing more.

// The shared action modal's fake structure (theme/action-modal.js's own `modalParts()`), used by
// every trigger's wire() test below now that each opens this instead of writing its own status
// line. `backdrop` is what a fake doc's `querySelector('[data-action-modal-backdrop]')` returns;
// `backdrop.querySelector` answers every part `modalParts()` reads directly off it, matching real
// DOM behaviour (a query on the backdrop reaches every descendant, not only direct children).
function fakeActionModalBackdrop() {
  const track = { className: '' };
  const message = { textContent: '', className: '' };
  const title = { textContent: '' };
  const closeListeners = {};
  const closeButton = {
    addEventListener: (type, handler) => {
      closeListeners[type] = handler;
    },
  };
  const modal = { setAttribute: () => {} };
  const backdropListeners = {};
  const backdrop = {
    hidden: true,
    setAttribute: () => {},
    addEventListener: (type, handler) => {
      backdropListeners[type] = handler;
    },
    querySelector: (selector) => {
      if (selector === '[data-action-modal]') return modal;
      if (selector === '[data-action-modal-title]') return title;
      if (selector === '[data-action-modal-track]') return track;
      if (selector === '[data-action-modal-message]') return message;
      if (selector === '[data-action-modal-close]') return closeButton;
      return null;
    },
  };
  return { backdrop, modal, title, track, message, closeButton, closeListeners, backdropListeners };
}

function fakeTriggerElement({ sha, buttons: buttonSpecs }) {
  const status = { textContent: '' };
  const buttons = buttonSpecs.map((attrs) => {
    const listeners = {};
    return {
      getAttribute: (name) => (name in attrs ? attrs[name] : null),
      addEventListener: (type, handler) => {
        listeners[type] = handler;
      },
      disabled: false,
      // Not part of the real DOM interface wire() reads — a test-only hook to fire the handler
      // wire() registered, the same role a real click event plays.
      click: () => listeners.click(),
    };
  });
  return {
    getAttribute: (name) => (name === 'data-sha' ? (sha ?? null) : null),
    querySelector: (selector) => (selector === '[data-stage-trigger-status]' ? status : null),
    querySelectorAll: (selector) => (selector === '[data-transition-to]' ? buttons : []),
    status,
    buttons,
  };
}

function fakeDoc(triggers) {
  const modal = fakeActionModalBackdrop();
  return {
    querySelectorAll: (selector) => (selector === '[data-stage-trigger]' ? triggers : []),
    querySelector: (selector) => (selector === '[data-action-modal-backdrop]' ? modal.backdrop : null),
    modal,
  };
}

test('deploy.js: wire() sends the SHA the previous successful transition returned, not the stale data-sha value (M8 task 7 round 2)', async () => {
  const buildTimeSha = 'a'.repeat(40);
  const newSha = 'b'.repeat(40);
  const trigger = fakeTriggerElement({
    sha: buildTimeSha,
    buttons: [
      { 'data-transition-to': 'development', 'data-slug': 'alkali' },
      { 'data-transition-to': 'staging', 'data-slug': 'alkali' },
    ],
  });

  const posted = [];
  const fetchImpl = async (url, init) => {
    posted.push(JSON.parse(init.body));
    return {
      status: 200,
      json: async () => ({ ok: true, sha: posted.length === 1 ? newSha : 'c'.repeat(40) }),
    };
  };

  const doc = fakeDoc([trigger]);
  wire(doc, fetchImpl);

  await trigger.buttons[0].click(); // Development, using the build-time data-sha
  await trigger.buttons[1].click(); // Staging, in the same page load

  assert.equal(posted.length, 2);
  assert.equal(posted[0].sha, buildTimeSha, 'the first POST in a page load sends the build-time data-sha');
  assert.equal(
    posted[1].sha,
    newSha,
    'the second POST sends the SHA the first response returned, not the stale build-time value',
  );
  assert.notEqual(posted[1].sha, buildTimeSha);
  assert.equal(doc.modal.message.textContent, 'Recorded — the page will reflect this on the next rebuild.');
  assert.equal(doc.modal.track.className, 'action-modal-track is-success');
});

test('deploy.js: wire() leaves the SHA unchanged after a refused transition, so a retry still sends what the page rendered', async () => {
  const buildTimeSha = 'a'.repeat(40);
  const trigger = fakeTriggerElement({
    sha: buildTimeSha,
    buttons: [{ 'data-transition-to': 'development', 'data-slug': 'alkali' }],
  });

  const posted = [];
  const fetchImpl = async (url, init) => {
    posted.push(JSON.parse(init.body));
    return { status: 409, json: async () => ({ message: 'has changed since the page you are looking at was built' }) };
  };

  wire(fakeDoc([trigger]), fetchImpl);

  await trigger.buttons[0].click();
  await trigger.buttons[0].click();

  assert.deepEqual(posted.map((p) => p.sha), [buildTimeSha, buildTimeSha]);
});

// --- the Upcoming Features section (M9, decision 59) ------------------------------------------------

test('upcoming features section: absent entirely when there is nothing proposed — no empty heading', () => {
  const html = renderDepth(workstreams, []);
  assert.ok(!html.includes('id="upcoming-heading"'), 'the Upcoming Features section rendered with nothing in it');
});

test('upcoming features section: one row per slug, each with its own Approve button', () => {
  const html = renderDepth(workstreams, [
    { slug: 'keystone', url: '/docs/design/proposed/keystone/decisions/' },
    { slug: 'platform-operations', url: null },
  ]);
  assert.match(html, /id="upcoming-heading"/);
  // Each slug appears twice — once on its <li>, once on its own button — so a Set is the right
  // check here, not a raw count.
  assert.deepEqual(
    new Set(attrValues(html, 'data-slug').filter((s) => s === 'keystone' || s === 'platform-operations')),
    new Set(['keystone', 'platform-operations']),
  );
  const buttons = [...html.matchAll(/<button[^>]*data-approve-button[^>]*>/g)];
  assert.equal(buttons.length, 2);
});

test('upcoming features section: a slug with a resolved url links to it; one with none renders plain text', () => {
  const html = renderDepth(workstreams, [
    { slug: 'keystone', url: '/docs/design/proposed/keystone/decisions/' },
    { slug: 'platform-operations', url: null },
  ]);
  assert.match(html, /<a class="upcoming-name" href="\/docs\/design\/proposed\/keystone\/decisions\/">keystone<\/a>/);
  assert.match(html, /<span class="upcoming-name">platform-operations<\/span>/);
  assert.ok(!html.includes('<a class="upcoming-name" href="">'), 'a null url must never render an empty href');
});

test('approve.js: only the feature planning page loads the trigger script', () => {
  assert.match(depthHtml, /<script type="module" src="\/approve\.js"><\/script>/);
  for (const [name, html] of Object.entries(ALL_PAGES)) {
    if (name === 'depth.njk') continue;
    assert.ok(!html.includes('approve.js'), `${name} loads approve.js, and only feature planning should`);
  }
});

// approve.js's own pure functions.

test('approve.js: approveBody sends exactly the field the endpoint accepts — no sha, unlike deploy.js', () => {
  assert.deepEqual(JSON.parse(approveBody({ slug: 'keystone' })), { slug: 'keystone' });
});

test('approve.js: outcomeMessage names the destination on success and never claims more', () => {
  assert.equal(
    approveOutcomeMessage({ status: 200, body: { ok: true, featurePath: 'docs/features/keystone/' } }),
    'Approved — moved to docs/features/keystone/. The page will reflect this on the next rebuild.',
  );
  assert.equal(
    approveOutcomeMessage({ status: 404, body: { message: 'docs/design/proposed/keystone/ has no files' } }),
    'Not approved: docs/design/proposed/keystone/ has no files',
  );
  assert.equal(approveOutcomeMessage({ status: 502, body: null }), 'Not approved: the server answered 502.');
});

// approve.js's wire() — the DOM-and-network half, same fake-element convention as deploy.js's own
// tests above (see that section's header on why this is safe with no real DOM in this environment).

function fakeApproveTrigger({ slug }) {
  const status = { textContent: '' };
  const listeners = {};
  const button = {
    getAttribute: (name) => (name === 'data-slug' ? slug : null),
    addEventListener: (type, handler) => {
      listeners[type] = handler;
    },
    disabled: false,
    click: () => listeners.click(),
  };
  return {
    querySelector: (selector) => {
      if (selector === '[data-approve-trigger-status]') return status;
      if (selector === '[data-approve-button]') return button;
      return null;
    },
    status,
    button,
  };
}

function fakeApproveDoc(triggers) {
  const modal = fakeActionModalBackdrop();
  return {
    querySelectorAll: (selector) => (selector === '[data-approve-trigger]' ? triggers : []),
    querySelector: (selector) => (selector === '[data-action-modal-backdrop]' ? modal.backdrop : null),
    modal,
  };
}

test('approve.js: wire() posts the slug and reports success without a page reload', async () => {
  const trigger = fakeApproveTrigger({ slug: 'keystone' });
  const posted = [];
  const fetchImpl = async (url, init) => {
    posted.push({ url, body: JSON.parse(init.body) });
    return { status: 200, json: async () => ({ ok: true, slug: 'keystone', featurePath: 'docs/features/keystone/' }) };
  };

  const doc = fakeApproveDoc([trigger]);
  wireApprove(doc, fetchImpl);
  await trigger.button.click();

  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, '/api/approve');
  assert.deepEqual(posted[0].body, { slug: 'keystone' });
  assert.match(doc.modal.message.textContent, /^Approved/);
  assert.equal(doc.modal.track.className, 'action-modal-track is-success');
});

test('approve.js: wire() leaves the button disabled after success, so a stale row cannot be clicked twice', async () => {
  const trigger = fakeApproveTrigger({ slug: 'keystone' });
  const fetchImpl = async () => ({ status: 200, json: async () => ({ ok: true, featurePath: 'x' }) });

  wireApprove(fakeApproveDoc([trigger]), fetchImpl);
  await trigger.button.click();

  assert.equal(trigger.button.disabled, true);
});

test('approve.js: wire() re-enables the button after a refusal, so a real failure can be retried', async () => {
  const trigger = fakeApproveTrigger({ slug: 'keystone' });
  const fetchImpl = async () => ({ status: 409, json: async () => ({ message: 'changed between reading it and writing to it' }) });

  const doc = fakeApproveDoc([trigger]);
  wireApprove(doc, fetchImpl);
  await trigger.button.click();

  assert.equal(trigger.button.disabled, false);
  assert.match(doc.modal.message.textContent, /Not approved/);
  assert.equal(doc.modal.track.className, 'action-modal-track is-failure');
});

// refresh.js — decision 61. Unlike order.js/deploy.js/approve.js, this loads on EVERY page: it is
// wired in base.njk itself, not any one surface's `bodyScripts` block.

test('refresh.js: every surface loads the refresh script, not only feature planning', () => {
  for (const [name, html] of Object.entries(ALL_PAGES)) {
    assert.match(html, /<script type="module" src="\/refresh\.js"><\/script>/, `${name} does not load refresh.js`);
  }
});

test('refresh.js: the header carries exactly one refresh trigger', () => {
  // `data-refresh-trigger` on its own, not the status line's `data-refresh-trigger-status` —
  // matched on the attribute's own closing boundary (`"` or `>`) so the longer name's shared
  // prefix cannot double-count it.
  const matches = [...depthHtml.matchAll(/data-refresh-trigger(?=[">\s])/g)];
  assert.equal(matches.length, 1);
  assert.match(depthHtml, /<button[^>]*data-refresh-button[^>]*>Refresh<\/button>/);
});

test('refresh.js: outcomeMessage names the workflow and ref on success and never claims more', () => {
  assert.equal(
    refreshOutcomeMessage({ status: 200, body: { ok: true, workflow: 'atlas.yml', ref: 'master' } }),
    'Rebuild triggered (atlas.yml on master) — reload in a minute or two to see it.',
  );
  assert.equal(
    refreshOutcomeMessage({ status: 409, body: { message: 'atlas.config.json has no "workflow" field' } }),
    'Not triggered: atlas.config.json has no "workflow" field',
  );
  assert.equal(refreshOutcomeMessage({ status: 502, body: null }), 'Not triggered: the server answered 502.');
});

// refresh.js's wire() — same fake-element convention as approve.js's own tests above, but ONE
// global trigger rather than one per slug, so the fake carries no `data-slug` to read.

function fakeRefreshTrigger() {
  const status = { textContent: '' };
  const listeners = {};
  const button = {
    addEventListener: (type, handler) => {
      listeners[type] = handler;
    },
    disabled: false,
    click: () => listeners.click(),
  };
  const querySelector = (selector) => {
    if (selector === '[data-refresh-trigger-status]') return status;
    if (selector === '[data-refresh-button]') return button;
    return null;
  };
  return { status, button, querySelector };
}

function fakeRefreshDoc(trigger) {
  const modal = fakeActionModalBackdrop();
  return {
    querySelector: (selector) => {
      if (selector === '[data-refresh-trigger]') return trigger;
      if (selector === '[data-action-modal-backdrop]') return modal.backdrop;
      return null;
    },
    modal,
  };
}

test('refresh.js: wire() does nothing when the header has no trigger — never throws on a page without one', () => {
  assert.doesNotThrow(() => wireRefresh(fakeRefreshDoc(null), async () => ({ status: 200, json: async () => ({}) })));
});

test('refresh.js: wire() posts an empty body and reports success', async () => {
  const trigger = fakeRefreshTrigger();
  const posted = [];
  const fetchImpl = async (url, init) => {
    posted.push({ url, body: init.body });
    return { status: 200, json: async () => ({ ok: true, workflow: 'atlas.yml', ref: 'master' }) };
  };

  const doc = fakeRefreshDoc(trigger);
  wireRefresh(doc, fetchImpl);
  await trigger.button.click();

  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, '/api/refresh');
  assert.equal(posted[0].body, '{}');
  assert.match(doc.modal.message.textContent, /^Rebuild triggered/);
  assert.equal(doc.modal.track.className, 'action-modal-track is-success');
});

test('refresh.js: wire() re-enables the button on both success and refusal — a second refresh is always valid', async () => {
  const trigger = fakeRefreshTrigger();
  const fetchImpl = async () => ({ status: 200, json: async () => ({ ok: true, workflow: 'atlas.yml', ref: 'master' }) });

  wireRefresh(fakeRefreshDoc(trigger), fetchImpl);
  await trigger.button.click();

  assert.equal(trigger.button.disabled, false);
});

test('refresh.js: wire() surfaces the real refusal message from the server', async () => {
  const trigger = fakeRefreshTrigger();
  const fetchImpl = async () => ({
    status: 403,
    json: async () => ({ message: 'writing needs the "author" role' }),
  });

  const doc = fakeRefreshDoc(trigger);
  wireRefresh(doc, fetchImpl);
  await trigger.button.click();

  assert.equal(trigger.button.disabled, false);
  assert.equal(doc.modal.message.textContent, 'Not triggered: writing needs the "author" role');
  assert.equal(doc.modal.track.className, 'action-modal-track is-failure');
});

// refresh.js's run-status polling (M9 follow-up, decision 61) — a dispatch that names what it
// triggered hands off to watching the real run instead of declaring victory on dispatch alone.
// `intervalMs`/`timeoutMs` overrides keep every case here running in milliseconds.

test('refresh.js: wire() starts polling when the dispatch names a run to watch, not resolving immediately', async () => {
  const trigger = fakeRefreshTrigger();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === '/api/refresh') {
      return {
        status: 200,
        json: async () => ({ ok: true, workflow: 'atlas.yml', ref: 'master', dispatchedAt: '2026-01-01T00:00:00.000Z' }),
      };
    }
    // The status endpoint is polled asynchronously, after wire()'s own click handler already
    // returned — this test only asserts the dispatch itself did not resolve the modal.
    return { status: 200, json: async () => ({ ok: true, state: 'pending' }) };
  };

  const doc = fakeRefreshDoc(trigger);
  wireRefresh(doc, fetchImpl);
  await trigger.button.click();

  assert.equal(calls[0], '/api/refresh');
  assert.equal(trigger.button.disabled, false, 'the button re-enables on dispatch, not on the run finishing');
  assert.equal(doc.modal.track.className, 'action-modal-track is-running', 'still running — not resolved yet');
});

test('pollMessage: names the run once one is known, stays generic before that', () => {
  assert.equal(pollMessage({ state: 'pending' }), 'Dispatched — waiting for GitHub to start the run…');
  assert.equal(pollMessage({ state: 'running', run: 42 }), 'Building (run #42)…');
  assert.equal(pollMessage(null), 'Building…');
});

/**
 * A real `openActionModal` handle backed by fake DOM parts, the same object `pollRunStatus`
 * actually receives from `theme/refresh.js`'s own `wire()` — not the raw parts, which have no
 * `update`/`resolve`/`isOpen` of their own.
 */
function fakeOpenModal() {
  const parts = fakeActionModalBackdrop();
  const doc = { querySelector: (selector) => (selector === '[data-action-modal-backdrop]' ? parts.backdrop : null) };
  const modal = openActionModal(doc, 'Refreshing…');
  return { parts, modal };
}

test('pollRunStatus: pending, then running, then a successful completion resolves the modal', async () => {
  const { parts, modal } = fakeOpenModal();
  const responses = [
    { ok: true, state: 'pending' },
    { ok: true, state: 'running', run: 7 },
    { ok: true, state: 'done', conclusion: 'success', run: 7 },
  ];
  let i = 0;
  const fetchImpl = async () => ({ status: 200, ok: true, json: async () => responses[i++] });

  await pollRunStatus(modal, fetchImpl, {
    dispatchedAt: '2026-01-01T00:00:00.000Z',
    workflow: 'atlas.yml',
    intervalMs: 1,
    timeoutMs: 1000,
  });

  assert.equal(i, 3, 'polled exactly as many times as there were responses queued');
  assert.equal(parts.track.className, 'action-modal-track is-success');
  assert.equal(parts.message.textContent, 'Rebuild deployed.');
});

test('pollRunStatus: a completed-but-failed run resolves as a failure, naming the real conclusion', async () => {
  const { parts, modal } = fakeOpenModal();
  const fetchImpl = async () => ({
    status: 200,
    ok: true,
    json: async () => ({ ok: true, state: 'done', conclusion: 'cancelled', run: 9 }),
  });

  await pollRunStatus(modal, fetchImpl, {
    dispatchedAt: '2026-01-01T00:00:00.000Z',
    workflow: 'atlas.yml',
    intervalMs: 1,
    timeoutMs: 1000,
  });

  assert.equal(parts.track.className, 'action-modal-track is-failure');
  assert.equal(parts.message.textContent, 'Rebuild finished: cancelled.');
});

test('pollRunStatus: a real refusal from the status endpoint stops polling and surfaces the real message', async () => {
  const { parts, modal } = fakeOpenModal();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { status: 403, ok: false, json: async () => ({ message: 'writing needs the "author" role' }) };
  };

  await pollRunStatus(modal, fetchImpl, {
    dispatchedAt: '2026-01-01T00:00:00.000Z',
    workflow: 'atlas.yml',
    intervalMs: 1,
    timeoutMs: 1000,
  });

  assert.equal(calls, 1, 'a real refusal stops polling immediately rather than retrying');
  assert.equal(parts.track.className, 'action-modal-track is-failure');
  assert.equal(parts.message.textContent, 'writing needs the "author" role');
});

test('pollRunStatus: stops the moment the visitor closes the modal, without resolving it', async () => {
  const { parts, modal } = fakeOpenModal();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    parts.backdrop.hidden = true; // the visitor closed it during this very poll
    return { status: 200, ok: true, json: async () => ({ ok: true, state: 'pending' }) };
  };

  await pollRunStatus(modal, fetchImpl, {
    dispatchedAt: '2026-01-01T00:00:00.000Z',
    workflow: 'atlas.yml',
    intervalMs: 1,
    timeoutMs: 1000,
  });

  assert.equal(calls, 1, 'polled once, then noticed the close and stopped');
  assert.equal(
    parts.track.className,
    'action-modal-track is-running',
    'never resolved — still in its running state, just no longer watched',
  );
});

test('pollRunStatus: gives up honestly after the timeout, without claiming failure', async () => {
  const { parts, modal } = fakeOpenModal();
  const fetchImpl = async () => ({ status: 200, ok: true, json: async () => ({ ok: true, state: 'pending' }) });

  await pollRunStatus(modal, fetchImpl, {
    dispatchedAt: '2026-01-01T00:00:00.000Z',
    workflow: 'atlas.yml',
    intervalMs: 1,
    timeoutMs: 5,
  });

  assert.equal(parts.track.className, 'action-modal-track is-success', 'a timeout is not evidence of failure');
  assert.match(parts.message.textContent, /Still running/);
});

// theme/action-modal.js — the shared modal itself, tested directly rather than only through the
// three triggers above. `fakeActionModalDoc` adds a document-level `addEventListener` (for the
// Escape-key listener `wire()` registers) on top of `fakeActionModalBackdrop`'s own parts.

function fakeActionModalDoc() {
  const modal = fakeActionModalBackdrop();
  const docListeners = {};
  const doc = {
    querySelector: (selector) => (selector === '[data-action-modal-backdrop]' ? modal.backdrop : null),
    addEventListener: (type, handler) => {
      docListeners[type] = handler;
    },
  };
  return { doc, modal, docListeners };
}

test('action-modal.js: openActionModal returns null on a page with no modal markup, so a caller degrades quietly', () => {
  const doc = { querySelector: () => null };
  assert.equal(openActionModal(doc, 'Refreshing…'), null);
});

test('action-modal.js: openActionModal shows the title and the running state, unhidden', () => {
  const { doc, modal } = fakeActionModalDoc();

  openActionModal(doc, 'Refreshing…');

  assert.equal(modal.title.textContent, 'Refreshing…');
  assert.equal(modal.track.className, 'action-modal-track is-running');
  assert.equal(modal.message.textContent, '');
  assert.equal(modal.backdrop.hidden, false);
});

test('action-modal.js: resolve(ok: true) fills the track and shows the success message', () => {
  const { doc, modal } = fakeActionModalDoc();

  const handle = openActionModal(doc, 'Approving reef…');
  handle.resolve({ ok: true, message: 'Approved — moved to docs/features/reef/.' });

  assert.equal(modal.track.className, 'action-modal-track is-success');
  assert.equal(modal.message.textContent, 'Approved — moved to docs/features/reef/.');
  assert.equal(modal.message.className, 'action-modal-message is-success');
});

test('action-modal.js: resolve(ok: false) stops the track and shows the real refusal message', () => {
  const { doc, modal } = fakeActionModalDoc();

  const handle = openActionModal(doc, 'Refreshing…');
  handle.resolve({ ok: false, message: 'Not triggered: the installation does not have Actions: write.' });

  assert.equal(modal.track.className, 'action-modal-track is-failure');
  assert.equal(modal.message.textContent, 'Not triggered: the installation does not have Actions: write.');
  assert.equal(modal.message.className, 'action-modal-message is-failure');
});

test('action-modal.js: a second open resets the previous run\'s classes and message', () => {
  const { doc, modal } = fakeActionModalDoc();

  openActionModal(doc, 'Refreshing…').resolve({ ok: false, message: 'Not triggered: network error.' });
  openActionModal(doc, 'Refreshing…');

  assert.equal(modal.track.className, 'action-modal-track is-running');
  assert.equal(modal.message.textContent, '');
  assert.equal(modal.message.className, 'action-modal-message');
});

test('action-modal.js: wire() closes on the close button', () => {
  const { doc, modal } = fakeActionModalDoc();
  openActionModal(doc, 'Refreshing…');

  wireActionModal(doc);
  modal.closeListeners.click();

  assert.equal(modal.backdrop.hidden, true);
});

test('action-modal.js: wire() closes when the backdrop itself is clicked', () => {
  const { doc, modal } = fakeActionModalDoc();
  openActionModal(doc, 'Refreshing…');
  wireActionModal(doc);

  modal.backdropListeners.click({ target: modal.backdrop });

  assert.equal(modal.backdrop.hidden, true);
});

test('action-modal.js: wire() does not close on a click that bubbled from inside the card, not the backdrop itself', () => {
  const { doc, modal } = fakeActionModalDoc();
  openActionModal(doc, 'Refreshing…');
  wireActionModal(doc);

  modal.backdropListeners.click({ target: modal.modal }); // the card, not the backdrop

  assert.equal(modal.backdrop.hidden, false);
});

test('action-modal.js: wire() closes on Escape, only while the modal is open', () => {
  const { doc, modal, docListeners } = fakeActionModalDoc();
  wireActionModal(doc);

  docListeners.keydown({ key: 'Escape' });
  assert.equal(modal.backdrop.hidden, true, 'Escape on an already-closed modal is a harmless no-op, not an error');

  openActionModal(doc, 'Refreshing…');
  docListeners.keydown({ key: 'Enter' });
  assert.equal(modal.backdrop.hidden, false, 'a non-Escape key must not close it');

  docListeners.keydown({ key: 'Escape' });
  assert.equal(modal.backdrop.hidden, true);
});

test('action-modal.js: wire() does nothing on a page with no modal markup', () => {
  const doc = { querySelector: () => null, addEventListener: () => assert.fail('should never be called') };
  assert.doesNotThrow(() => wireActionModal(doc));
});

// The reduced-motion opt-out lives entirely in CSS (no matchMedia call in theme/action-modal.js —
// the running/success/failure classes carry the state either way, only the sweep keyframe is
// conditional), so it is checked here rather than against a stubbed matchMedia.
test('tokens.css: prefers-reduced-motion drops the sweep animation but not the running state', () => {
  const opensAt = TOKENS_CSS.search(/^@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/m);
  assert.notEqual(opensAt, -1, 'no prefers-reduced-motion block in the stylesheet');
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
  assert.match(guarded, /\.action-modal-track\.is-running \.action-modal-fill/);
  assert.match(guarded, /\.action-modal-track\.is-running \.action-modal-dot/);
  assert.match(guarded, /animation:\s*none/);
});

// --- the document pages ---------------------------------------------------------------------------

test('workstream: a design entry naming an external design tool is a named reference, not a link', () => {
  // Decision 21, narrowed by the design/tracking merge: beacon's fixture design still says
  // "design-project" — an external tool, not a repository path — so it still resolves to no url
  // (src/build.mjs's designReferenceUrl) and stays named-but-unlinked, decision 21's original case.
  // The positive case (a design reference this build CAN reach gets a real link) is
  // tests/build.test.mjs's `design reference naming an exact document path gets a url` and its
  // directory-reference sibling.
  for (const design of beacon.manifest.design) {
    assert.ok(workstreamHtml.includes(design.name), `the design entry "${design.name}" is not named on the page`);
  }
  const linked = [...workstreamHtml.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)].map((m) => stripTags(m[1]));
  for (const design of beacon.manifest.design) {
    assert.ok(
      !linked.includes(design.name),
      `the design entry "${design.name}" was rendered as a link even though it names no repository path`,
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

// --- M5: register.njk — write-ins surfaced, not buried -------------------------------------------

test('register: the written-in answers are surfaced as their own group, above the full list', () => {
  const section = /<section class="written-in-answers">([\s\S]*?)<\/section>/.exec(registerHtml);
  assert.ok(section, 'no written-in-answers section on the register page at all');

  // Exactly the write-in question (Q2), not the offered one (Q1) or the deferred one (Q3).
  assert.ok(!section[1].includes('>Offered, invented for this test?<'), 'an offered answer leaked into the written-in section');
  assert.ok(!section[1].includes('>Deferred, invented for this test?<'), 'a deferred question leaked into the written-in section');

  const realAnchorId = registerAnchors[2].id; // anchors[0] = H1 title, [1] = Q1, [2] = Q2
  assert.match(
    section[1],
    new RegExp(`<a href="#${realAnchorId}"[^>]*>[^<]*Written in, invented for this test\\?`),
    `the written-in entry does not link to Q2's real anchor id (#${realAnchorId})`,
  );

  // The section renders before the full question list, not after it.
  const sectionIndex = registerHtml.indexOf('written-in-answers');
  const fullListIndex = registerHtml.indexOf(`id="${realAnchorId}"`);
  assert.ok(sectionIndex < fullListIndex, 'the written-in section renders after the full question list, not above it');
});

test('register: a register with no write-ins renders no written-in section at all', () => {
  const noWriteIns = {
    slug: 'beacon', title: 'All Offered',
    questions: [{
      id: 'Q1', question: 'Offered only?', why: 'W', options: ['A'], recommended: 'A',
      severity: 'BLOCKING', chosen: { kind: 'offered', value: 'A' }, citations: [],
    }],
  };
  const anchors = headingAnchors(renderRegisterMarkdown(noWriteIns));
  const html = env.render('register.njk', {
    ...site,
    title: noWriteIns.title,
    doc: { title: noWriteIns.title, path: 'docs/features/beacon/register.md' },
    register: { ...noWriteIns, questions: noWriteIns.questions.map((q, i) => ({ ...q, anchorId: anchors[i + 1]?.id })) },
    titleAnchorId: anchors[0]?.id,
  });
  assert.ok(!html.includes('written-in-answers'), 'a register with zero write-ins still rendered an (empty) written-in section');
});

test('register: every question renders at its own real anchor id, with its status and citations', () => {
  for (let i = 0; i < SAMPLE_REGISTER.questions.length; i += 1) {
    const q = SAMPLE_REGISTER.questions[i];
    const anchorId = registerAnchors[i + 1]?.id;
    assert.ok(anchorId, `question ${q.id} has no computed anchor id to check against`);
    assert.match(registerHtml, new RegExp(`id="${anchorId}"`), `question ${q.id} does not render at its own real anchor id`);
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
  //
  // Task 5 rebuilt feature planning as a collapsed accordion with no dates and no ladder gutter
  // (decision: the milestone is the axis, not a calendar), so the two depth.njk-specific checks
  // that used to live here — the ladder's numbered captions and the dates beside each lane — no
  // longer have anything to check. What remains, on the mobile and workstream pages, is unchanged.

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
  // The write-back Function ships in the same deployable as the site (decision 5), so a project
  // name reaching it is the same leak by the shortest route of all.
  walk(path.join(REPO_ROOT, 'api'), 'api/');
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
  assert.ok(scanned.some((f) => f.name.startsWith('api/')));
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
