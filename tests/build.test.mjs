import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync, rmSync, mkdirSync, cpSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from '../src/build.mjs';

// Everything here runs against `fixture/`, the invented nautical project, and writes into
// `.tmp-tests/` — deliberately beside the repository rather than in `os.tmpdir()`, which on this
// machine sits on a different filesystem root and degrades `path.relative()` to an absolute path.
//
// There is no network. Every build below is handed a `fetchImpl` that answers from
// `tests/fixtures/issues.json`, so nothing reaches out and the issue buckets are the same on
// every run — one of the several things a byte-identical rebuild depends on.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'fixture');
const TMP_ROOT = path.join(REPO_ROOT, '.tmp-tests');

const ISSUES = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'issues.json'), 'utf8'));

function stubFetch() {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => JSON.parse(JSON.stringify(ISSUES)),
  });
}

// A fetch that fails the test if it is ever called: the proof that a build wired to it never
// reached the network.
function forbiddenFetch(url) {
  throw new Error(`the build reached out to the network: ${url}`);
}

function freshDir(name) {
  const dir = path.join(TMP_ROOT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

// A copy of the fixture that a test may break on purpose.
function fixtureCopy(name) {
  const dir = path.join(TMP_ROOT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.dirname(dir), { recursive: true });
  cpSync(FIXTURE_ROOT, dir, { recursive: true });
  return dir;
}

function editManifest(projectRoot, slug, mutate) {
  const file = path.join(projectRoot, 'docs', 'features', slug, 'workstream.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  mutate(manifest);
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

// Every file under `dir`, as site-root-relative POSIX paths, sorted.
function listFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

function hashTree(dir) {
  return Object.fromEntries(listFiles(dir).map((rel) => [rel, sha256(path.join(dir, rel))]));
}

// --- one shared build of the fixture ------------------------------------------------------------

const OUT = freshDir('fixture-build');
await build(FIXTURE_ROOT, OUT, { fetchImpl: stubFetch, quiet: true });

const read = (rel) => readFileSync(path.join(OUT, rel), 'utf8');
const state = JSON.parse(read('state.json'));

const FIXTURE_WORKSTREAMS = ['beacon', 'tide', 'harbor', 'anchor'];

function manifestOf(slug) {
  return JSON.parse(readFileSync(path.join(FIXTURE_ROOT, 'docs', 'features', slug, 'workstream.json'), 'utf8'));
}

// --- what the build produced --------------------------------------------------------------------

test('build: a page for the depth chart and a page for the phone view', () => {
  assert.ok(existsSync(path.join(OUT, 'index.html')), 'no depth chart at /');
  assert.ok(existsSync(path.join(OUT, 'mobile', 'index.html')), 'no phone view at /mobile/');

  assert.match(read('index.html'), /class="depth-chart"/);
  assert.match(read('mobile/index.html'), /class="card-list"/);

  // Both surfaces render the project's own name, from atlas.config.json and nowhere else.
  assert.match(read('index.html'), /Lighthouse Fixture/);
});

test('build: a page per workstream, and a page per milestone', () => {
  for (const slug of FIXTURE_WORKSTREAMS) {
    const page = path.join(OUT, 'workstream', slug, 'index.html');
    assert.ok(existsSync(page), `no page for workstream "${slug}"`);

    const manifest = manifestOf(slug);
    const html = readFileSync(page, 'utf8');
    assert.ok(html.includes(manifest.codename), `${slug}'s page never names it`);
    assert.ok(html.includes(manifest.gate), `${slug}'s page never states its gate (decision 32)`);

    for (const milestone of manifest.milestones) {
      const milestonePage = path.join(OUT, 'workstream', slug, milestone.id.toLowerCase(), 'index.html');
      assert.ok(existsSync(milestonePage), `no page for ${slug} ${milestone.id}`);

      const milestoneHtml = readFileSync(milestonePage, 'utf8');
      assert.ok(milestoneHtml.includes(milestone.title), `${slug} ${milestone.id}: the page never states its title`);
      // Decision 15: the plan is the authority for content, and this page renders it.
      const plan = readFileSync(path.join(FIXTURE_ROOT, 'docs', 'features', slug, milestone.plan), 'utf8');
      const firstHeading = plan.split('\n').find((line) => line.startsWith('# '))?.slice(2).trim();
      assert.ok(
        firstHeading && milestoneHtml.includes(firstHeading),
        `${slug} ${milestone.id}: the plan's own content is missing from the page`,
      );
    }
  }

  // Exactly the milestones on record, not "at least": a floor stays true while a page disappears.
  const milestonePages = listFiles(OUT).filter((p) => /^workstream\/[^/]+\/[^/]+\/index\.html$/.test(p));
  const expected = FIXTURE_WORKSTREAMS.reduce((n, slug) => n + manifestOf(slug).milestones.length, 0);
  assert.equal(milestonePages.length, expected, `expected ${expected} milestone pages, saw ${milestonePages.length}`);
});

test('build: the theme stylesheet is served where every page links to it', () => {
  assert.ok(existsSync(path.join(OUT, 'tokens.css')), 'no /tokens.css, so every page is unstyled');
  assert.equal(
    sha256(path.join(OUT, 'tokens.css')),
    sha256(path.join(REPO_ROOT, 'theme', 'tokens.css')),
    'the stylesheet was altered on its way out',
  );
  assert.match(read('index.html'), /href="\/tokens\.css"/);
});

test("build: the project's Markdown records are rendered as pages at their own paths", () => {
  // A record at docs/x/y.md becomes /docs/x/y/, because that is what src/markdown.mjs rewrites a
  // relative "y.md" link to. Render them anywhere else and every cross-reference in the corpus
  // breaks.
  const records = [
    'ROADMAP.md',
    'docs/design/approved/lighthouse-decisions.md',
    'docs/design/approved/keeper-notes.md',
    'docs/features/beacon/m1-demo.md',
    'docs/features/beacon/m1-plan.md',
  ];

  for (const record of records) {
    const page = path.join(OUT, record.replace(/\.md$/, ''), 'index.html');
    assert.ok(existsSync(page), `no page rendered for the record ${record}`);
    assert.ok(
      readFileSync(page, 'utf8').includes(record),
      `${record}'s page never names the file it was rendered from (decision 2)`,
    );
  }
});

// --- decision 10: standalone HTML is copied, never templated ------------------------------------

test('build: a standalone .html file and its sibling script are copied byte-for-byte', () => {
  // Decision 10. Asserted by hash rather than by comparing content, because a template engine
  // that picked these up would produce something that still *looks* like the original.
  const copied = ['docs/reference.html', 'docs/field notes.html', 'docs/support.js'];

  for (const rel of copied) {
    const source = path.join(FIXTURE_ROOT, rel);
    const output = path.join(OUT, rel);
    assert.ok(existsSync(output), `${rel} was not copied to the output at all`);
    assert.equal(
      sha256(output),
      sha256(source),
      `${rel} is not byte-identical to its source — something templated it (decision 10)`,
    );
  }

  // And the copies are the files themselves, not pages wrapped around them: no page shell.
  const reference = read('docs/reference.html');
  assert.ok(!reference.includes('class="site-head"'), 'the copied HTML was wrapped in the Atlas page shell');
  assert.ok(!reference.includes('/tokens.css'), "the copied HTML had Atlas's stylesheet injected into it");
});

test('build: a standalone .html file is never also rendered as a record page', () => {
  // The failure this guards is subtle: an .html file both copied *and* picked up as a template
  // would leave a working-looking site with a mangled twin one directory down.
  assert.ok(
    !existsSync(path.join(OUT, 'docs', 'reference', 'index.html')),
    'docs/reference.html was rendered as a page as well as copied',
  );
});

// --- decision 32: a broken reference fails the build --------------------------------------------

test('build: a manifest referencing a missing plan file fails the build, naming the path', async () => {
  // The single most important assertion in this milestone: it is what makes decision 1 — built
  // from source, never maintained — structural rather than aspirational.
  const projectRoot = fixtureCopy('missing-plan');
  editManifest(projectRoot, 'beacon', (manifest) => {
    manifest.milestones[3].plan = 'm4-plan-that-was-never-written.md';
  });

  const out = path.join(TMP_ROOT, 'missing-plan-out');
  rmSync(out, { recursive: true, force: true });

  const error = await build(projectRoot, out, { fetchImpl: forbiddenFetch, quiet: true }).then(
    () => null,
    (err) => err,
  );

  assert.ok(error, 'the build succeeded despite a manifest pointing at a file that does not exist');
  assert.match(
    error.message,
    /m4-plan-that-was-never-written\.md/,
    'the failure never named the missing path, so nobody can act on it',
  );
  assert.match(error.message, /beacon/i, 'the failure never named the workstream it came from');
  assert.match(error.message, /M4\b/, 'the failure never named the milestone it came from');

  assert.ok(
    !existsSync(path.join(out, 'index.html')),
    'a broken reference still produced a site — decision 32 is fail loudly, not render a blank cell',
  );
});

test('build: the same build run through the CLI exits non-zero, naming the path', async () => {
  // The workflow (decision 30) runs the CLI, and a failure that does not reach the exit code is
  // a failure CI will not notice.
  const projectRoot = fixtureCopy('missing-plan-cli');
  editManifest(projectRoot, 'tide', (manifest) => {
    manifest.milestones[0].plan = 'gone.md';
  });

  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, [
    path.join(REPO_ROOT, 'src', 'build.mjs'),
    projectRoot,
    path.join(TMP_ROOT, 'missing-plan-cli-out'),
    '--offline',
  ], { encoding: 'utf8' });

  assert.notEqual(result.status, 0, 'the CLI exited zero on a broken reference');
  assert.match(`${result.stderr}${result.stdout}`, /gone\.md/, 'the CLI never named the missing path');
});

test('build: an unknown milestone status fails the build, naming the value', async () => {
  const projectRoot = fixtureCopy('unknown-status');
  editManifest(projectRoot, 'beacon', (manifest) => {
    manifest.milestones[0].status = 'shipped';
  });

  const error = await build(projectRoot, path.join(TMP_ROOT, 'unknown-status-out'), {
    fetchImpl: forbiddenFetch,
    quiet: true,
  }).then(() => null, (err) => err);

  assert.ok(error, 'the build accepted a status outside the closed vocabulary');
  assert.match(error.message, /"shipped"/, 'the failure never named the offending value');
  assert.match(error.message, /done|next|gated|parked|unplanned/, 'the failure never named what is allowed');
});

test('build: a workstream with no gate fails the build (decision 32)', async () => {
  const projectRoot = fixtureCopy('no-gate');
  editManifest(projectRoot, 'harbor', (manifest) => {
    manifest.gate = '';
  });

  const error = await build(projectRoot, path.join(TMP_ROOT, 'no-gate-out'), {
    fetchImpl: forbiddenFetch,
    quiet: true,
  }).then(() => null, (err) => err);

  assert.ok(error, 'the build rendered a workstream with no gate rather than failing');
  assert.match(error.message, /gate/, 'the failure never named the missing field');
});

// --- a rebuild is byte-identical ----------------------------------------------------------------

test('build: a second build over the same output is byte-identical', async () => {
  // A generator whose output varies run to run cannot be trusted to be current, which is Atlas's
  // entire claim.
  const out = freshDir('determinism');

  await build(FIXTURE_ROOT, out, { fetchImpl: stubFetch, quiet: true });
  const first = hashTree(out);

  await build(FIXTURE_ROOT, out, { fetchImpl: stubFetch, quiet: true });
  const second = hashTree(out);

  assert.deepEqual(Object.keys(second), Object.keys(first), 'the second build produced a different set of files');

  const changed = Object.keys(first).filter((rel) => first[rel] !== second[rel]);
  assert.deepEqual(changed, [], `these files changed between two identical builds: ${changed.join(', ')}`);
});

test('build: no absolute path from the build machine reaches any generated file', () => {
  // The most common way a rebuild stops being reproducible, and the one that survives a hash
  // comparison run twice on the same machine.
  // Each root in all three spellings it could reach a file in: as-is, slash-separated, and
  // backslash-escaped the way JSON.stringify writes a Windows path. Checking only the first of
  // those is how an absolute path hides inside state.json.
  const spellings = [REPO_ROOT, FIXTURE_ROOT, TMP_ROOT, OUT].flatMap((root) => [
    root,
    root.split(path.sep).join('/'),
    JSON.stringify(root).slice(1, -1),
  ]);

  for (const rel of listFiles(OUT)) {
    const text = readFileSync(path.join(OUT, rel), 'utf8');
    for (const spelling of spellings) {
      assert.ok(!text.includes(spelling), `${rel} carries the build machine's own path ${spelling}`);
    }
  }
});

test('build: nothing in the output is dated, so an unchanged project rebuilds unchanged', () => {
  const thisYear = String(new Date().getFullYear());
  for (const rel of listFiles(OUT).filter((p) => p.endsWith('.json'))) {
    const text = readFileSync(path.join(OUT, rel), 'utf8');
    assert.ok(!/"(generated|built|builtAt|generatedAt|timestamp)"/i.test(text), `${rel} stamps a build time`);
    assert.ok(!new RegExp(`${thisYear}-\\d\\d-\\d\\dT`).test(text), `${rel} carries an ISO timestamp`);
  }
});

test('build: the output directory is rebuilt, not accumulated', async () => {
  const out = freshDir('stale');
  writeFileSync(path.join(out, 'left-over.html'), '<p>from a previous build</p>');

  await build(FIXTURE_ROOT, out, { fetchImpl: stubFetch, quiet: true });

  assert.ok(
    !existsSync(path.join(out, 'left-over.html')),
    'a file from a previous build survived — a page whose record was deleted would live forever',
  );
});

// --- the build does not reach out ---------------------------------------------------------------

test('build: GitHub being unreachable is the one tolerated failure, and the site still renders', async () => {
  // Decision 32 is fail-loudly; src/github.mjs is the whole generator's single deliberate
  // exception, because the repository is the part that matters.
  const out = freshDir('no-github');
  const warnings = [];
  const consoleWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  try {
    await build(FIXTURE_ROOT, out, {
      fetchImpl: () => Promise.reject(new Error('getaddrinfo ENOTFOUND api.github.com')),
      quiet: true,
    });
  } finally {
    console.warn = consoleWarn;
  }

  assert.ok(existsSync(path.join(out, 'index.html')), 'the site did not render without GitHub');
  assert.ok(warnings.some((w) => /github/i.test(w)), 'the unreachable API was not warned about');

  const offline = JSON.parse(readFileSync(path.join(out, 'state.json'), 'utf8'));
  assert.deepEqual(offline.issues.unlabelled, []);
  assert.deepEqual(offline.issues.prs, []);
  assert.deepEqual(offline.issues.byLabel, {});

  // Everything that comes from the repository is still there, in full.
  assert.equal(offline.workstreams.length, FIXTURE_WORKSTREAMS.length);
});

test('build: --offline never constructs a request at all', async () => {
  const out = freshDir('offline');
  await build(FIXTURE_ROOT, out, { fetchImpl: forbiddenFetch, offline: true, quiet: true });
  assert.ok(existsSync(path.join(out, 'index.html')));
});
