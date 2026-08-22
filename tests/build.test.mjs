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
const SUMMARY = await build(FIXTURE_ROOT, OUT, { fetchImpl: stubFetch, quiet: true });

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

// The whole emitted tree, named. Not a count, not a spot-check of paths anyone thought to list:
// the SET. Six stray layout pages once shipped past a suite that checked "is /index.html there?"
// and "are there 13 milestone pages?" and never asked what else had appeared.
const EXPECTED_FILES = [
  'ROADMAP/index.html',
  'docs/design/approved/keeper-notes/index.html',
  'docs/design/approved/lighthouse-decisions/index.html',
  'docs/features/anchor/m1-plan/index.html',
  'docs/features/anchor/m2-plan/index.html',
  'docs/features/anchor/m3-plan/index.html',
  'docs/features/anchor/m4-plan/index.html',
  'docs/features/beacon/m1-demo/index.html',
  'docs/features/beacon/m1-plan/index.html',
  'docs/features/beacon/m2-plan/index.html',
  'docs/features/beacon/m3-plan/index.html',
  'docs/features/beacon/m4-plan/index.html',
  'docs/features/beacon/m5-plan/index.html',
  'docs/features/beacon/m6-plan/index.html',
  'docs/features/tide/m1-plan/index.html',
  'docs/features/tide/m2-plan/index.html',
  'docs/features/tide/m3-plan/index.html',
  'docs/field notes.html',
  'docs/reference.html',
  'docs/support.js',
  'index.html',
  'mobile/index.html',
  'records/index.html',
  'state.json',
  'tokens.css',
  'workstream/anchor/index.html',
  'workstream/anchor/m1/index.html',
  'workstream/anchor/m2/index.html',
  'workstream/anchor/m3/index.html',
  'workstream/anchor/m4/index.html',
  'workstream/beacon/index.html',
  'workstream/beacon/m1/index.html',
  'workstream/beacon/m2/index.html',
  'workstream/beacon/m3/index.html',
  'workstream/beacon/m4/index.html',
  'workstream/beacon/m5/index.html',
  'workstream/beacon/m6/index.html',
  'workstream/harbor/index.html',
  'workstream/tide/index.html',
  'workstream/tide/m1/index.html',
  'workstream/tide/m2/index.html',
  'workstream/tide/m3/index.html',
].sort();

test('build: the output is exactly this set of files, and nothing else', () => {
  assert.deepEqual(listFiles(OUT), EXPECTED_FILES);
});

test('build: Eleventy writes exactly the pages the build planned, and nothing of its own', () => {
  // The specific failure the file set above exists to catch, asserted as the invariant rather
  // than by guessing at stray filenames: every page in the output was planned by the build.
  //
  // `theme/_includes/` is Eleventy's default includes directory, and excluding it from template
  // discovery is what keeps the six layouts from becoming pages. When they sat in `theme/` with
  // the includes directory set to `.`, Eleventy skipped that exclusion entirely — it never
  // ignores the input directory — and discovered all six. Six extra files appear here, and the
  // count no longer matches what `planPages` produced.
  const copied = new Set([...state.assets.map((asset) => asset.path), 'tokens.css', 'state.json']);
  const rendered = listFiles(OUT).filter((file) => !copied.has(file));

  assert.equal(
    rendered.length,
    SUMMARY.pages,
    `the build planned ${SUMMARY.pages} pages but ${rendered.length} were written — something rendered itself`,
  );
  assert.equal(SUMMARY.assets, state.assets.length);
});

test('build: the same project builds identically from a foreign working directory', async () => {
  // Decision 39: Atlas runs as a composite action, so the working directory is the *consuming
  // project's* checkout — never the generator's, and sharing no ancestor with it. Anything the
  // build resolves against `process.cwd()` works on a developer's machine and fails there. This
  // is the test the first version of this task did not have, and its absence is what let a
  // cwd-sensitive Eleventy configuration ship.
  const { spawnSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');

  function buildFrom(cwd, name) {
    const out = path.join(TMP_ROOT, name);
    rmSync(out, { recursive: true, force: true });
    const result = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, 'src', 'build.mjs'), FIXTURE_ROOT, out, '--offline', '--quiet'],
      { encoding: 'utf8', cwd },
    );
    assert.equal(result.status, 0, `the build failed from ${cwd}: ${result.stderr}`);
    return out;
  }

  // The same invocation twice, differing only in where it was run from. Both are `--offline`, so
  // any difference between them is the working directory and nothing else.
  const fromGenerator = buildFrom(REPO_ROOT, 'cwd-generator-out');
  const fromElsewhere = buildFrom(tmpdir(), 'cwd-foreign-out');

  assert.deepEqual(listFiles(fromElsewhere), EXPECTED_FILES, 'a foreign cwd produced a different set of files');
  assert.deepEqual(
    hashTree(fromElsewhere),
    hashTree(fromGenerator),
    'the working directory changed the bytes the build produced',
  );
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

test('build: an output directory inside the project is refused before anything is deleted', async () => {
  // `atlas <project> <project>/docs` — someone building "into the docs folder". Without this the
  // build deletes every record in the repository and then fails anyway, because the records it was
  // about to render are the files it just removed.
  const projectRoot = fixtureCopy('outdir-inside');
  const inside = path.join(projectRoot, 'docs');

  const error = await build(projectRoot, inside, { fetchImpl: forbiddenFetch, offline: true, quiet: true })
    .then(() => null, (err) => err);

  assert.ok(error, 'the build accepted an output directory inside the project');
  assert.match(error.message, /inside/, 'the failure never said why the directory was refused');

  // And every record is still there.
  assert.ok(existsSync(path.join(inside, 'features', 'beacon', 'workstream.json')));
  assert.ok(existsSync(path.join(inside, 'design', 'approved', 'lighthouse-decisions.md')));
  assert.ok(existsSync(path.join(inside, 'reference.html')));
});

test('build: an output directory containing the project is refused too', async () => {
  const projectRoot = fixtureCopy('outdir-containing');
  const error = await build(projectRoot, path.dirname(projectRoot), {
    fetchImpl: forbiddenFetch,
    offline: true,
    quiet: true,
  }).then(() => null, (err) => err);

  assert.ok(error, 'the build accepted an output directory that contains the project');
  assert.match(error.message, /contains/);
  assert.ok(existsSync(path.join(projectRoot, 'atlas.config.json')), 'the project was deleted');
});

test('build: a build that fails on a broken reference leaves the published site untouched', async () => {
  // This covers the decision-32 failures, which happen before anything is written anywhere.
  //
  // The other half of the contract — a failure DURING RENDERING, after the point where a
  // wipe-then-refill would already have destroyed the published site — is what the staging swap
  // in `build()` exists for, and it is NOT asserted here: inducing a render failure means putting
  // a throwing template where Eleventy will find it, which is the generator's own `theme/`
  // directory, and `node --test` runs test files in parallel processes. A test that did that
  // would race every other file's build. It is verified by hand instead; see the task report.
  const out = freshDir('swap');
  await build(FIXTURE_ROOT, out, { fetchImpl: stubFetch, quiet: true });
  const published = hashTree(out);

  const broken = fixtureCopy('swap-broken');
  editManifest(broken, 'beacon', (manifest) => {
    manifest.milestones[2].plan = 'never-written.md';
  });

  const error = await build(broken, out, { fetchImpl: forbiddenFetch, offline: true, quiet: true })
    .then(() => null, (err) => err);

  assert.ok(error, 'the broken project built');
  assert.deepEqual(hashTree(out), published, 'a failed build damaged the site that was already there');
  assert.ok(!existsSync(`${out}.atlas-staging`), 'the staging directory was left behind');
});

test('build: an unknown flag is rejected rather than silently ignored', async () => {
  // `--offlien` would otherwise build online without a word, in a generator whose whole ethos is
  // failing loudly.
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, 'src', 'build.mjs'), FIXTURE_ROOT, path.join(TMP_ROOT, 'typo-out'), '--offlien'],
    { encoding: 'utf8' },
  );

  assert.notEqual(result.status, 0, 'a misspelled flag was accepted');
  assert.match(result.stderr, /--offlien/, 'the failure never named the flag it did not understand');
  assert.ok(!existsSync(path.join(TMP_ROOT, 'typo-out')), 'a rejected invocation still wrote a site');
});

// --- the records are reachable ---------------------------------------------------------------------

test('build: the records index lists every record, and every surface links to it', () => {
  const index = read('records/index.html');

  for (const doc of state.documents) {
    assert.ok(index.includes(`href="${doc.url}"`), `the records index never links ${doc.path}`);
  }

  // Exactly the records, not a superset: an entry pointing at a page no longer written is the
  // same failure in the other direction.
  const linked = [...index.matchAll(/<li><a href="([^"]+)">/g)].map((m) => m[1]).sort();
  assert.deepEqual(linked, state.documents.map((d) => d.url).sort());

  // And it is reachable, not merely findable by URL.
  for (const page of ['index.html', 'mobile/index.html', 'workstream/beacon/index.html', 'ROADMAP/index.html']) {
    assert.match(read(page), /href="\/records\/"/, `${page} has no way through to the records`);
  }
});

test('build: no rendered record page is an orphan', () => {
  // Decision 1 makes the site the way to read the project. A record rendered at a URL nothing
  // links to fails that invisibly — the page exists, so nothing looks broken.
  const everyPage = listFiles(OUT)
    .filter((file) => file.endsWith('.html'))
    .map((file) => read(file))
    .join('\n');

  for (const doc of state.documents) {
    assert.ok(everyPage.includes(`href="${doc.url}"`), `${doc.path} is rendered but nothing links to it`);
  }
});

test('build: a milestone page links its plan and its acceptance record', () => {
  // Beacon M1's manifest names docs/features/beacon/m1-demo.md as its acceptance record, and this
  // same build renders it. Naming it without linking it leaves the reader at a dead end.
  const page = read('workstream/beacon/m1/index.html');
  assert.match(page, /href="\/docs\/features\/beacon\/m1-demo\/"/, 'the acceptance record is not linked');
  assert.match(page, /href="\/docs\/features\/beacon\/m1-plan\/"/, "the plan's own record page is not linked");

  // A milestone whose manifest names no record does not borrow another one.
  assert.ok(!read('workstream/beacon/m2/index.html').includes('m1-demo'));
});

test("build: a record page carries one <h1>, and it is the record's own", () => {
  // `doc.title` is derived FROM the record's first heading, so printing it above the record
  // announced the same words twice and put the contents list's first entry on the heading of the
  // page you were already reading.
  for (const doc of state.documents) {
    const page = readFileSync(path.join(OUT, decodeURIComponent(doc.url).replace(/^\//, ''), 'index.html'), 'utf8');
    const openingTags = [...page.matchAll(/<h1\b([^>]*)>/g)].map((m) => m[1]);
    assert.equal(openingTags.length, 1, `${doc.path} renders ${openingTags.length} <h1>s`);
    // Every heading src/markdown.mjs renders carries a stable id; a layout-authored one would
    // not. So this is the record's own heading, not a second one Atlas invented.
    assert.match(openingTags[0], /id="/, `${doc.path}'s heading is not the record's own`);
  }
});

test('build: a milestone page keeps both its headings, which say different things', () => {
  // The opposite ruling to the one above, and deliberate: decision 19 requires the manifest's
  // title spelled out, decision 11 requires the record's own heading. Two authorities, two
  // sentences.
  const headings = [...read('workstream/beacon/m1/index.html').matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)].map(
    (m) => m[1],
  );
  assert.equal(headings.length, 2);
  assert.notEqual(headings[0], headings[1], 'the two headings say the same thing, so one is redundant');
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
