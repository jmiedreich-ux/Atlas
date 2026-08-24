import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync, mkdirSync, cpSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from '../src/build.mjs';
import { STATE_VERSION } from '../src/state.mjs';
import { loadConfig, resolveWorkstreams } from '../src/config.mjs';

// Decision 29: "the build emits state.json beside the pages. The same data, machine-readable."
//
// "The same data" is the whole point and the whole risk. Everything below compares state.json
// against the HTML the build emitted in the same run — never against a second derivation from the
// manifests, which would prove only that two copies of the same bug agree.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'fixture');
const OUT = path.join(REPO_ROOT, '.tmp-tests', 'state-build');

const ISSUES = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'issues.json'), 'utf8'));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

await build(FIXTURE_ROOT, OUT, {
  quiet: true,
  fetchImpl: () =>
    Promise.resolve({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(ISSUES)) }),
});

const read = (rel) => readFileSync(path.join(OUT, rel), 'utf8');
const state = JSON.parse(read('state.json'));

// A copy of the fixture that one test may break on purpose, mirroring tests/build.test.mjs's own
// `fixtureCopy`/`editManifest` helpers — state.test.mjs otherwise builds once, at module scope,
// against the shared fixture, but the override test below needs a `deploymentLog` no shared
// fixture workstream carries.
const TMP_ROOT = path.join(REPO_ROOT, '.tmp-tests');

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

const config = loadConfig(FIXTURE_ROOT);
const workstreams = resolveWorkstreams(config);

// --- text helpers --------------------------------------------------------------------------------

function attrValues(html, attribute) {
  return [...html.matchAll(new RegExp(`${attribute}="([^"]*)"`, 'g'))].map((m) => m[1]);
}

// --- the file itself ------------------------------------------------------------------------------

test('state: it is emitted beside the pages, as parseable JSON (decision 29)', () => {
  assert.ok(existsSync(path.join(OUT, 'state.json')), 'no state.json in the output');
  assert.equal(typeof state, 'object');
  assert.equal(state.project, config.project);
  assert.equal(state.repo, config.repo);
});

test('state: it says which version of its own shape it is, first (decision 29)', () => {
  // Decision 29 makes this a contract other tools consume. A consumer that cannot tell which
  // shape it is holding cannot be told the shape changed, and by the time one exists it is too
  // late to add cheaply.
  // NOT `state.version === STATE_VERSION`, which was the assertion here and cannot fail: both
  // sides come from the same import, so it holds for any value including undefined. The version
  // is asserted as the literal a consumer would code against, and STATE_VERSION is checked to be
  // that same literal separately — so bumping one without the other is what goes red.
  assert.equal(state.version, 1, 'state.json no longer says it is version 1');
  assert.equal(STATE_VERSION, 1, 'the exported constant and the emitted version have drifted apart');
  assert.equal(typeof state.version, 'number');
  assert.equal(Object.keys(state)[0], 'version', 'the version is not the first thing a reader meets');
});

// --- the same workstreams the pages were rendered from --------------------------------------------

test('state: the workstreams are the ones the feature planning page drew, in the same order', () => {
  const drawn = [...new Set(attrValues(read('index.html'), 'data-slug'))];
  assert.deepEqual(state.workstreams.map((w) => w.slug), drawn);
  assert.deepEqual(state.workstreams.map((w) => w.slug), config.workstreams);
});

test('state: every workstream carries the position fields the manifest is the authority for', () => {
  for (const stream of workstreams) {
    const entry = state.workstreams.find((w) => w.slug === stream.slug);
    assert.ok(entry, `state.json has no entry for ${stream.slug}`);

    for (const field of ['codename', 'what', 'stage', 'position', 'next', 'label']) {
      assert.equal(entry[field], stream.manifest[field], `${stream.slug}.${field} disagrees with the manifest`);
    }
    assert.deepEqual(entry.design, stream.manifest.design);

    // And every one of those values reached the page too.
    const page = read(`workstream/${stream.slug}/index.html`);
    assert.ok(page.includes(entry.codename), `${stream.slug}: the page and state disagree about the codename`);
    assert.ok(page.includes(entry.next), `${stream.slug}: the page and state disagree about next`);
    assert.ok(page.includes(entry.position), `${stream.slug}: the page and state disagree about the position`);
  }
});

test('state: a workstream\'s stage is the displayed stage, not the manifest\'s raw one, once a deployment log overrides it (Task 6 fix)', async () => {
  // The rendered chip (theme/_includes/workstream.njk, depth.njk) and state.json's `stage` key
  // must never disagree about a workstream's stage — the same failure class src/depth.mjs's own
  // comments describe for `tipLabel`. `assembleSite` computes `displayedStage` from a
  // `deploymentLog`'s latest entry when one exists; this proves `buildState` projects that
  // computed field, not `manifest.stage` directly.
  const projectRoot = fixtureCopy('state-deployment-log-override');

  const logPath = 'docs/features/beacon/deployment-log.json';
  const history = [
    { stage: 'development', note: 'first deploy to dev' },
    { stage: 'staging', note: 'promoted to staging' },
  ];
  writeFileSync(path.join(projectRoot, logPath), `${JSON.stringify(history, null, 2)}\n`);
  editManifest(projectRoot, 'beacon', (manifest) => {
    manifest.stage = 'development';
    manifest.deploymentLog = logPath;
  });

  const out = path.join(TMP_ROOT, 'state-deployment-log-override-out');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  await build(projectRoot, out, { offline: true, quiet: true });

  const overriddenState = JSON.parse(readFileSync(path.join(out, 'state.json'), 'utf8'));
  const beacon = overriddenState.workstreams.find((w) => w.slug === 'beacon');

  assert.ok(beacon, 'state.json has no entry for beacon');
  assert.equal(
    beacon.stage,
    'staging',
    "state.json's stage must be the deployment log's latest entry, not the manifest's raw 'development'",
  );

  // Fix round 2: `ladder.columns[].stage` is a SEPARATE field from `workstreams[].stage` above —
  // `computeLadder` (src/depth.mjs) builds its columns straight from the raw manifest, since that
  // same `stage` value also drives its bar/head-position math. `buildState` must still override the
  // *projected* `column.stage` with the matching workstream's `displayedStage`, keyed by codename,
  // so the two fields in the same state.json never disagree about beacon's stage.
  const beaconColumn = overriddenState.ladder.columns.find((c) => c.codename === 'Beacon');
  assert.ok(beaconColumn, 'state.json has no ladder column for Beacon');
  assert.equal(
    beaconColumn.stage,
    'staging',
    "state.json's ladder.columns[].stage must also be the deployment log's latest entry, not the manifest's raw 'development'",
  );
});

test('state: every milestone matches the row the workstream page rendered for it', () => {
  for (const stream of workstreams) {
    const entry = state.workstreams.find((w) => w.slug === stream.slug);
    const page = read(`workstream/${stream.slug}/index.html`);

    // The milestone table, row by row, as the page actually rendered it.
    const rows = [...page.matchAll(/<tr>\s*<th scope="row"[^>]*><a href="([^"]+)">([^<]+)<\/a><\/th>\s*<td>([^<]*)<\/td>\s*<td><span class="chip [^"]*" data-status="([^"]+)"/g)];
    assert.equal(rows.length, entry.milestones.length, `${stream.slug}: state and page disagree on how many milestones there are`);

    entry.milestones.forEach((milestone, i) => {
      const [, url, label, title, status] = rows[i];
      assert.equal(milestone.url, url, `${stream.slug} ${milestone.id}: state and page disagree about the page's URL`);
      assert.equal(milestone.label, label, `${stream.slug} ${milestone.id}: label`);
      assert.equal(milestone.title, title, `${stream.slug} ${milestone.id}: title`);
      assert.equal(milestone.status, status, `${stream.slug} ${milestone.id}: status`);

      // And against the manifest, which is the authority both of them answer to.
      const source = stream.manifest.milestones[i];
      assert.equal(milestone.id, source.id);
      assert.equal(milestone.depth, source.depth);
      assert.equal(milestone.plan, source.plan, 'decision 14 fixes "plan" as the manifest wrote it');
      assert.equal(milestone.issue, source.issue);
      assert.equal(milestone.pr, source.pr);
      assert.deepEqual(milestone.acceptance, source.acceptance);
    });
  }
});

test('state: every URL it names is a page the same build actually wrote', () => {
  const urls = [
    ...state.workstreams.map((w) => w.url),
    ...state.workstreams.flatMap((w) => w.milestones.map((m) => m.url)),
    ...state.documents.map((d) => d.url),
    ...state.surfaces.map((s) => s.url),
  ];

  assert.ok(urls.length > 0);
  for (const url of urls) {
    const file = path.join(OUT, decodeURIComponent(url).replace(/^\//, ''), 'index.html');
    assert.ok(existsSync(file), `state.json names ${url}, which this build never wrote`);
  }
});

test('state: every record path it names is a file in the project, not an absolute path', () => {
  const paths = [
    ...state.workstreams.map((w) => w.manifestPath),
    ...state.workstreams.flatMap((w) => w.milestones.map((m) => m.planPath)),
    ...state.documents.map((d) => d.path),
    ...state.assets.map((a) => a.path),
  ];

  for (const rel of paths) {
    assert.ok(!path.isAbsolute(rel), `${rel} is an absolute path — state.json must be portable`);
    assert.ok(!rel.includes('\\'), `${rel} uses backslashes — state.json must read the same on any platform`);
    assert.ok(existsSync(path.join(FIXTURE_ROOT, rel)), `state.json names ${rel}, which is not in the project`);
  }
});

// --- the same issue buckets -----------------------------------------------------------------------

test('state: the issue buckets are the ones the workstream pages listed', () => {
  for (const stream of workstreams) {
    const entry = state.workstreams.find((w) => w.slug === stream.slug);
    const page = read(`workstream/${stream.slug}/index.html`);

    const rendered = [...page.matchAll(/<li><a href="[^"]*"><span class="num">#(\d+)<\/span>/g)].map((m) =>
      Number(m[1]),
    );
    assert.deepEqual(
      entry.issues.map((issue) => issue.number),
      rendered,
      `${stream.slug}: state.json and the page disagree about which issues carry the label`,
    );

    // And the label bucket is the same list again, keyed by the label the manifest declares.
    assert.deepEqual(
      (state.issues.byLabel[stream.manifest.label] ?? []).map((issue) => issue.number),
      rendered,
      `${stream.slug}: the by-label bucket and the workstream's own list disagree`,
    );
  }
});

test('state: pull requests and unlabelled issues are kept in their own buckets', () => {
  const expectedPrs = ISSUES.filter((item) => item.pull_request).map((item) => item.number);
  const expectedUnlabelled = ISSUES.filter(
    (item) => !item.pull_request && !(item.labels ?? []).some((l) => l.name.startsWith('workstream:')),
  ).map((item) => item.number);

  assert.deepEqual(state.issues.prs.map((p) => p.number), expectedPrs);
  assert.deepEqual(state.issues.unlabelled.map((i) => i.number), expectedUnlabelled);

  assert.ok(expectedPrs.length > 0, 'the issue fixture no longer exercises the pull-request bucket');
  assert.ok(expectedUnlabelled.length > 0, 'the issue fixture no longer exercises the unlabelled bucket');
});

// --- the same triage the phone view showed ---------------------------------------------------------

test('state: the triage order is the order the phone view put the cards in (decisions 27, 29)', () => {
  // Read both values off the same <article> tag rather than counting `data-triage` attributes and
  // taking every other one: the card also carries the state on its chip, and a third occurrence
  // would silently misalign the two lists instead of failing.
  const articles = [
    ...read('mobile/index.html').matchAll(
      /<article\b[^>]*data-workstream="([^"]+)"[^>]*data-triage="([^"]+)"[^>]*>/g,
    ),
  ];
  assert.equal(articles.length, state.triage.length, 'the phone view and state.json disagree on how many cards');

  const cards = articles.map((m) => m[1]);
  const states = articles.map((m) => m[2]);

  assert.deepEqual(state.triage.map((t) => t.codename), cards, 'state.json and the phone view disagree about the order');
  assert.deepEqual(state.triage.map((t) => t.triage), states, 'state.json and the phone view disagree about the states');

  // The same value again on the workstream entry itself, so an agent reading one workstream does
  // not have to cross-reference the list.
  for (const item of state.triage) {
    const entry = state.workstreams.find((w) => w.slug === item.slug);
    assert.equal(entry.triage, item.triage, `${item.slug}: the two places state.json records triage disagree`);
  }
});

// --- the same ladder the chart drew -----------------------------------------------------------------

test('state: every ladder column names a real row', () => {
  // The gutter-caption scrape this test used to run against no longer has a surface to scrape:
  // the accordion rebuild (2a/2b) retired the shared depth-chart ladder gutter entirely, so
  // there is nothing left on any page to compare state.ladder.rows against. What survives is
  // pure state.json-internal consistency, independent of any surface: every column's headAt and
  // barTo must each name a row that actually exists on state.ladder.rows.
  assert.equal(state.ladder.columns.length, state.workstreams.length);
  state.ladder.columns.forEach((column, i) => {
    assert.equal(column.codename, state.workstreams[i].codename);
    assert.ok(
      state.ladder.rows.some((row) => row.id === column.headAt),
      `${column.codename}: headAt "${column.headAt}" names no row on the ladder`,
    );
    assert.ok(
      column.barTo === null || state.ladder.rows.some((row) => row.id === column.barTo),
      `${column.codename}: barTo "${column.barTo}" names no row on the ladder`,
    );
    // Decision 25's note is the workstream's `next` field (M4.2: renamed from `gate`). M2.1 moved
    // where it is said on this surface: #780 replaced the tip note with a balloon whose text is
    // the next milestone's TITLE, and `next` only where the feature is still in the stages. It is
    // unchanged on the phone view, which ends every card on it, and on the feature's own page.
    assert.ok(
      read(`workstream/${state.workstreams[i].slug}/index.html`).includes(column.note),
      `${column.codename}: next in state never reached its own page`,
    );
    assert.ok(read('mobile/index.html').includes(column.note), `${column.codename}: next never reached the phone`);
  });
});

test('state: the completion it reports is the completion the phone view drew (decision 24)', () => {
  // Completion is computed once, in `computeLadder`. The chart's bar, the phone's track and these
  // two numbers are three readings of one answer, so this compares the file against the page the
  // same build emitted rather than against a second derivation from the manifests.
  const cards = read('mobile/index.html')
    .split('<article class="card"')
    .slice(1)
    .map((chunk) => ({
      codename: /data-workstream="([^"]*)"/.exec(chunk)?.[1],
      counts: [...(/<p class="track-count[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(chunk)?.[1] ?? '').matchAll(
        /<span class="num">(\d+)<\/span>/g,
      )].map((m) => Number(m[1])),
      segments: [...(/<div class="track"[^>]*>([\s\S]*?)<\/div>/.exec(chunk)?.[1] ?? '').matchAll(
        /<span class="track-seg([^"]*)"><\/span>/g,
      )].map((m) => m[1].includes('is-filled')),
    }));

  assert.equal(cards.length, state.workstreams.length, 'expected one card per workstream');

  for (const card of cards) {
    const entry = state.workstreams.find((w) => w.codename === card.codename);
    assert.ok(entry, `state.json has no entry for the card "${card.codename}"`);

    if (entry.depth.milestoneCount === 0) {
      assert.deepEqual(card.counts, [], `${card.codename}: a workstream with no milestones draws no count`);
      assert.deepEqual(card.segments, [], `${card.codename}: and no track`);
      continue;
    }

    assert.deepEqual(
      card.counts,
      [entry.depth.completedCount, entry.depth.milestoneCount],
      `${card.codename}: the phone view and state.json disagree about how much is complete`,
    );
    assert.equal(
      card.segments.length,
      entry.depth.milestoneCount,
      `${card.codename}: the track must hold one segment per milestone state.json lists`,
    );
    assert.equal(
      card.segments.filter(Boolean).length,
      entry.depth.completedCount,
      `${card.codename}: the track fills a different number of segments than state.json counts`,
    );
  }
});

test('state: completion never exceeds the milestones the same file lists', () => {
  for (const stream of state.workstreams) {
    assert.equal(
      stream.depth.milestoneCount,
      stream.milestones.length,
      `${stream.codename}: the milestone count disagrees with the milestones listed beside it`,
    );
    assert.ok(
      stream.depth.completedCount >= 0 && stream.depth.completedCount <= stream.depth.milestoneCount,
      `${stream.codename}: completedCount is outside the range its own milestone list allows`,
    );
  }
});

// --- documents -------------------------------------------------------------------------------------

test('state: every Markdown record the build rendered is listed, and nothing else is', () => {
  const listed = state.documents.map((d) => d.path).sort();
  assert.ok(listed.includes('ROADMAP.md'), 'the roadmap is not listed as a record');
  assert.ok(listed.includes('docs/design/approved/lighthouse-decisions.md'));
  assert.ok(listed.every((p) => p.endsWith('.md')), 'a non-Markdown file was listed as a rendered record');
  assert.ok(!listed.some((p) => p.endsWith('workstream.json')), 'a manifest was listed as a record');

  for (const doc of state.documents) {
    assert.ok(doc.title && doc.title.trim().length > 0, `${doc.path} was listed with no title`);
  }
});

test('state: the byte-for-byte copies are listed as copies, never as rendered records', () => {
  const assets = state.assets.map((a) => a.path).sort();
  assert.deepEqual(assets, ['docs/field notes.html', 'docs/reference.html', 'docs/support.js']);
  assert.ok(!state.documents.some((d) => assets.includes(d.path)));

  for (const asset of state.assets) {
    assert.ok(existsSync(path.join(OUT, asset.path)), `${asset.path} is listed but was not copied`);
  }
});

// --- M2.1, from #780: the stored dates travel with the milestone ----------------------------------

test('state: a milestone carries the days it started and closed, exactly as recorded', () => {
  const bySlug = Object.fromEntries(state.workstreams.map((w) => [w.slug, w]));
  const milestone = (slug, id) => bySlug[slug].milestones.find((m) => m.id === id);

  // Closed: both days, and both from the manifest rather than from anything Atlas worked out.
  const manifests = Object.fromEntries(workstreams.map((w) => [w.slug, w.manifest]));
  const recorded = manifests.reef.milestones.find((m) => m.id === 'M1');
  assert.equal(milestone('reef', 'M1').started, recorded.started);
  assert.equal(milestone('reef', 'M1').completed, recorded.completed);

  // In flight: a start day and no close day.
  assert.equal(milestone('tide', 'M2').started, '2026-04-06');
  assert.equal(milestone('tide', 'M2').completed, null);

  // Never recorded at all: null, not absent, so a reader never has to tell the two apart.
  assert.equal(milestone('tide', 'M3').started, null);
  assert.equal(milestone('tide', 'M3').completed, null);
  assert.equal(milestone('anchor', 'M1').started, null, 'Anchor records no dates, and still renders');

  for (const workstream of state.workstreams) {
    for (const entry of workstream.milestones) {
      assert.ok('started' in entry && 'completed' in entry, `${entry.id} is missing a date key`);
    }
  }
});

test('state: the two new date keys are additive, so the document stays at version 1', () => {
  // The rule this pins, from the module's own comment: "bumped only when a change would break a
  // reader that understood the previous version — a new optional key does not." A reader coded
  // against v1 still finds every key it knew, unchanged.
  assert.equal(state.version, 1);
  assert.equal(STATE_VERSION, 1);

  // And nothing dated by the BUILD got in alongside them: these are facts on record, not stamps.
  const text = read('state.json');
  assert.ok(!/"(generated|built|builtAt|generatedAt|timestamp)"/i.test(text), 'state.json stamps a build time');
});

// --- and it is stable ------------------------------------------------------------------------------

test('state: it is written in a stable key order, so a rebuild diffs to nothing', () => {
  const text = read('state.json');
  assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 2)}\n`, 'state.json is not canonically formatted');

  const labels = Object.keys(state.issues.byLabel);
  assert.deepEqual(labels, [...labels].sort(), 'the by-label buckets are not in a stable order');
});
