import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  rmSync,
  mkdirSync,
  cpSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, assembleSite, gitBlobSha } from '../src/build.mjs';
import { MILESTONE_STATUSES } from '../src/schema.mjs';
import { serialiseSwaConfig } from '../src/swa.mjs';

// Everything here runs against `fixture/`, the invented nautical project, and writes into
// `.tmp-tests/` — deliberately beside the repository rather than in `os.tmpdir()`. Where the two
// sit on different filesystem roots, `path.relative()` between them degrades to returning the
// absolute path unchanged, which silently makes every relative-path assertion below unfalsifiable.
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

// `stubFetch` above is URL-blind: every request, including the single-issue endpoint
// `fetchIssueBodies` calls (`GET /repos/{repo}/issues/{n}`), gets back the same issues-LIST
// payload, which has no `.body` shaped like a real single-issue response. Every build in this file
// that is not `--offline` (`SUMMARY` included) has therefore always parsed an empty task list for
// every milestone, regardless of what its linked issue's checklist actually said — nothing in the
// suite proved `fetchIssueBodies -> parseTasks -> milestone.manifest.tasks -> a rendered checklist`
// actually works end to end. This stub tells the two endpoints apart, so a build using it can.
function stubFetchWithIssueBodies(bodiesByNumber, assigneesByNumber = new Map()) {
  return function fetchImpl(url) {
    const match = /\/issues\/(\d+)$/.exec(String(url));
    if (match) {
      const number = Number(match[1]);
      const body = bodiesByNumber.get(number) ?? null;
      return Promise.resolve({
        ok: body !== null,
        status: body !== null ? 200 : 404,
        json: async () => ({ number, body, assignees: assigneesByNumber.get(number) ?? [] }),
      });
    }
    return stubFetch();
  };
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

// Creating a symlink needs a privilege Windows does not grant by default, and fails EPERM over a
// UNC path. The two tests that need one are about a real defect on the target runtime (Linux), so
// they skip rather than fail where the filesystem cannot express the shape they test.
const SYMLINKS_AVAILABLE = (() => {
  const probe = path.join(TMP_ROOT, 'symlink-probe');
  try {
    mkdirSync(TMP_ROOT, { recursive: true });
    rmSync(probe, { force: true });
    symlinkSync(REPO_ROOT, probe, 'dir');
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
})();
const NO_SYMLINKS = SYMLINKS_AVAILABLE ? undefined : 'this filesystem does not allow creating symlinks';

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

const FIXTURE_WORKSTREAMS = ['beacon', 'tide', 'reef', 'harbor', 'anchor', 'shoal'];

function manifestOf(slug) {
  return JSON.parse(readFileSync(path.join(FIXTURE_ROOT, 'docs', 'features', slug, 'workstream.json'), 'utf8'));
}

// --- what the build produced --------------------------------------------------------------------

test('build: a page for the feature planning chart and a page for the phone view', () => {
  assert.ok(existsSync(path.join(OUT, 'index.html')), 'no feature planning chart at /');
  assert.ok(existsSync(path.join(OUT, 'mobile', 'index.html')), 'no phone view at /mobile/');

  assert.match(read('index.html'), /class="feature-list" data-feature-list/);
  assert.match(read('mobile/index.html'), /class="card-list"/);

  // Both surfaces render the project's own name, from atlas.config.json and nowhere else.
  assert.match(read('index.html'), /Lighthouse Fixture/);
});

// The M1 name described the mechanism — a ladder of depths — rather than what the page is for.
// The rename is only done when a reader cannot meet the old word anywhere: not in the title bar,
// not in the navigation, not in a breadcrumb back to it, and not in the machine-readable index an
// agent orients from.
test('build: the first surface is named "Feature planning" everywhere a reader meets it', () => {
  const home = read('index.html');
  assert.match(home, /<title>Feature planning · Lighthouse Fixture<\/title>/, 'the title bar still says something else');
  assert.match(home, /<h1>Feature planning<\/h1>/, 'the page heading still says something else');

  // Every page's navigation, and every breadcrumb that leads back to this one.
  const linkingPages = [
    'index.html',
    'mobile/index.html',
    'library/index.html',
    'workstream/beacon/index.html',
    'workstream/beacon/m1/index.html',
    'ROADMAP/index.html',
  ];
  for (const page of linkingPages) {
    const html = read(page);
    assert.match(html, /href="\/">Feature planning</, `${page} does not call the home surface Feature planning`);
    assert.ok(!/>Project depth</.test(html), `${page} still carries the old name`);
    assert.ok(!/>Depth</.test(html), `${page} still carries the old nav label`);
  }

  const surface = state.surfaces.find((entry) => entry.url === '/');
  assert.ok(surface, 'state.json lists no surface at /');
  assert.equal(surface.title, 'Feature planning');
  // The id is a machine key in a v1 contract, and v1 is not being bumped: only the wording moves.
  assert.equal(surface.id, 'depth');
});

test('build: a page per workstream, and a page per milestone', () => {
  for (const slug of FIXTURE_WORKSTREAMS) {
    const page = path.join(OUT, 'workstream', slug, 'index.html');
    assert.ok(existsSync(page), `no page for workstream "${slug}"`);

    const manifest = manifestOf(slug);
    const html = readFileSync(page, 'utf8');
    assert.ok(html.includes(manifest.codename), `${slug}'s page never names it`);
    assert.ok(html.includes(manifest.next), `${slug}'s page never states its next (decision 32)`);

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
  // M5: the fixture's one register (Task 7's own instruction — a real register.json in the
  // fixture, so the fixture site exercises the whole pipeline, not just tests against it).
  'docs/features/beacon/register/index.html',
  'docs/features/reef/m1-plan/index.html',
  'docs/features/reef/m2-plan/index.html',
  'docs/features/reef/m3-plan/index.html',
  'docs/features/reef/m4-plan/index.html',
  'docs/features/reef/m5-plan/index.html',
  'docs/features/tide/m1-plan/index.html',
  'docs/features/tide/m2-plan/index.html',
  'docs/features/tide/m3-plan/index.html',
  'docs/field notes.html',
  'docs/reference.html',
  'docs/support.js',
  // M8 task 7: the feature planning row's Development/Staging/Release trigger buttons, copied
  // from theme/ alongside tokens.css and order.js — see THEME_FILES in src/build.mjs.
  'deploy.js',
  'index.html',
  'library/index.html',
  'mobile/index.html',
  'order.js',
  // M5 Task 4: the registers index, generated whenever any workstream has a register — beacon
  // does, in this fixture.
  'registers/index.html',
  'state.json',
  'staticwebapp.config.json',
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
  'workstream/reef/index.html',
  'workstream/reef/m1/index.html',
  'workstream/reef/m2/index.html',
  'workstream/reef/m3/index.html',
  'workstream/reef/m4/index.html',
  'workstream/reef/m5/index.html',
  'workstream/shoal/index.html',
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
  const copied = new Set([
    ...state.assets.map((asset) => asset.path),
    'tokens.css',
    'order.js',
    'deploy.js',
    'state.json',
    'staticwebapp.config.json',
  ]);
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

test('build: --quiet means quiet, Eleventy\'s own progress included', async () => {
  // `quietMode` is not enough on its own: Eleventy logs its completion line with `force: true`,
  // which is documented to bypass verbose mode, so `--quiet` still printed `[11ty] Wrote N files`.
  // CI passes `--quiet` expecting silence, and the flag is documented as suppressing exactly this.
  const { spawnSync } = await import('node:child_process');

  function run(flags) {
    const out = path.join(TMP_ROOT, `quiet-${flags.join('')}`.replace(/[^a-z0-9-]/gi, ''));
    rmSync(out, { recursive: true, force: true });
    const result = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, 'src', 'build.mjs'), FIXTURE_ROOT, out, '--offline', ...flags],
      { encoding: 'utf8', cwd: REPO_ROOT },
    );
    assert.equal(result.status, 0, `the build failed: ${result.stderr}`);
    return result;
  }

  const quiet = run(['--quiet']);
  const lines = quiet.stdout.split('\n').filter((line) => line.trim() !== '');

  assert.deepEqual(
    lines.filter((line) => line.includes('[11ty]')),
    [],
    `--quiet must suppress Eleventy's own output, saw: ${lines.join(' | ')}`,
  );
  assert.equal(lines.length, 1, `--quiet leaves exactly Atlas's own summary, saw: ${lines.join(' | ')}`);
  assert.match(lines[0], /^atlas: built \d+ pages/);
  assert.equal(quiet.stderr.trim(), '', `--quiet must print nothing to stderr either: ${quiet.stderr}`);

  // And the flag is doing something: without it, Eleventy is heard from. A test that only asserted
  // silence would also pass if the build had stopped writing anything at all.
  const loud = run([]);
  assert.ok(
    loud.stdout.includes('[11ty]'),
    'without --quiet Eleventy should still report, or this test proves nothing',
  );
});

test('build: every failure names a repository-relative path, and never an absolute one', async () => {
  // Three conventions used to coexist: `src/build.mjs` named paths repository-relative,
  // `src/config.mjs` named them absolutely, and `assertRoadmapExists` and the ladder check named
  // no path at all — so "point Atlas at the wrong directory" answered `ROADMAP.md is missing` with
  // no clue which directory was searched. One convention now, and this is what keeps it: every
  // way a project can break the build, run for real, with both halves asserted — the relative path
  // IS there, and the machine's own path is NOT.
  //
  // Anything absolute would also be noise on a runner (`/home/runner/work/repo/repo/...`) and
  // would contradict this module's own rule about machine paths reaching the reader.
  const cases = [
    {
      what: 'no atlas.config.json at all',
      names: 'atlas.config.json',
      make: (root) => {
        mkdirSync(root, { recursive: true });
      },
    },
    {
      what: 'an atlas.config.json that is not JSON',
      names: 'atlas.config.json',
      make: (root) => {
        mkdirSync(root, { recursive: true });
        writeFileSync(path.join(root, 'atlas.config.json'), '{ not json');
      },
    },
    {
      what: 'an atlas.config.json that fails the schema',
      names: 'atlas.config.json',
      make: (root) => {
        mkdirSync(root, { recursive: true });
        writeFileSync(path.join(root, 'atlas.config.json'), JSON.stringify({ project: 'P' }));
      },
    },
    {
      what: 'no ROADMAP.md',
      names: 'ROADMAP.md',
      make: (root) => {
        mkdirSync(root, { recursive: true });
        writeFileSync(
          path.join(root, 'atlas.config.json'),
          JSON.stringify({ project: 'P', repo: 'o/n', workstreams: [] }),
        );
      },
    },
    {
      what: 'a ROADMAP.md that is a directory',
      names: 'ROADMAP.md',
      make: (root) => {
        mkdirSync(path.join(root, 'ROADMAP.md'), { recursive: true });
        writeFileSync(
          path.join(root, 'atlas.config.json'),
          JSON.stringify({ project: 'P', repo: 'o/n', workstreams: [] }),
        );
      },
    },
    {
      what: 'a workstream directory that is not there',
      names: 'docs/features/ghost',
      make: (root) => {
        mkdirSync(root, { recursive: true });
        writeFileSync(path.join(root, 'ROADMAP.md'), '# R\n');
        writeFileSync(
          path.join(root, 'atlas.config.json'),
          JSON.stringify({ project: 'P', repo: 'o/n', workstreams: ['ghost'] }),
        );
      },
    },
    {
      what: 'a manifest that is not JSON',
      names: 'docs/features/nova/workstream.json',
      make: (root) => {
        mkdirSync(path.join(root, 'docs', 'features', 'nova'), { recursive: true });
        writeFileSync(path.join(root, 'ROADMAP.md'), '# R\n');
        writeFileSync(path.join(root, 'docs', 'features', 'nova', 'workstream.json'), '{ nope');
        writeFileSync(
          path.join(root, 'atlas.config.json'),
          JSON.stringify({ project: 'P', repo: 'o/n', workstreams: ['nova'] }),
        );
      },
    },
    {
      what: 'a manifest naming a plan that is a directory, not a file',
      names: 'is a directory, not a Markdown file',
      make: (root) => {
        mkdirSync(path.join(root, 'docs', 'features', 'nova', 'm1-plan.md'), { recursive: true });
        writeFileSync(path.join(root, 'ROADMAP.md'), '# R\n');
        writeFileSync(
          path.join(root, 'docs', 'features', 'nova', 'workstream.json'),
          JSON.stringify({
            codename: 'Nova',
            what: 'Invented for this test',
            stage: 'development',
            position: 'Invented for this test',
            next: 'Nothing but this test',
            label: 'workstream:nova',
            design: [{ name: 'nova/Overview v1', where: 'design-project' }],
            milestones: [
              {
                id: 'M1',
                label: 'M1',
                depth: 1,
                title: 'Invented',
                status: 'next',
                plan: 'm1-plan.md',
                issue: null,
                pr: null,
                acceptance: { kind: 'demo-script', record: null },
              },
            ],
          }),
        );
        writeFileSync(
          path.join(root, 'atlas.config.json'),
          JSON.stringify({ project: 'P', repo: 'o/n', workstreams: ['nova'] }),
        );
      },
    },
    {
      what: 'a manifest naming a plan file that does not exist',
      names: 'docs/features/nova/workstream.json',
      make: (root) => {
        mkdirSync(path.join(root, 'docs', 'features', 'nova'), { recursive: true });
        writeFileSync(path.join(root, 'ROADMAP.md'), '# R\n');
        writeFileSync(
          path.join(root, 'docs', 'features', 'nova', 'workstream.json'),
          JSON.stringify({
            codename: 'Nova',
            what: 'Invented for this test',
            stage: 'development',
            position: 'Invented for this test',
            next: 'Nothing but this test',
            label: 'workstream:nova',
            design: [{ name: 'nova/Overview v1', where: 'design-project' }],
            milestones: [
              {
                id: 'M1',
                label: 'M1',
                depth: 1,
                title: 'Invented',
                status: 'next',
                plan: 'missing-plan.md',
                issue: null,
                pr: null,
                acceptance: { kind: 'demo-script', record: null },
              },
            ],
          }),
        );
        writeFileSync(
          path.join(root, 'atlas.config.json'),
          JSON.stringify({ project: 'P', repo: 'o/n', workstreams: ['nova'] }),
        );
      },
    },
  ];

  let index = 0;
  for (const scenario of cases) {
    index += 1;
    const root = path.join(TMP_ROOT, `messages-${index}`);
    const out = path.join(TMP_ROOT, `messages-${index}-out`);
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
    scenario.make(root);

    const error = await build(root, out, { fetchImpl: forbiddenFetch, offline: true, quiet: true })
      .then(() => null)
      .catch((err) => err);

    assert.ok(error, `${scenario.what}: the build did not fail at all`);
    assert.ok(
      error.message.includes(scenario.names),
      `${scenario.what}: the failure does not name "${scenario.names}" — ${error.message}`,
    );
    assert.ok(
      !error.message.includes(path.resolve(root)),
      `${scenario.what}: the failure names an absolute path from this machine — ${error.message}`,
    );
    assert.ok(
      !/[A-Za-z]:\\|^\/(home|Users|tmp|var)\//.test(error.message),
      `${scenario.what}: the failure carries a machine path — ${error.message}`,
    );
  }
});

test('build: the output guard is the ONE exception to that rule, and it is an exception on purpose', async () => {
  // Every other failure names a repository-relative path. `src/outdir.mjs` names an absolute one,
  // and the enforcement list above had no output-guard case — so the exception was real,
  // undocumented, and untested, which is how an exception becomes a second convention.
  //
  // It is the right exception: the output directory is the one path a caller supplies that need
  // not be inside the repository at all (`/var/www/current` is an ordinary answer), and
  // relativising it against the project root would produce a string of `../` that is harder to act
  // on rather than easier.
  const root = path.join(TMP_ROOT, 'guard-message');
  const out = path.join(root, 'docs');
  rmSync(root, { recursive: true, force: true });
  cpSync(FIXTURE_ROOT, root, { recursive: true });

  const error = await build(root, out, { fetchImpl: forbiddenFetch, offline: true, quiet: true })
    .then(() => null)
    .catch((err) => err);

  assert.ok(error, 'building into the records was allowed');
  assert.match(error.message, /^refusing to build into /, error.message);
  // The exception, asserted rather than assumed: this message DOES carry the absolute output path.
  assert.ok(
    error.message.includes(path.resolve(out)),
    `the guard must name the output directory in full, so the caller can see which path it means — ${error.message}`,
  );
  // And it names what it collided with repository-relative-ish — by role, not by machine path
  // alone, so the reader knows what they would have destroyed.
  assert.match(error.message, /the project's records/, error.message);

  // The exception is confined to the guard: nothing else in the generator does this. Every other
  // failure path is covered by the test above.
  assert.ok(
    !/atlas: build failed/.test(error.message),
    'this is the thrown error, before the CLI wraps it',
  );
});

test('build: the CLI prefixes everything it says with atlas:', async () => {
  // Three console.error calls in `main`, and one of them used to go out bare. A caller filtering
  // a workflow log on the generator's name would have missed it.
  const { spawnSync } = await import('node:child_process');

  for (const argv of [[], ['--offlien', FIXTURE_ROOT], [path.join(TMP_ROOT, 'no-such-project')]]) {
    const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'src', 'build.mjs'), ...argv], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });
    assert.notEqual(result.status, 0, `expected a non-zero exit for: ${argv.join(' ')}`);

    const said = result.stderr.split('\n').filter((line) => line.trim() !== '');
    assert.ok(said.length > 0, `nothing was said at all for: ${argv.join(' ')}`);
    for (const line of said) {
      assert.match(line, /^atlas: /, `an unprefixed line for "${argv.join(' ')}": ${line}`);
    }
  }
});

test('package.json: decision 9\'s two runtime dependencies, and nunjucks declared for the tests', () => {
  // Two separate regressions, and the suite noticed neither. Adding a THIRD runtime dependency
  // left it at 228/228; so did deleting `nunjucks` from devDependencies, because Eleventy hoists
  // its own copy — so the import in this repository keeps resolving and breaks only on a
  // consumer's pnpm, Yarn PnP or `--install-strategy=nested` install, which is exactly how it
  // shipped the first time.
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

  assert.deepEqual(
    Object.keys(manifest.dependencies ?? {}).sort(),
    ['@11ty/eleventy', 'markdown-it'],
    'decision 9 names these two and no others; a third runtime dependency is a decision, not a patch',
  );

  assert.ok(
    manifest.devDependencies?.nunjucks,
    'nunjucks is imported by tests/theme.test.mjs and must be declared, not borrowed from Eleventy\'s hoisting',
  );

  // And it is a devDependency, not a runtime one — the whole point of declaring it.
  assert.ok(!('nunjucks' in (manifest.dependencies ?? {})), 'nunjucks is a test dependency, not a runtime one');
});

// --- the README, checked against the code it describes ---------------------------------------------

// The README said `design` entries render "as plain links" while the layout, `src/state.mjs` and a
// test all said the opposite, and it documented no way to run anything — no `npm test`, no CLI,
// and no mention of `state.json`, the whole agent-facing contract of decision 29. Prose drifts
// silently; this is what stops it.

const README = readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');

test('README: it documents exactly the flags the command line accepts', async () => {
  // The list comes from the CLI's own refusal message, so it cannot drift from `KNOWN_FLAGS`.
  const { spawnSync } = await import('node:child_process');
  const refused = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, 'src', 'build.mjs'), FIXTURE_ROOT, path.join(TMP_ROOT, 'flags'), '--nope'],
    { encoding: 'utf8', cwd: REPO_ROOT },
  );
  const accepted = [...refused.stderr.matchAll(/--[a-z][a-z-]*/g)]
    .map((m) => m[0])
    .filter((flag) => flag !== '--nope');
  assert.ok(accepted.length > 0, `could not read the accepted flags back: ${refused.stderr}`);

  for (const flag of new Set(accepted)) {
    assert.ok(README.includes(`\`${flag}\``), `the README does not document ${flag}`);
  }

  const documented = [...README.matchAll(/`(--[a-z][a-z-]*)`/g)].map((m) => m[1]);
  for (const flag of new Set(documented)) {
    assert.ok(
      accepted.includes(flag),
      `the README documents ${flag}, which the command line does not accept`,
    );
  }
});

test('README: it documents how to run the suite and the generator at all', () => {
  assert.match(README, /npm test/, 'the README never says how to run the tests');
  assert.match(
    README,
    /node src\/build\.mjs <project-root>/,
    'the README never gives the CLI that CI itself invokes',
  );
});

test('README: what it says about a design entry is what the code does (decision 21, narrowed)', () => {
  // Decision 21, narrowed by the design/tracking merge: a where naming something outside the
  // repository resolves to no url and stays text, never a link nobody could follow. The README
  // used to say ALL design entries are unlinked, unconditionally — that stopped being true once
  // design content moved into docs/features/<slug>/, so this now checks the narrower claim.
  assert.ok(
    !/as plain links/.test(README),
    'the README still describes every design entry as a link, which decision 21 forbids',
  );
  assert.match(
    README,
    /stays text, never a link/,
    'the README must say an unresolvable design entry stays text rather than becoming a link',
  );

  // And the fixture's own design entries — every one still "design-project", an external tool —
  // still behave that way, read from this build's own output rather than trusted. The positive
  // case (a resolvable where DOES link) is covered directly in this file's own
  // "design reference naming an exact document path gets a url" test.
  const beacon = JSON.parse(readFileSync(path.join(OUT, 'state.json'), 'utf8')).workstreams.find(
    (w) => w.design.length > 0,
  );
  assert.ok(beacon, 'no workstream in the fixture carries a design entry to check');
  const page = readFileSync(path.join(OUT, 'workstream', beacon.slug, 'index.html'), 'utf8');
  for (const reference of beacon.design) {
    assert.ok(page.includes(reference.name), `${reference.name} is not named on the page`);
    assert.ok(
      !new RegExp(`<a\\b[^>]*>[^<]*${reference.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(page),
      `${reference.name} was rendered as a link even though its where names no repository path`,
    );
  }
});

test('README: it describes state.json, and every key it shows is one the build emits', () => {
  // Decision 29's entire agent-facing contract went undocumented. Now that it is written down, the
  // keys in that block are checked against the file this build actually wrote.
  assert.match(README, /state\.json/, 'the README never mentions state.json');

  const state = JSON.parse(readFileSync(path.join(OUT, 'state.json'), 'utf8'));
  const block = /```jsonc\n([\s\S]*?)```/.exec(README);
  assert.ok(block, 'the README shows no state.json shape');

  const topLevel = [...block[1].matchAll(/^  "([a-zA-Z]+)":/gm)].map((m) => m[1]);
  assert.ok(topLevel.length > 5, `expected the shape to show its top-level keys, saw ${topLevel}`);
  for (const key of topLevel) {
    assert.ok(key in state, `the README documents a top-level "${key}" that state.json does not have`);
  }
  for (const key of Object.keys(state)) {
    assert.ok(topLevel.includes(key), `state.json emits "${key}" and the README does not show it`);
  }

  // The two properties the README tells a consumer to rely on.
  const [stream] = state.workstreams;
  for (const key of ['dir', 'manifestPath']) {
    assert.ok(!path.isAbsolute(stream[key]), `${key} is absolute, which the README says it never is`);
  }
});

test('README: it states the state.json compatibility rule, which agents are the audience for', () => {
  // The rule lived only in a comment at src/state.mjs. A consumer that parses state.json strictly
  // — rejecting unknown keys — breaks on a release that, by this rule, broke nothing. `v1.0.0` is
  // the first published version of the contract, so this is the moment to say it.
  const section = README.slice(README.indexOf('## `state.json`'));
  assert.ok(section.length > 200, 'no state.json section in the README');
  assert.match(
    section,
    /adding a key does not bump it/i,
    'the README does not say that additive keys leave `version` alone',
  );

  // And the module it describes still says the same thing, so the two cannot drift.
  const state = readFileSync(path.join(REPO_ROOT, 'src', 'state.mjs'), 'utf8');
  assert.match(
    state,
    /a new optional key does not/i,
    'src/state.mjs no longer states the rule the README quotes',
  );
});

test('README: the documented workflow guards against two builds of one project at once', () => {
  // Decision 30's six-hourly schedule plus a push is two builds into one output directory. Atlas
  // refuses the second rather than publishing a mixture, so this is not a correctness hole — but a
  // cancelled run is a better answer than a failed one, and the consumer is the only one who can
  // ask for it.
  const consuming = [...README.matchAll(/```yaml\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .find((example) => example.includes('runs-on:'));
  assert.ok(consuming, 'the README shows no consuming workflow');
  assert.match(consuming, /concurrency:/, 'the documented workflow has no concurrency group');
  assert.match(consuming, /group:/, 'a concurrency block with no group is not one');
});

test('README: the consuming workflow it documents grants the token what the build needs', () => {
  // Without `issues: read`, an org that restricts the default token gets a 403, `src/github.mjs`
  // correctly degrades to empty buckets, and the consumer publishes a site that silently claims
  // every workstream has no backlog. That is the one failure decision 32 tolerates being turned
  // into a lie by an omission in the docs.
  const workflow = /```yaml\n([\s\S]*?)```/g;
  const examples = [...README.matchAll(workflow)].map((m) => m[1]);
  const consuming = examples.find((example) => example.includes('runs-on:'));
  assert.ok(consuming, 'the README shows no consuming workflow');

  assert.match(consuming, /permissions:/, 'the documented workflow grants no permissions at all');
  assert.match(consuming, /issues:\s*read/, 'without issues: read every backlog on the site is empty');
  assert.match(consuming, /contents:\s*read/, 'without contents: read the checkout cannot run');
});

test('build: every URL it emits is encoded, on the pages and in state.json alike', async () => {
  // Two conventions used to coexist: records and assets went through `encodeUrlPath`, while
  // workstream and milestone URLs were raw interpolation. A workstream directory named `har bor`
  // produced `href="/workstream/har bor/"` on the site AND in `state.json` — an invalid URL in a
  // v1 contract — next to a correctly encoded `/docs/field%20notes.html`.
  const root = path.join(TMP_ROOT, 'spacey-project');
  const out = path.join(TMP_ROOT, 'spacey-out');
  rmSync(root, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });

  const slug = 'har bor';
  const streamDir = path.join(root, 'docs', 'features', slug);
  mkdirSync(streamDir, { recursive: true });
  writeFileSync(path.join(root, 'ROADMAP.md'), '# Roadmap\n');
  writeFileSync(path.join(root, 'docs', 'field notes.md'), '# Field notes\n');
  writeFileSync(path.join(streamDir, 'm1-plan.md'), '# Plan\n');
  writeFileSync(
    path.join(root, 'atlas.config.json'),
    JSON.stringify({ project: 'Spacey', repo: 'example-org/spacey', workstreams: [slug] }),
  );
  writeFileSync(
    path.join(streamDir, 'workstream.json'),
    JSON.stringify({
      codename: 'Spacey',
      what: 'Invented for this test',
      stage: 'development',
      position: 'Invented for this test',
      next: 'Nothing but this test',
      label: 'workstream:spacey',
      design: [{ name: 'spacey/Overview v1', where: 'design-project' }],
      milestones: [
        {
          id: 'M1',
          label: 'M1',
          depth: 1,
          title: 'Invented',
          status: 'next',
          plan: 'm1-plan.md',
          issue: null,
          pr: null,
          acceptance: { kind: 'demo-script', record: null },
        },
      ],
    }),
  );

  await build(root, out, { fetchImpl: forbiddenFetch, offline: true, quiet: true });
  const state = JSON.parse(readFileSync(path.join(out, 'state.json'), 'utf8'));

  // Every URL in state.json, wherever it appears, survives being parsed as one.
  const urls = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'url' && typeof value === 'string' && value.startsWith('/')) urls.push(value);
        else walk(value);
      }
    }
  };
  walk(state);
  assert.ok(urls.length > 3, `expected state.json to carry URLs, saw ${urls.length}`);

  for (const url of urls) {
    assert.ok(!/[ "<>\\^`{|}]/.test(url), `state.json carries an unencoded URL: ${url}`);
    assert.equal(new URL(url, 'https://example.invalid').pathname, url, `not a stable URL: ${url}`);
  }

  // Specifically: the workstream whose directory has a space in it, and its milestone.
  const stream = state.workstreams[0];
  assert.equal(stream.url, '/workstream/har%20bor/');
  assert.equal(stream.milestones[0].url, '/workstream/har%20bor/m1/');
  // And the sibling convention it used to disagree with.
  assert.ok(
    state.documents.some((doc) => doc.url === '/docs/field%20notes/'),
    `the records were encoded differently: ${state.documents.map((d) => d.url).join(', ')}`,
  );

  // The pages agree, and the files are actually there under their real names.
  const chart = readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.ok(chart.includes('href="/workstream/har%20bor/"'), 'the chart links to an unencoded URL');
  assert.ok(!chart.includes('href="/workstream/har bor/"'), 'the chart links to an unencoded URL');
  assert.ok(existsSync(path.join(out, 'workstream', 'har bor', 'index.html')), 'no page was written');
  assert.ok(existsSync(path.join(out, 'workstream', 'har bor', 'm1', 'index.html')));
});

test('build: a workstream entry that is a path, not a name, is refused before anything is written', async () => {
  // Executed before the rule existed: `["beacon", "../features/beacon"]` built at EXIT 0, reporting
  // "built 34 pages", with one workstream silently having no page and `state.json` carrying the
  // slug `"../features/beacon"`. The other spellings surfaced raw Eleventy and Node errors naming
  // absolute paths on the build machine — one of them inside the GENERATOR's own theme directory.
  //
  // The third shape is the one that matters most for `src/outdir.mjs`: a workstream resolved to
  // `<project>/outside-ws` is a path the build READS which the output guard does not protect, so
  // its stated contract — "every path the build reads" — was not actually held. This rule is what
  // makes it true.
  const shapes = ['../features/beacon', './beacon', '../../outside-ws', 'tide/../beacon', '.hidden'];

  let index = 0;
  for (const slug of shapes) {
    index += 1;
    const root = path.join(TMP_ROOT, `slug-${index}`);
    const out = path.join(TMP_ROOT, `slug-${index}-out`);
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
    cpSync(FIXTURE_ROOT, root, { recursive: true });
    writeFileSync(
      path.join(root, 'atlas.config.json'),
      JSON.stringify({ project: 'P', repo: 'o/n', workstreams: ['beacon', slug] }),
    );

    const error = await build(root, out, { fetchImpl: forbiddenFetch, offline: true, quiet: true })
      .then(() => null)
      .catch((err) => err);

    assert.ok(error, `${slug}: the build did not fail — it used to build this at exit 0`);
    assert.ok(
      error.message.includes(JSON.stringify(slug)),
      `${slug}: the failure does not quote the entry — ${error.message}`,
    );
    // I8's one convention, which every one of these used to break by surfacing a raw Eleventy or
    // Node error carrying an absolute path.
    assert.ok(
      !error.message.includes(path.resolve(root)) && !error.message.includes(REPO_ROOT),
      `${slug}: the failure carries a machine path — ${error.message}`,
    );
    assert.ok(!existsSync(out), `${slug}: something was written before the refusal`);
  }
});

test('build: two builds into one output directory — at most one may report success', async () => {
  // Executed before the staging claim was made atomic: two builds of DIFFERENT projects into one
  // output directory BOTH reported exit 0 and success, while only one project's pages survived the
  // swap — and the winner could publish a mixture whose `state.json` did not parse, which is
  // decision 29's whole agent-facing contract. A build that says it published something it did not
  // is worse than one that fails.
  //
  // This is deterministic despite being about a race: whichever build wins, the assertions are the
  // same. Exactly one succeeds, the loser touched nothing, and what is published is one project
  // whole.
  const a = path.join(TMP_ROOT, 'race-a');
  const b = path.join(TMP_ROOT, 'race-b');
  const out = path.join(TMP_ROOT, 'race-out');
  for (const dir of [a, b, out, `${out}.atlas-staging`]) rmSync(dir, { recursive: true, force: true });

  function project(root, name, workstreams) {
    cpSync(FIXTURE_ROOT, root, { recursive: true });
    const config = JSON.parse(readFileSync(path.join(root, 'atlas.config.json'), 'utf8'));
    writeFileSync(
      path.join(root, 'atlas.config.json'),
      JSON.stringify({ ...config, project: name, workstreams }),
    );
  }
  project(a, 'Alpha Project', ['beacon']);
  project(b, 'Bravo Project', ['tide', 'harbor', 'anchor']);

  const settled = await Promise.allSettled([
    build(a, out, { fetchImpl: forbiddenFetch, offline: true, quiet: true }),
    build(b, out, { fetchImpl: forbiddenFetch, offline: true, quiet: true }),
  ]);

  const won = settled.filter((r) => r.status === 'fulfilled');
  const lost = settled.filter((r) => r.status === 'rejected');
  assert.equal(won.length, 1, 'both builds reported success into one output directory');
  assert.equal(lost.length, 1);
  assert.match(
    lost[0].reason.message,
    /^refusing to build into /,
    `the losing build failed for the wrong reason: ${lost[0].reason.message}`,
  );
  assert.ok(lost[0].reason.message.includes('.atlas-staging'), lost[0].reason.message);

  // The loser threw before the build's own try/finally, so it removed nothing — including the
  // winner's staging directory, which the winner then renamed into place.
  assert.ok(!existsSync(`${out}.atlas-staging`), 'a staging directory was left behind');

  // And what was published is ONE project, whole. This is the assertion that fails loudest on a
  // mixture: `state.json` must parse, and every workstream it lists must have a page.
  const state = JSON.parse(readFileSync(path.join(out, 'state.json'), 'utf8'));
  const published = readdirSync(path.join(out, 'workstream')).sort();
  assert.deepEqual(
    published,
    state.workstreams.map((w) => w.slug).sort(),
    'the published pages and state.json describe different projects',
  );
  assert.ok(
    ['Alpha Project', 'Bravo Project'].includes(state.project),
    `state.json names a project neither build was building: ${state.project}`,
  );
  assert.equal(
    state.project === 'Alpha Project' ? 1 : 3,
    state.workstreams.length,
    'the published site carries a mixture of both projects',
  );
});

test('package.json: the generator says which version of itself this is', () => {
  // Decision 46 puts the release tags in this repository, and a tag is cut from a commit whose
  // package.json is the thing anyone reads to find out what they have. It went out at 1.0.0 and
  // stayed there through a milestone that changed the manifest vocabulary and rebuilt a surface —
  // so it is asserted as a shape and as "not the version M1 shipped", which is what actually went
  // wrong.
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/, `not a version: ${manifest.version}`);
  assert.notEqual(manifest.version, '1.0.0', 'still claiming to be the version M1 shipped');

  // The major stays 1: `uses: <owner>/atlas@v1` resolves against the moving major tag, and this
  // milestone is additive for a project that already builds — a manifest saying `gated` fails, and
  // that is a vocabulary change the README documents rather than a new contract.
  assert.equal(manifest.version.split('.')[0], '1');
});

test('README: the files it says a build writes are the files a build writes', () => {
  // It said "three files" and then listed four. Counted against the output rather than read,
  // because a number in prose beside a list is exactly what drifts when the list grows.
  const readme = readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');

  const generated = ['state.json', 'tokens.css', 'order.js', 'deploy.js', 'staticwebapp.config.json'];
  const written = listFiles(OUT).filter(
    (file) => !file.endsWith('.html') && !state.assets.some((asset) => asset.path === file),
  );
  assert.deepEqual(written.sort(), [...generated].sort(), 'the build writes a different set than this test knows');

  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six'];
  const claimed = /every build writes (\w+) files of its own/.exec(readme);
  assert.ok(claimed, 'the README no longer says how many files a build writes');
  assert.equal(
    words.indexOf(claimed[1]),
    generated.length,
    `the README says "${claimed[1]}" files and the build writes ${generated.length}`,
  );
  for (const file of generated) {
    assert.ok(readme.includes(`\`${file}\``), `the README never names ${file}`);
  }
});

test('build: the site is gated by default — a project that configures nothing is not public', () => {
  // #780's top generator gap. The gate on the one live Atlas site is a file that project's own
  // workflow copies in, so any OTHER project adopting the generator published its records to the
  // world. Decision 7 says nothing on an Atlas site is anonymous, and this is what makes that
  // true for a project that does nothing at all.
  const emitted = path.join(OUT, 'staticwebapp.config.json');
  assert.ok(existsSync(emitted), 'the build published a site with no access configuration');

  const config = JSON.parse(readFileSync(emitted, 'utf8'));
  const catchAll = config.routes.find((route) => route.route === '/*');
  assert.ok(catchAll, 'nothing covers the whole site');
  assert.ok(!catchAll.allowedRoles.includes('anonymous'), 'the whole site is readable anonymously');
  assert.ok(
    !catchAll.allowedRoles.includes('authenticated'),
    'the site is open to anyone with an account, which decision 7 is not',
  );

  // It reaches the output byte-for-byte as the module writes it, so the module's own tests are
  // testing the file that ships.
  assert.equal(readFileSync(emitted, 'utf8'), serialiseSwaConfig());

  // And it is not mistaken for one of the project's own records.
  assert.ok(!state.assets.some((asset) => asset.path.endsWith('staticwebapp.config.json')));
  assert.ok(!state.documents.some((doc) => doc.path.endsWith('staticwebapp.config.json')));
});

test("build: the theme's own files are served where the layouts link to them", () => {
  // Both are copied byte-for-byte from theme/, never rendered: Eleventy's template formats are
  // `njk` and nothing else, so neither can be picked up as a page of its own.
  for (const file of ['tokens.css', 'order.js', 'deploy.js']) {
    assert.ok(existsSync(path.join(OUT, file)), `no /${file} in the output`);
    assert.equal(
      sha256(path.join(OUT, file)),
      sha256(path.join(REPO_ROOT, 'theme', file)),
      `${file} was altered on its way out`,
    );
  }
  assert.match(read('index.html'), /href="\/tokens\.css"/);
  assert.match(read('index.html'), /<script type="module" src="\/order\.js"><\/script>/);
  // M8 task 7: the Development/Staging/Release trigger buttons' own script.
  assert.match(read('index.html'), /<script type="module" src="\/deploy\.js"><\/script>/);

  // Only the surface that needs it loads it. Decision 12: no framework runtime, and no page picks
  // up behaviour it has no use for.
  assert.ok(!read('mobile/index.html').includes('order.js'), 'the phone view loads the ordering script');
  assert.ok(!read('library/index.html').includes('order.js'), 'the records index loads the ordering script');
  assert.ok(!read('mobile/index.html').includes('deploy.js'), 'the phone view loads the trigger script');
  assert.ok(!read('library/index.html').includes('deploy.js'), 'the records index loads the trigger script');
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

// --- M5: a register's document is generated, never a file anybody edits ------------------------

test('register: a register.json produces a generated document, and a hand edit to the output is lost on the next build', async () => {
  const projectRoot = fixtureCopy('register-generated');
  const registerPath = path.join(projectRoot, 'docs', 'features', 'beacon', 'register.json');
  writeFileSync(
    registerPath,
    JSON.stringify(
      {
        slug: 'beacon',
        title: 'Beacon Register',
        questions: [
          {
            id: 'Q1',
            question: 'Real question, invented for this test?',
            why: 'Real why.',
            options: ['A', 'B'],
            recommended: 'A',
            severity: 'BLOCKING',
            chosen: { kind: 'offered', value: 'A' },
            citations: [],
          },
        ],
      },
      null,
      2,
    ),
  );

  const out1 = path.join(TMP_ROOT, 'register-generated-out');
  rmSync(out1, { recursive: true, force: true });
  await build(projectRoot, out1, { fetchImpl: stubFetch, quiet: true });

  const generatedPage = path.join(out1, 'docs', 'features', 'beacon', 'register', 'index.html');
  assert.ok(existsSync(generatedPage), 'no page was generated for the register at all');
  const rendered = readFileSync(generatedPage, 'utf8');
  assert.ok(rendered.includes('Beacon Register'), "the generated page never names the register's own title");
  assert.ok(rendered.includes('Real question, invented for this test?'), 'the generated page never rendered the question itself');

  // A hand edit made directly to the OUTPUT (not the source register.json) does not survive a
  // rebuild — the document is regenerated from the record every time, never read back as its own
  // source (decision 3's "no artifact without a generator", applied to a register).
  writeFileSync(generatedPage, 'HAND EDITED, SHOULD NOT SURVIVE');
  await build(projectRoot, out1, { fetchImpl: stubFetch, quiet: true });
  const rebuilt = readFileSync(generatedPage, 'utf8');
  assert.ok(!rebuilt.includes('HAND EDITED'), 'a hand edit to the generated output survived a rebuild');
  assert.equal(rebuilt, rendered, 'the rebuilt page differs from the first build with no source change');
});

test('register: the index shows a structured register\'s open count, orders by it, and shows a legacy register as a plain link with no count', async () => {
  const projectRoot = fixtureCopy('register-index');

  // beacon: structured, 2 of 3 open.
  writeFileSync(
    path.join(projectRoot, 'docs', 'features', 'beacon', 'register.json'),
    JSON.stringify({
      slug: 'beacon', title: 'Beacon Register',
      questions: [
        { id: 'Q1', question: 'Q1?', why: 'W', options: ['A'], recommended: 'A', severity: 'BLOCKING', chosen: { kind: 'deferred', value: null }, citations: [] },
        { id: 'Q2', question: 'Q2?', why: 'W', options: ['A'], recommended: 'A', severity: 'BLOCKING', chosen: { kind: 'deferred', value: null }, citations: [] },
        { id: 'Q3', question: 'Q3?', why: 'W', options: ['A'], recommended: 'A', severity: 'minor', chosen: { kind: 'offered', value: 'A' }, citations: [] },
      ],
    }),
  );
  // tide: structured, 1 of 2 open — fewer open than beacon, so must sort after it.
  writeFileSync(
    path.join(projectRoot, 'docs', 'features', 'tide', 'register.json'),
    JSON.stringify({
      slug: 'tide', title: 'Tide Register',
      questions: [
        { id: 'Q1', question: 'Q1?', why: 'W', options: ['A'], recommended: 'A', severity: 'BLOCKING', chosen: { kind: 'deferred', value: null }, citations: [] },
        { id: 'Q2', question: 'Q2?', why: 'W', options: ['A'], recommended: 'A', severity: 'minor', chosen: { kind: 'offered', value: 'A' }, citations: [] },
      ],
    }),
  );
  // reef: legacy prose only, no register.json.
  writeFileSync(
    path.join(projectRoot, 'docs', 'features', 'reef', 'open-questions.md'),
    '# Reef Build — Open Questions Register\n\n### Q1 · BLOCKING\n\n**A legacy question?**\n\nWhy.\n\n*Recommended:* A\n\n*Answer:* A\n',
  );
  // anchor: neither — must be absent from the index entirely.

  const out = path.join(TMP_ROOT, 'register-index-out');
  rmSync(out, { recursive: true, force: true });
  await build(projectRoot, out, { fetchImpl: stubFetch, quiet: true });

  const indexHtml = readFileSync(path.join(out, 'registers', 'index.html'), 'utf8');

  const beaconIndex = indexHtml.indexOf('Beacon Register');
  const tideIndex = indexHtml.indexOf('Tide Register');
  const reefIndex = indexHtml.indexOf('Reef Build');
  assert.ok(beaconIndex !== -1, 'the structured Beacon register is missing from the index');
  assert.ok(tideIndex !== -1, 'the structured Tide register is missing from the index');
  assert.ok(reefIndex !== -1, 'the legacy Reef register is missing from the index');

  assert.ok(beaconIndex < tideIndex, 'Beacon (2 open) must sort before Tide (1 open) — more open first');
  assert.ok(tideIndex < reefIndex, 'structured registers must sort before legacy-prose ones');

  // Real counts render for structured entries.
  assert.match(indexHtml.slice(beaconIndex - 5, beaconIndex + 200), /2\s*open/i);
  assert.match(indexHtml.slice(tideIndex - 5, tideIndex + 200), /1\s*open/i);

  // The legacy entry carries no count.
  assert.doesNotMatch(indexHtml.slice(reefIndex - 5, reefIndex + 200), /\d+\s*open/i);

  // Anchor has neither register.json nor open-questions.md — absent entirely.
  assert.ok(!indexHtml.includes('Anchor'), 'a workstream with no register at all appeared in the index');
});

test('register: a workstream with no register.json builds exactly as it did before this milestone', () => {
  // Beacon carries the fixture's one register.json (Task 7's own instruction) and is asserted
  // separately above; every other shared-fixture workstream has none — this just asserts that
  // absence is silent, not an error, for each of them.
  for (const slug of FIXTURE_WORKSTREAMS.filter((s) => s !== 'beacon')) {
    const page = path.join(OUT, 'docs', 'features', slug, 'register', 'index.html');
    assert.ok(!existsSync(page), `${slug} has no register.json but a register page was generated anyway`);
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
  // The whole closed vocabulary, in order, not an alternation any one of whose branches passing
  // would satisfy it — `/done|next|.../` matched on "done" alone and could not tell a reader
  // whether the rest of the list was still being offered.
  assert.ok(
    error.message.includes(MILESTONE_STATUSES.join(', ')),
    `the failure never named what is allowed: ${error.message}`,
  );
});

test('build: a workstream with no next fails the build (decision 32)', async () => {
  const projectRoot = fixtureCopy('no-next');
  editManifest(projectRoot, 'harbor', (manifest) => {
    manifest.next = '';
  });

  const error = await build(projectRoot, path.join(TMP_ROOT, 'no-next-out'), {
    fetchImpl: forbiddenFetch,
    quiet: true,
  }).then(() => null, (err) => err);

  assert.ok(error, 'the build rendered a workstream with no next rather than failing');
  assert.match(error.message, /next/, 'the failure never named the missing field');
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

test('build: an output directory inside the project but holding nothing it reads is allowed', async () => {
  // `<project>/_site` — the conventional output location for a static site generator, and what a
  // composite action does: `atlas $GITHUB_WORKSPACE $GITHUB_WORKSPACE/_site`. It holds nothing the
  // build reads, so replacing it costs nothing.
  //
  // This is the case a guard phrased as "the output must not be inside the project" refuses, which
  // would make Atlas unusable in the one shape decision 39 says it always runs in. The guard is
  // scoped to the paths the build actually reads instead.
  const projectRoot = fixtureCopy('outdir-site');
  const site = path.join(projectRoot, '_site');

  await build(projectRoot, site, { fetchImpl: forbiddenFetch, offline: true, quiet: true });

  assert.deepEqual(listFiles(site), EXPECTED_FILES, 'the build into _site produced the wrong tree');
  // And the project it was built from is entirely intact.
  assert.ok(existsSync(path.join(projectRoot, 'atlas.config.json')));
  assert.ok(existsSync(path.join(projectRoot, 'ROADMAP.md')));
  assert.ok(existsSync(path.join(projectRoot, 'docs', 'features', 'beacon', 'workstream.json')));
  assert.ok(existsSync(path.join(projectRoot, 'docs', 'reference.html')));
});

test('build: a case-different spelling of a directory the build reads is refused', async () => {
  // On APFS and on Windows, `<project>/DOCS` IS `<project>/docs`, and a case-sensitive string
  // compare does not see it: the whole corpus is read, rendered, then deleted, exit 0, nothing to
  // warn anyone. The guard asks the filesystem instead, via `dev` + `ino`, which is the only
  // authority on whether two spellings name one directory.
  //
  // This assertion runs everywhere, because it does not need a case-insensitive filesystem to be
  // meaningful: on a case-SENSITIVE one `<project>/DOCS` is a genuinely different directory, and
  // what is asserted then is that it is allowed. Either way the rule under test is the same one —
  // refuse exactly what the filesystem says is the same file. The case-insensitive half was also
  // run by hand on a case-insensitive volume; see the task report.
  const projectRoot = fixtureCopy('case-spelling');
  const shouting = path.join(projectRoot, 'DOCS');
  const caseInsensitive = existsSync(shouting);

  const error = await build(projectRoot, shouting, { fetchImpl: forbiddenFetch, offline: true, quiet: true })
    .then(() => null, (err) => err);

  if (caseInsensitive) {
    assert.ok(error, 'a case-different spelling of the records directory was accepted');
    assert.match(error.message, /records/, 'the failure never said which read path it collided with');
  } else {
    assert.equal(error, null, 'on a case-sensitive filesystem DOCS is a different directory');
  }

  // Either way, the records are still there.
  assert.ok(existsSync(path.join(projectRoot, 'docs', 'features', 'beacon', 'workstream.json')));
  assert.ok(existsSync(path.join(projectRoot, 'docs', 'design', 'approved', 'lighthouse-decisions.md')));
  assert.ok(existsSync(path.join(projectRoot, 'docs', 'reference.html')));
});

test('build: two spellings the filesystem calls the same directory are refused, whatever they are', { skip: NO_SYMLINKS }, async () => {
  // The dev+ino rule stated without needing a case-insensitive volume: a hard-linked directory is
  // not creatable, but the *project itself* named two ways is — one path through a symlinked
  // ancestor, one direct — and that is the same comparison.
  const projectRoot = fixtureCopy('same-inode');
  const link = path.join(TMP_ROOT, 'same-inode-link');
  rmSync(link, { force: true });
  symlinkSync(projectRoot, link, 'dir');

  const error = await build(projectRoot, path.join(link, 'docs'), {
    fetchImpl: forbiddenFetch,
    offline: true,
    quiet: true,
  }).then(() => null, (err) => err);

  assert.ok(error, 'the records reached through a symlinked ancestor were accepted as an output directory');
  assert.match(error.message, /records/);
  assert.ok(existsSync(path.join(projectRoot, 'docs', 'features', 'beacon', 'workstream.json')));
});

test('build: an ancestor symlink does not hide the directory the build reads', { skip: NO_SYMLINKS }, async () => {
  // `<arena>/plink -> <project>`, then `atlas <project> <arena>/plink/docs`. Lexically those two
  // paths share nothing at all, so a string compare sees no overlap and the corpus is destroyed
  // with exit 0. The output path itself usually does not exist yet, so the guard resolves the
  // deepest ancestor that does and re-appends the rest.
  //
  // The mirror shape: a project whose `docs/` is a symlink elsewhere, with the caller naming the
  // target directly. Same fix, opposite side.
  const projectRoot = fixtureCopy('symlink-target');
  const realDocs = path.join(TMP_ROOT, 'symlink-target-docs');
  rmSync(realDocs, { recursive: true, force: true });
  cpSync(path.join(projectRoot, 'docs'), realDocs, { recursive: true });
  rmSync(path.join(projectRoot, 'docs'), { recursive: true, force: true });
  symlinkSync(realDocs, path.join(projectRoot, 'docs'), 'dir');

  const error = await build(projectRoot, realDocs, { fetchImpl: forbiddenFetch, offline: true, quiet: true })
    .then(() => null, (err) => err);

  assert.ok(error, "the target of the project's own docs symlink was accepted as an output directory");
  assert.match(error.message, /records/);
  assert.ok(existsSync(path.join(realDocs, 'features', 'beacon', 'workstream.json')), 'the corpus was destroyed');
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
  // The decision-32 half of the contract: these failures happen before anything is written
  // anywhere. The render-failure half — after the point where a wipe-then-refill would already
  // have destroyed the published site — is the test below this one.
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

test('build: a failure DURING RENDERING leaves the published site exactly as it was', async () => {
  // The half of the swap contract the previous round could not automate. My reasoning then had a
  // false step: I assumed the throwing template had to go in the *shared* `theme/`, which would
  // race the other files `node --test` runs in parallel. It does not. `GENERATOR_ROOT` derives
  // from `import.meta.url`, so a private copy of the generator brings its own theme — plant the
  // throw there and spawn that copy. Nothing shared is mutated, so nothing can race.
  //
  // (Adapted from the test the reviewer wrote to demonstrate the point.)
  const out = freshDir('render-failure');

  // Publish a good site with the real generator.
  await build(FIXTURE_ROOT, out, { fetchImpl: stubFetch, quiet: true });
  const published = hashTree(out);
  assert.ok(Object.keys(published).length > 0, 'nothing was published to begin with');

  // A private copy of the generator whose document layout throws part-way through rendering.
  const broken = path.join(TMP_ROOT, 'broken-generator');
  rmSync(broken, { recursive: true, force: true });
  mkdirSync(broken, { recursive: true });
  // `api` comes along with `src`: `src/schema.mjs` re-exports the closed vocabularies and the
  // workstream-slug rule from `api/lib/contract.mjs`, which is where the managed Function that
  // writes back can also reach them (Static Web Apps packages an api directory on its own). A
  // copy of the generator without it does not import at all.
  for (const entry of ['src', 'api', 'theme', '.eleventy.js', 'package.json']) {
    cpSync(path.join(REPO_ROOT, entry), path.join(broken, entry), { recursive: true });
  }
  // No `node_modules` is copied or linked. The copy lives under the repository, so Node resolves
  // `@11ty/eleventy` by walking up to the real one; `package.json` comes along only for its
  // `"type": "module"`, which `.eleventy.js` needs. (A symlink here fails EPERM on Windows, and
  // this test should not be the one place the suite stops being portable.)

  // A filter that does not exist. Nunjucks renders undefined property access as empty rather than
  // throwing — `{{ nope.boom }}` will not fail a build, which cost me an iteration — but an
  // unknown filter throws. It throws at render time, which is after the assets and the stylesheet
  // have already been written: precisely the window the staging swap exists to cover.
  const layout = path.join(broken, 'theme', '_includes', 'document.njk');
  writeFileSync(layout, readFileSync(layout, 'utf8').replace('{{ record | safe }}', '{{ record | no_such_filter }}'));

  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(
    process.execPath,
    [path.join(broken, 'src', 'build.mjs'), FIXTURE_ROOT, out, '--offline', '--quiet'],
    { encoding: 'utf8', cwd: TMP_ROOT },
  );

  assert.notEqual(result.status, 0, 'the broken generator reported success');
  assert.match(result.stderr, /build failed/, 'the failure was not reported');

  // The contract in build()'s JSDoc: outDir is untouched when it throws.
  assert.deepEqual(hashTree(out), published, 'a render failure damaged the site that was already published');
  assert.ok(!existsSync(`${out}.atlas-staging`), 'the staging directory was left behind');
});

// --- the records are reachable ---------------------------------------------------------------------

// Both kinds of record a reader can open: the Markdown Atlas renders, and the standalone documents
// decision 10 has it copy byte-for-byte. A reader cannot tell the difference from the outside, and
// cannot reach either one if it is not listed.
//
// The copied files that are NOT documents — `support.js` and its like — are deliberately excluded:
// they are loaded by a document, not opened by a person, and the test below asserts that
// separately and differently.
const everyRecord = () => [
  ...state.documents.map((doc) => ({ path: doc.path, url: doc.url, kind: 'rendered' })),
  ...state.assets
    .filter((asset) => asset.isDocument)
    .map((asset) => ({ path: asset.path, url: asset.url, kind: 'copied' })),
];

test('build: no surface calls it Records — the library is the Library, everywhere', () => {
  // #780: "rename Records to Library." Everywhere it appears — page title, nav label, route
  // wording — because a surface with two names is two surfaces to whoever reads about it later.
  //
  // The word is checked against the RENDERED pages rather than the sources, which is the only place
  // a reader meets it, and against every page the build wrote rather than a list somebody kept.
  // Every page the build wrote, walked rather than listed: a list somebody keeps is a list that
  // stops covering the page added after it.
  const pages = listFiles(OUT).filter((rel) => rel.endsWith('index.html'));
  assert.ok(pages.length > 20, `expected the whole site, saw ${pages.length} pages`);

  for (const page of pages) {
    const html = read(page);
    // The word inside a record's own prose is the record's, not Atlas's — the fixture's own
    // documents talk about records constantly and rightly. What must not survive is Atlas's own
    // chrome: the nav, a breadcrumb, a heading, a title.
    const chrome = [
      ...html.matchAll(/<title>([^<]*)<\/title>/g),
      ...html.matchAll(/<nav class="site-nav"[^>]*>([\s\S]*?)<\/nav>/g),
      ...html.matchAll(/<p class="breadcrumb">([\s\S]*?)<\/p>/g),
    ].map((m) => m[1]).join(' | ');
    assert.ok(!/\bRecords\b/.test(chrome), `${page}: a surface still calls it Records — ${chrome}`);
    assert.ok(!/href="\/records\//.test(chrome), `${page}: a surface still links to the old route`);
  }

  // And it IS called Library, so the assertions above are not passing because the nav vanished.
  const nav = /<nav class="site-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(read('index.html'))[1];
  assert.match(nav, /Library/, 'the nav lost the surface entirely rather than renaming it');
  assert.match(nav, /href="\/library\/"/, 'the nav does not point at the new route');
});

test('build: the records index lists every record of both kinds, and every surface links to it', () => {
  const index = read('library/index.html');

  for (const record of everyRecord()) {
    assert.ok(
      index.includes(`href="${record.url}"`),
      `the records index never links the ${record.kind} record ${record.path}`,
    );
  }

  // Exactly the records, not a superset: an entry pointing at something the build did not write
  // is the same failure in the other direction.
  const linked = [...index.matchAll(/<li[^>]*><a href="([^"]+)">/g)].map((m) => m[1]).sort();
  assert.deepEqual(linked, everyRecord().map((r) => r.url).sort());

  // The two kinds are distinguished, because following one lands on a page Atlas made and
  // following the other lands on the document its author made.
  assert.match(index, /data-kind="rendered"/);
  assert.match(index, /data-kind="copied"/);

  // And the supporting files are NOT here. Stated against the file, by name, rather than derived
  // from `isDocument` — every other assertion in this test takes its expectation from that same
  // flag, so with the flag wrong they all move together and none of them notices. This one does
  // not move.
  assert.ok(
    !index.includes('href="/docs/support.js"'),
    'the records index offers a reader a link to a script a document loads',
  );
  for (const supporting of state.assets.filter((asset) => !asset.isDocument)) {
    assert.ok(
      !index.includes(`href="${supporting.url}"`),
      `the records index links ${supporting.path}, which is not a document a reader opens`,
    );
  }

  // And it is reachable, not merely findable by URL.
  for (const page of ['index.html', 'mobile/index.html', 'workstream/beacon/index.html', 'ROADMAP/index.html']) {
    assert.match(read(page), /href="\/library\/"/, `${page} has no way through to the records`);
  }
});

test('build: no record is an orphan — neither the rendered ones nor the copied ones', () => {
  // Decision 1 makes the site the way to read the project. A record published at a URL nothing
  // links to fails that invisibly: the page exists, so nothing looks broken.
  //
  // The copied standalone documents are the half this test originally missed, because it iterated
  // `state.documents` alone. `docs/reference.html` was reachable from nowhere; `docs/field
  // notes.html` only by luck, because a cross-reference inside a Markdown record happened to
  // point at it. In the real corpus that is thirty-two documents.
  const everyPage = listFiles(OUT)
    .filter((file) => file.endsWith('.html'))
    .map((file) => read(file))
    .join('\n');

  for (const record of everyRecord()) {
    assert.ok(
      everyPage.includes(`href="${record.url}"`),
      `${record.path} is published (${record.kind}) but nothing on the site links to it`,
    );
  }
});

test('build: a copied document keeps the supporting files it loads, at the paths it loads them from', () => {
  // The other half of decision 10, and the reason the sibling files are copied at all: ten of the
  // real corpus's thirty-two standalone documents load a `support.js`. These are not listed in the
  // records index — a reader opens the document, not its script — so what has to be true of them
  // is that the document's own reference still resolves.
  const supporting = state.assets.filter((asset) => !asset.isDocument);
  assert.ok(supporting.length > 0, 'the fixture no longer exercises a document with a sibling file');

  for (const file of supporting) {
    assert.ok(existsSync(path.join(OUT, file.path)), `${file.path} was not copied`);

    // Referenced by at least one copied document, from the same directory, exactly as written.
    const referrers = state.assets
      .filter((asset) => asset.isDocument)
      .map((asset) => readFileSync(path.join(OUT, asset.path), 'utf8'));
    const name = path.posix.basename(file.path);
    assert.ok(
      referrers.some((html) => html.includes(name)),
      `${file.path} is copied but no standalone document loads it`,
    );
  }

  // And the document that loads it was not rewritten to point somewhere else (decision 10).
  assert.match(read('docs/reference.html'), /src="\.\/support\.js"/);
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

test('build: a milestone with a real issue number still builds offline with an empty task list', async () => {
  // --offline never calls fetchIssueBodies (same convention as the existing issues fetch), so a
  // milestone whose issue is set still builds — just with no tasks, not a build failure. The
  // fixture's own milestones (e.g. reef/M1, issue 701) already carry real issue numbers, so this
  // is exercised by the ordinary fixture, not a hand-built one.
  const out = freshDir('offline-with-issue');
  await build(FIXTURE_ROOT, out, { fetchImpl: forbiddenFetch, offline: true, quiet: true });
  assert.ok(existsSync(path.join(out, 'index.html')), 'offline build with a real issue number must still succeed');
});

test('build: fetchIssueBodies -> parseTasks -> milestone.manifest.tasks -> a rendered checklist, end to end', async () => {
  // The one genuinely new test this fix wave needed (final branch review, 5b): every other build
  // in this file is either `--offline` (which skips `fetchIssueBodies` entirely, `taskBodies` is
  // just `new Map()`) or uses the URL-blind `stubFetch` above, which answers every request —
  // including the single-issue endpoint — with the same issues-LIST payload, so `item.body` is
  // never a string and every milestone's tasks are always `[]`. Nothing before this proved the
  // real wiring works. The fixture's own beacon/M4 is already the 'next' milestone with a real
  // issue number (104); this just answers that issue's URL for real.
  const out = freshDir('task-pipeline-e2e');
  const bodies = new Map([
    [
      104,
      ['## Sub-tasks', '', '- [ ] Wire up the relay - Ada', '- [x] Ship the housing — Grace'].join('\n'),
    ],
  ]);
  await build(FIXTURE_ROOT, out, { fetchImpl: stubFetchWithIssueBodies(bodies), quiet: true });

  const html = readFileSync(path.join(out, 'index.html'), 'utf8');
  const nodeMatch = new RegExp('data-milestone-node="beacon-M4"[\\s\\S]*?data-task-list[\\s\\S]*?</ul>').exec(html);
  assert.ok(nodeMatch, 'beacon/M4 did not render a task list parsed from its real issue body');
  assert.ok(nodeMatch[0].includes('Wire up the relay'), 'the first parsed task text is missing from the page');
  assert.ok(nodeMatch[0].includes('Ada'), 'the first parsed owner tag is missing from the page');
  assert.ok(nodeMatch[0].includes('Ship the housing'), 'the second parsed task text is missing from the page');
  assert.ok(nodeMatch[0].includes('Grace'), 'the second parsed owner tag is missing from the page');
  assert.match(nodeMatch[0], /class="task-line is-done"/, 'the checked task did not render as done');
});

test('build: real GitHub assignees on a milestone\'s own issue render on the page, end to end', async () => {
  const out = freshDir('assignees-e2e');
  const bodies = new Map([[104, '- [ ] Wire up the relay']]);
  const assignees = new Map([
    [104, [{ login: 'jeremy', avatar_url: 'https://example.test/j.png', html_url: 'https://github.com/jeremy' }]],
  ]);
  await build(FIXTURE_ROOT, out, { fetchImpl: stubFetchWithIssueBodies(bodies, assignees), quiet: true });

  const html = readFileSync(path.join(out, 'index.html'), 'utf8');
  const nodeMatch = new RegExp('data-milestone-node="beacon-M4"[\\s\\S]*?</li>').exec(html);
  assert.ok(nodeMatch, 'beacon/M4 did not render');
  assert.match(nodeMatch[0], /class="milestone-assignees/, 'no assignees list rendered');
  assert.match(nodeMatch[0], /href="https:\/\/github\.com\/jeremy"/, 'the real assignee profile link is missing');
  assert.ok(nodeMatch[0].includes('jeremy'), 'the assignee login is missing from the page');
});

test('build: a milestone with no real assignees renders no assignees list at all', () => {
  const html = readFileSync(path.join(OUT, 'index.html'), 'utf8');
  assert.ok(
    !html.includes('class="milestone-assignees'),
    'a build with no real GitHub assignees should render no assignees list anywhere',
  );
});

// --- the promotion path (#780, task 12) ---------------------------------------------------------

test('build: a feature written but never put on the sheet is reported, and does not fail the build', () => {
  // The half of decision 32 that was missing. A config naming a directory that does not exist is a
  // broken reference and fails the build; a feature that EXISTS and is not named was silent — the
  // work is written, the page does not show it, and nothing says so. Same failure shape as a
  // hidden feature nobody can find.
  //
  // A WARNING and not a failure, deliberately: promotion is two steps in that order — write the
  // manifest, then name the slug — so this is the ordinary intermediate state of doing it right.
  // Failing here would mean the act of starting a promotion breaks the site.
  const root = fixtureCopy('promotion-warning');
  cpSync(
    path.join(root, 'docs', 'features', 'shoal'),
    path.join(root, 'docs', 'features', 'quasar'),
    { recursive: true },
  );

  return build(root, freshDir('promotion-warning-out'), { fetchImpl: stubFetch, quiet: true }).then(
    (summary) => {
      assert.deepEqual(summary.unnamedFeatures, ['quasar'], 'the half-promoted feature was not reported');
      assert.ok(summary.pages > 0, 'the build should still have produced a site');
    },
  );
});

test('build: the fixture builds with nothing to warn about, so the warning stays worth reading', () => {
  // A build that always warns is a warning nobody reads. This is the control for the test above.
  assert.deepEqual(SUMMARY.unnamedFeatures, []);
});

// --- M8 task 7 fix round: the deployment log's SHA, computed at build time ----------------------
//
// `theme/deploy.js` used to fetch the deployment log's current SHA from GitHub's public,
// unauthenticated contents API at click time — which 404s on every real Atlas project, since those
// live in private repositories gated behind an invited role (decision 7). `currentSha` always
// resolved to `null` in practice; the round-trip bought nothing but latency. The real fix: the
// build already reads the deployment log's bytes off disk (`readDeploymentLog`, M8 task 6) to
// compute `displayedStage`/`deploymentHistory` — the exact same read can compute the file's git
// blob SHA at the same time, with no network call at all. `gitBlobSha` is the well-defined,
// short algorithm `git hash-object` uses: `sha1("blob " + byteLength + "\0" + content)`.
test('gitBlobSha: matches a known SHA-1 blob hash for a short, fixed string', () => {
  // "hello world\n" (12 bytes) is a git-hash-object value quoted in Git's own documentation and
  // reproducible anywhere: `printf 'hello world\n' | git hash-object --stdin`.
  assert.equal(gitBlobSha('hello world\n'), '3b18e512dba79e4c8300dd08aeb37f8e728b8dad');
});

test('gitBlobSha: matches `git hash-object` on a real file in this repository, not just a hard-coded constant', async () => {
  const { spawnSync } = await import('node:child_process');

  const content = JSON.stringify(
    [
      { stage: 'development', note: 'first deploy to dev' },
      { stage: 'staging', note: null },
    ],
    null,
    2,
  ) + '\n';
  const file = path.join(TMP_ROOT, 'blob-sha-ground-truth.json');
  mkdirSync(TMP_ROOT, { recursive: true });
  writeFileSync(file, content);

  const result = spawnSync('git', ['hash-object', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git hash-object failed: ${result.stderr}`);
  const expected = result.stdout.trim();

  assert.equal(gitBlobSha(content), expected, "gitBlobSha must agree with git's own hash-object");
});

test('gitBlobSha: byte length, not JS string length, is what goes in the header (multi-byte content)', async () => {
  // A content string with multi-byte UTF-8 characters has a different byte length than its JS
  // `.length` (UTF-16 code units) — proving the header uses `Buffer.byteLength`, not `.length`.
  const { spawnSync } = await import('node:child_process');

  const content = '{"note":"promoted to staging — done ✅"}\n';
  const file = path.join(TMP_ROOT, 'blob-sha-multibyte.json');
  mkdirSync(TMP_ROOT, { recursive: true });
  writeFileSync(file, content);

  const result = spawnSync('git', ['hash-object', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git hash-object failed: ${result.stderr}`);
  const expected = result.stdout.trim();

  assert.equal(gitBlobSha(content), expected);
});

// --- M8 task 6: the displayed stage, and the deployment history it came from --------------------
//
// "Chip says Shipping, feature is really in dev": `manifest.stage` is the manifest's own,
// possibly-stale word for where a workstream stands. `assembleSite` now computes a *displayed*
// stage — the log's latest entry when the workstream has one — the same way it already computes
// `triage` from `classifyTriage` rather than reading it off the manifest. `assembleSite` is
// exported (build.mjs) solely so these tests can inspect the computed field directly, rather than
// only through rendered HTML or state.json (`state.json` DOES carry it, as of this task's own fix
// rounds: `workstreams[].stage` and `ladder.columns[].stage` both project `displayedStage`, not
// the raw manifest value — inspecting `assembleSite`'s own output directly is still the more
// direct way to test the computation itself, one step removed from the projection).
//
// Every test below pins the four workstreams beacon/tide/anchor/reef to a known 'development'
// stage before building, rather than relying on whatever the shared `fixture/` happens to hold —
// `resolveWorkstreams` validates the whole project, so a workstream this test does not care about
// still has to hold a value from the closed vocabulary, and a test that assumed the fixture's own
// values would silently break if a later edit to `fixture/` ever changed them.
function fixtureCopyWithValidStages(name) {
  const root = fixtureCopy(name);
  for (const slug of ['beacon', 'tide', 'anchor', 'reef']) {
    editManifest(root, slug, (manifest) => {
      manifest.stage = 'development';
    });
  }
  return root;
}

test('build: displayedStage is the log\'s latest entry when a deployment log exists, overriding a stale manifest.stage; deploymentHistory carries the full parsed log', async () => {
  const projectRoot = fixtureCopyWithValidStages('deployment-log-override');

  // beacon's manifest says 'development'; its log's latest entry says 'staging'. The chip must
  // trust the log once one exists — that is the entire point of this task.
  const logPath = 'docs/features/beacon/deployment-log.json';
  const history = [
    { stage: 'development', note: 'first deploy to dev' },
    { stage: 'staging', note: 'promoted to staging' },
  ];
  const logContent = `${JSON.stringify(history, null, 2)}\n`;
  writeFileSync(path.join(projectRoot, logPath), logContent);
  editManifest(projectRoot, 'beacon', (manifest) => {
    manifest.deploymentLog = logPath;
  });

  const site = await assembleSite(projectRoot, { fetchImpl: forbiddenFetch, offline: true });
  const bySlug = new Map(site.workstreams.map((stream) => [stream.slug, stream]));

  const beacon = bySlug.get('beacon');
  assert.equal(beacon.manifest.stage, 'development', 'the manifest\'s own stage should be untouched');
  assert.equal(beacon.displayedStage, 'staging', "the log's latest entry should override the manifest's stage");
  assert.deepEqual(beacon.deploymentHistory, history, 'the full parsed history should be exposed, not just the latest entry');
  // The build-time SHA (M8 task 7 fix round): computed from the exact bytes on disk, so it must
  // agree with `git hash-object` on that same file — not just with `gitBlobSha` calling itself.
  assert.equal(
    beacon.deploymentLogSha,
    gitBlobSha(logContent),
    "deploymentLogSha must be the log file's own git blob SHA",
  );
  assert.match(beacon.deploymentLogSha, /^[0-9a-f]{40}$/, 'deploymentLogSha must be a 40-character hex blob SHA');

  // harbor names no deploymentLog at all: displayedStage is simply the manifest's own stage,
  // deploymentHistory is empty, and there is no file to hash, so deploymentLogSha is null.
  const harbor = bySlug.get('harbor');
  assert.equal(harbor.manifest.deploymentLog, undefined, 'fixture drifted: harbor now names a deploymentLog');
  assert.equal(harbor.displayedStage, harbor.manifest.stage);
  assert.deepEqual(harbor.deploymentHistory, []);
  assert.equal(harbor.deploymentLogSha, null);
});

test('build: a deploymentLog naming a file that does not exist yet falls back silently — a workstream that has never logged anything is normal, not broken', async () => {
  const projectRoot = fixtureCopyWithValidStages('deployment-log-missing');

  editManifest(projectRoot, 'shoal', (manifest) => {
    manifest.deploymentLog = 'docs/features/shoal/deployment-log.json'; // never written
  });

  const site = await assembleSite(projectRoot, { fetchImpl: forbiddenFetch, offline: true });
  const shoal = site.workstreams.find((stream) => stream.slug === 'shoal');

  assert.equal(shoal.displayedStage, 'not-started', 'a missing log should fall back to the manifest\'s own stage');
  assert.deepEqual(shoal.deploymentHistory, []);
  assert.equal(shoal.deploymentLogSha, null, 'no file on disk means nothing to hash');
});

test('build: a deploymentLog that exists but is not valid JSON fails the build loudly, naming the path (decision 32)', async () => {
  const projectRoot = fixtureCopyWithValidStages('deployment-log-malformed');

  const logPath = 'docs/features/shoal/deployment-log.json';
  writeFileSync(path.join(projectRoot, logPath), 'not json at all');
  editManifest(projectRoot, 'shoal', (manifest) => {
    manifest.deploymentLog = logPath;
  });

  const error = await assembleSite(projectRoot, { fetchImpl: forbiddenFetch, offline: true }).then(
    () => null,
    (err) => err,
  );

  assert.ok(error, 'a malformed deployment log should fail the build, not silently fall back');
  assert.match(error.message, /deployment-log\.json/, 'the failure never named the broken file');
});

// --- final whole-branch review fix: closed-vocabulary validation on a log entry's "stage" -------
//
// `readDeploymentLog` above trusted `latest.stage` — the JSON-array shape was checked, but not
// what each entry's own "stage" actually held. A hand-edited or corrupted log could put any
// string there, which then reached `state.json` (`workstreams[].stage`, `ladder.columns[].stage`)
// and the rendered chip's CSS class/`data-stage` attribute unvalidated, bypassing decision 32's
// closed vocabulary — the one rule every OTHER broken reference in this generator is held to.
test('build: a deployment log entry with a stage outside DEPLOYMENT_STAGES fails the build loudly, naming the workstream, the log path, and the bad value (decision 32)', async () => {
  const projectRoot = fixtureCopyWithValidStages('deployment-log-invalid-stage');

  const logPath = 'docs/features/beacon/deployment-log.json';
  const history = [
    { stage: 'development', note: 'first deploy to dev' },
    { stage: 'shipping', note: 'a hand-edit using the retired vocabulary' },
  ];
  writeFileSync(path.join(projectRoot, logPath), `${JSON.stringify(history, null, 2)}\n`);
  editManifest(projectRoot, 'beacon', (manifest) => {
    manifest.deploymentLog = logPath;
  });

  const error = await assembleSite(projectRoot, { fetchImpl: forbiddenFetch, offline: true }).then(
    () => null,
    (err) => err,
  );

  assert.ok(error, 'a deployment log entry with an invalid stage should fail the build, not render it');
  assert.match(error.message, /[Bb]eacon/, 'the failure never named the workstream');
  assert.match(error.message, /deployment-log\.json/, 'the failure never named the log file');
  assert.match(error.message, /shipping/, 'the failure never named the bad stage value');
});

// A malformed final entry (e.g. `{}`, from a truncated write) has no "stage" at all — this must
// fail the same way as any other invalid stage, not silently produce a blank chip via
// `latest ? latest.stage : displayedStage` reading `undefined`.
test('build: a deployment log whose final entry has no "stage" fails the build loudly, the same as any other invalid stage (decision 32)', async () => {
  const projectRoot = fixtureCopyWithValidStages('deployment-log-blank-entry');

  const logPath = 'docs/features/beacon/deployment-log.json';
  const history = [{ stage: 'development', note: 'first deploy to dev' }, {}];
  writeFileSync(path.join(projectRoot, logPath), `${JSON.stringify(history, null, 2)}\n`);
  editManifest(projectRoot, 'beacon', (manifest) => {
    manifest.deploymentLog = logPath;
  });

  const error = await assembleSite(projectRoot, { fetchImpl: forbiddenFetch, offline: true }).then(
    () => null,
    (err) => err,
  );

  assert.ok(error, 'a deployment log entry missing "stage" should fail the build, not produce a blank chip');
  assert.match(error.message, /[Bb]eacon/, 'the failure never named the workstream');
  assert.match(error.message, /deployment-log\.json/, 'the failure never named the log file');
});

// --- final whole-branch review fix: a non-empty log is evidence a pre-development manifest.stage
// is stale --------------------------------------------------------------------------------------
//
// `computeLadder`/`preMilestoneCoveredCount` (src/depth.mjs) and `classifyTriage` (src/triage.mjs)
// both still read the raw `manifest.stage`, not `displayedStage` — threading the override through
// both is a bigger structural change than this fix wave should attempt. The cheap, correct fix:
// a deployment log with real entries IS proof the workstream has left the pre-development stages
// (`not-started`/`designing`), so a manifest that still claims one of those is now a stale record,
// and decision 32 says a broken reference fails the build by name rather than rendering two
// surfaces that disagree (the #780 failure class).
test('build: a non-empty deployment log against a manifest still in a pre-development stage fails the build, naming the workstream, its stale manifest stage, and the log (decision 32)', async () => {
  const projectRoot = fixtureCopyWithValidStages('deployment-log-pre-development');

  // shoal's manifest stage is 'not-started' in the fixture (untouched by fixtureCopyWithValidStages,
  // which only fixes beacon/tide/anchor/reef) — exactly the stale-record shape this guards against.
  const logPath = 'docs/features/shoal/deployment-log.json';
  const history = [{ stage: 'development', note: 'first deploy to dev' }];
  writeFileSync(path.join(projectRoot, logPath), `${JSON.stringify(history, null, 2)}\n`);
  editManifest(projectRoot, 'shoal', (manifest) => {
    manifest.deploymentLog = logPath;
  });

  const error = await assembleSite(projectRoot, { fetchImpl: forbiddenFetch, offline: true }).then(
    () => null,
    (err) => err,
  );

  assert.ok(
    error,
    'a deployment log with entries against a pre-development manifest.stage should fail the build',
  );
  assert.match(error.message, /[Ss]hoal/, 'the failure never named the workstream');
  assert.match(error.message, /not-started/, 'the failure never named the stale manifest stage');
});

// The other pre-development value: 'designing' must be caught the same way as 'not-started'.
test('build: a non-empty deployment log against a "designing" manifest stage fails the build the same way as "not-started"', async () => {
  const projectRoot = fixtureCopyWithValidStages('deployment-log-pre-development-designing');

  // harbor's manifest stage is 'designing' in the fixture.
  const logPath = 'docs/features/harbor/deployment-log.json';
  const history = [{ stage: 'development', note: 'first deploy to dev' }];
  writeFileSync(path.join(projectRoot, logPath), `${JSON.stringify(history, null, 2)}\n`);
  editManifest(projectRoot, 'harbor', (manifest) => {
    manifest.deploymentLog = logPath;
  });

  const error = await assembleSite(projectRoot, { fetchImpl: forbiddenFetch, offline: true }).then(
    () => null,
    (err) => err,
  );

  assert.ok(error, 'a deployment log with entries against a "designing" manifest.stage should fail the build');
  assert.match(error.message, /[Hh]arbor/, 'the failure never named the workstream');
  assert.match(error.message, /designing/, 'the failure never named the stale manifest stage');
});

// --- proposedDesigns' url (M9 follow-up: the Upcoming Features section links to content) -----------

test('build: a proposed design with a Markdown file gets an Upcoming Features url pointing at its rendered page', async () => {
  const projectRoot = fixtureCopy('proposed-design-markdown');
  const dir = path.join(projectRoot, 'docs', 'design', 'proposed', 'new-idea');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'spec.md'), '# New Idea\n\nA sketch, not yet a feature.\n');

  const site = await assembleSite(projectRoot, { fetchImpl: forbiddenFetch, offline: true });

  assert.deepEqual(
    site.proposedDesigns.find((entry) => entry.slug === 'new-idea'),
    { slug: 'new-idea', url: '/docs/design/proposed/new-idea/spec/' },
    'a slug with a rendered Markdown record should link straight to it',
  );
});

test('build: a proposed design with only a copied HTML document still gets an Upcoming Features url', async () => {
  const projectRoot = fixtureCopy('proposed-design-html-only');
  const dir = path.join(projectRoot, 'docs', 'design', 'proposed', 'wireframes-only');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'screens.html'), '<html><body>wireframes</body></html>');

  const site = await assembleSite(projectRoot, { fetchImpl: forbiddenFetch, offline: true });

  assert.deepEqual(
    site.proposedDesigns.find((entry) => entry.slug === 'wireframes-only'),
    { slug: 'wireframes-only', url: '/docs/design/proposed/wireframes-only/screens.html' },
    'a slug with no rendered Markdown should fall back to its copied HTML document',
  );
});

// --- a workstream's design references, linked when resolvable (decision 21, narrowed by the
// design/tracking merge) ------------------------------------------------------------------------

test('build: a design reference naming an exact document path gets a url', async () => {
  const projectRoot = fixtureCopy('design-reference-exact-file');
  editManifest(projectRoot, 'beacon', (manifest) => {
    manifest.design = [{ name: 'Beacon M1 demo script', where: 'docs/features/beacon/m1-demo.md' }];
  });

  const site = await assembleSite(projectRoot, { fetchImpl: forbiddenFetch, offline: true });
  const beacon = site.workstreams.find((w) => w.slug === 'beacon');

  assert.deepEqual(
    beacon.design,
    [{ name: 'Beacon M1 demo script', where: 'docs/features/beacon/m1-demo.md', url: '/docs/features/beacon/m1-demo/' }],
    'a design reference naming a file this build rendered should link to it',
  );
});

test('build: a design reference naming a directory gets a url from the first document it holds', async () => {
  const projectRoot = fixtureCopy('design-reference-directory');
  editManifest(projectRoot, 'beacon', (manifest) => {
    manifest.design = [{ name: 'Beacon design bundle', where: 'docs/features/beacon/' }];
  });

  const site = await assembleSite(projectRoot, { fetchImpl: forbiddenFetch, offline: true });
  const beacon = site.workstreams.find((w) => w.slug === 'beacon');

  assert.equal(beacon.design.length, 1);
  assert.equal(beacon.design[0].where, 'docs/features/beacon/');
  assert.ok(beacon.design[0].url, 'a directory reference holding rendered documents should still resolve to one of them');
});

test('build: a design reference naming an external design tool, not a repository path, stays unresolved', async () => {
  const projectRoot = fixtureCopy('design-reference-external');

  const site = await assembleSite(projectRoot, { fetchImpl: forbiddenFetch, offline: true });
  const beacon = site.workstreams.find((w) => w.slug === 'beacon');

  // Unmodified fixture data: beacon's own design already says "design-project" (decision 21's
  // original case — an external tool, never a repository path).
  assert.deepEqual(
    beacon.design,
    [{ name: 'lighthouse/Beacon Overview v1', where: 'design-project', url: null }],
    'a where that names no repository path should resolve to no url, not throw or guess one',
  );
});
