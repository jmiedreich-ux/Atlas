import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, proposedDesignDirs, resolveWorkstreams, unnamedFeatureDirs } from '../src/config.mjs';
import { validateWorkstream } from '../src/schema.mjs';

// All fixture data below is invented for this test file and for fixture/ only — the generator
// holds no project content of its own (decision 40).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, '..', 'fixture');

function makeTempProject() {
  return mkdtempSync(path.join(tmpdir(), 'atlas-config-test-'));
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2));
}

// `validManifest` says valid, so it is — checked against the real schema rather than by eye. Four
// test files carried their own manifest builder and not one ran through `validateWorkstream`; a
// double that has quietly stopped being valid tests nothing, and says so to nobody.
//
// Tests that deliberately build an INVALID manifest pass overrides to `invalidManifest` instead,
// which is the same shape without the check.
function validManifest(overrides = {}) {
  const candidate = invalidManifest(overrides);
  const result = validateWorkstream(candidate);
  assert.ok(
    result.ok,
    `this test's own manifest is not one the generator would accept: ${JSON.stringify(result.errors)}`,
  );
  return candidate;
}

function invalidManifest(overrides = {}) {
  return {
    codename: 'Nova',
    what: 'A sample workstream used only to exercise config loading',
    stage: 'planned',
    position: 'Designed, not approved',
    next: 'Owner sign-off before build',
    label: 'workstream:nova',
    design: [{ name: 'nova/Overview v1', where: 'design-project' }],
    milestones: [],
    ...overrides,
  };
}

// One convention, enforced here and in tests/build.test.mjs: a failure names the file at fault by
// its repository-relative, slash-separated path, and never by an absolute one. On a runner an
// absolute path reads `/home/runner/work/repo/repo/docs/...` — noise the reader cannot act on and
// cannot search their own checkout for.
function assertNamesRepositoryRelative(message, projectRoot, expected) {
  assert.ok(
    message.includes(expected),
    `the failure does not name ${expected} repository-relative: ${message}`,
  );
  assert.ok(
    !message.includes(path.resolve(projectRoot)),
    `the failure names an absolute path from this machine: ${message}`,
  );
}

// --- loadConfig --------------------------------------------------------

test('loadConfig: reads the fixture project and normalises absolute paths', () => {
  const config = loadConfig(FIXTURE_ROOT);
  assert.equal(config.project, 'Lighthouse Fixture');
  assert.equal(config.repo, 'atlas-fixtures/lighthouse');
  assert.deepEqual(config.workstreams, ['beacon', 'tide', 'reef', 'harbor', 'anchor', 'shoal']);
  assert.ok(path.isAbsolute(config.projectRoot));
  assert.ok(path.isAbsolute(config.workstreamsRoot));
  assert.ok(path.isAbsolute(config.configPath));
  assert.equal(config.projectRoot, path.resolve(FIXTURE_ROOT));
});

test('loadConfig: a missing atlas.config.json fails with the path named', () => {
  const root = makeTempProject();
  try {
    assert.throws(
      () => loadConfig(root),
      (err) => {
        assert.ok(err instanceof Error);
        assertNamesRepositoryRelative(err.message, root, 'atlas.config.json');
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadConfig: an invalid atlas.config.json fails validation by field name', () => {
  const root = makeTempProject();
  try {
    writeJson(path.join(root, 'atlas.config.json'), { project: 'Broken', workstreams: ['nova'] }); // no repo
    assert.throws(() => loadConfig(root), /repo/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadConfig: malformed JSON in atlas.config.json fails with the path named', () => {
  const root = makeTempProject();
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'atlas.config.json'), '{ not valid json');
    assert.throws(() => loadConfig(root), (err) => {
      assertNamesRepositoryRelative(err.message, root, 'atlas.config.json');
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig: resolves paths relative to the given project root, never the caller's cwd or the generator's own directory", () => {
  const originalCwd = process.cwd();
  // A directory that shares FIXTURE_ROOT's filesystem root, not os.tmpdir(). Where the two sit on
  // different roots — which happens on more setups than it looks like it should — path.relative()
  // between them degrades to returning the absolute path unchanged, and the assertion below stops
  // being able to fail. A sibling of FIXTURE_ROOT keeps the relative path genuinely relative.
  const cwdDir = mkdtempSync(path.join(path.dirname(FIXTURE_ROOT), 'atlas-cwd-test-'));
  try {
    process.chdir(cwdDir);
    const absoluteConfig = loadConfig(FIXTURE_ROOT);
    assert.equal(absoluteConfig.projectRoot, path.resolve(FIXTURE_ROOT));
    assert.ok(absoluteConfig.workstreamsRoot.startsWith(absoluteConfig.projectRoot));

    // The case that would actually catch resolution drifting to cwd: an implementation that
    // resolved against process.cwd() instead of the given projectRoot would join a *relative*
    // projectRoot onto the wrong base and land somewhere under cwdDir, not under FIXTURE_ROOT.
    // path.resolve() alone can't expose that bug for an already-absolute FIXTURE_ROOT, so this
    // asserts the relative-path call still lands on the same result.
    const relativeRoot = path.relative(process.cwd(), FIXTURE_ROOT);
    assert.ok(
      !path.isAbsolute(relativeRoot),
      `expected a genuinely relative path between ${process.cwd()} and ${FIXTURE_ROOT} for this assertion to be meaningful, got ${relativeRoot}`,
    );
    const relativeConfig = loadConfig(relativeRoot);
    assert.deepEqual(relativeConfig, absoluteConfig);
  } finally {
    process.chdir(originalCwd);
    rmSync(cwdDir, { recursive: true, force: true });
  }
});

// --- resolveWorkstreams --------------------------------------------------

test("resolveWorkstreams: loads the fixture's workstreams in declaration order", () => {
  const config = loadConfig(FIXTURE_ROOT);
  const workstreams = resolveWorkstreams(config);
  assert.deepEqual(
    workstreams.map((w) => w.slug),
    ['beacon', 'tide', 'reef', 'harbor', 'anchor', 'shoal'],
  );
  assert.deepEqual(
    workstreams.map((w) => w.manifest.codename),
    ['Beacon', 'Tide', 'Reef', 'Harbor', 'Anchor', 'Shoal'],
  );
});

test('resolveWorkstreams: the fixture exercises workstreams of different milestone depths, including one with none and one fully done', () => {
  const config = loadConfig(FIXTURE_ROOT);
  const workstreams = resolveWorkstreams(config);
  const bySlug = Object.fromEntries(workstreams.map((w) => [w.slug, w]));
  assert.equal(bySlug.beacon.manifest.milestones.length, 6);
  assert.equal(bySlug.tide.manifest.milestones.length, 3);
  assert.equal(bySlug.harbor.manifest.milestones.length, 0);
  assert.equal(bySlug.anchor.manifest.milestones.length, 4);
  assert.ok(bySlug.anchor.manifest.milestones.every((m) => m.status === 'done'));

  // M2.1 (#780): the fixture also carries a workstream the work went ROUND a milestone of, and
  // one that has not started at all — the two shapes the rebuilt page has to draw and the M1
  // fixture had no case for.
  assert.equal(bySlug.reef.manifest.milestones.length, 5);
  assert.deepEqual(
    bySlug.reef.manifest.milestones.map((m) => m.status),
    ['done', 'done', 'parked', 'done', 'done'],
  );
  assert.equal(bySlug.shoal.manifest.stage, 'not-started');
  assert.equal(bySlug.shoal.manifest.milestones.length, 0);
});

test('resolveWorkstreams: a workstream directory that does not exist fails with that path named', () => {
  const root = makeTempProject();
  try {
    writeJson(path.join(root, 'atlas.config.json'), {
      project: 'Broken',
      repo: 'example-org/broken',
      workstreams: ['ghost'],
    });
    const config = loadConfig(root);
    assert.throws(
      () => resolveWorkstreams(config),
      (err) => {
        assert.ok(err instanceof Error);
        assertNamesRepositoryRelative(err.message, root, 'docs/features/ghost');
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveWorkstreams: a workstream directory that exists but is a file, not a directory, is diagnosed as such', () => {
  const root = makeTempProject();
  try {
    writeJson(path.join(root, 'atlas.config.json'), {
      project: 'Broken',
      repo: 'example-org/broken',
      workstreams: ['not-a-dir'],
    });
    const config = loadConfig(root);
    const notADirPath = path.join(config.workstreamsRoot, 'not-a-dir');
    mkdirSync(config.workstreamsRoot, { recursive: true });
    writeFileSync(notADirPath, 'this is a file, not a workstream directory');
    assert.throws(
      () => resolveWorkstreams(config),
      (err) => {
        assertNamesRepositoryRelative(err.message, root, 'docs/features/not-a-dir');
        assert.match(err.message, /not a directory/);
        assert.doesNotMatch(err.message, /does not exist/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveWorkstreams: a manifest that fails schema validation aborts the whole load, not just that workstream', () => {
  const root = makeTempProject();
  try {
    writeJson(path.join(root, 'atlas.config.json'), {
      project: 'Broken',
      repo: 'example-org/broken',
      workstreams: ['good', 'bad'],
    });
    writeJson(path.join(root, 'docs', 'features', 'good', 'workstream.json'), validManifest({ codename: 'Good' }));
    writeJson(
      path.join(root, 'docs', 'features', 'bad', 'workstream.json'),
      // Deliberately not valid — that is the whole test — so it skips the check `validManifest`
      // applies.
      invalidManifest({ codename: 'Bad', stage: 'not-a-real-stage' }),
    );
    const config = loadConfig(root);
    assert.throws(() => resolveWorkstreams(config), /stage/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveWorkstreams: a manifest with malformed JSON fails with the path named, not a stack trace', () => {
  const root = makeTempProject();
  try {
    writeJson(path.join(root, 'atlas.config.json'), {
      project: 'Broken',
      repo: 'example-org/broken',
      workstreams: ['bad-json'],
    });
    const manifestPath = path.join(root, 'docs', 'features', 'bad-json', 'workstream.json');
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, '{ this is not json');
    const config = loadConfig(root);
    assert.throws(
      () => resolveWorkstreams(config),
      (err) => {
        assertNamesRepositoryRelative(err.message, root, 'docs/features/bad-json/workstream.json');
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- the promotion path, which used to be folklore (#780, task 12) -----------------------------
//
// Promoting an idea from `docs/design` onto the sheet is two manual steps — write
// `docs/features/<slug>/workstream.json`, then add the slug to `atlas.config.json` — and nothing
// recorded that it happened or prompted for the second one.
//
// The REVERSE case already fails the build under decision 32: a config naming a directory that
// does not exist is a broken reference. The missing half is the feature that EXISTS and is not on
// the page, which was silent — the same failure shape as a hidden feature nobody can find.

test('promotion: a feature directory the config does not name is found and reported', () => {
  const root = makeTempProject();
  try {
    writeJson(path.join(root, 'atlas.config.json'), {
      project: 'Sample',
      repo: 'owner/sample',
      workstreams: ['nova'],
    });
    writeJson(path.join(root, 'docs', 'features', 'nova', 'workstream.json'), validManifest());
    // Written, and never added to the config. This is the half-finished promotion.
    writeJson(path.join(root, 'docs', 'features', 'quasar', 'workstream.json'), validManifest({
      codename: 'Quasar',
      label: 'workstream:quasar',
    }));

    assert.deepEqual(unnamedFeatureDirs(loadConfig(root)), ['quasar']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('promotion: nothing is reported when the config names every feature that exists', () => {
  const root = makeTempProject();
  try {
    writeJson(path.join(root, 'atlas.config.json'), {
      project: 'Sample',
      repo: 'owner/sample',
      workstreams: ['nova'],
    });
    writeJson(path.join(root, 'docs', 'features', 'nova', 'workstream.json'), validManifest());
    assert.deepEqual(unnamedFeatureDirs(loadConfig(root)), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('promotion: the warning is a warning — it never throws, whatever it finds or fails to read', () => {
  // It runs on every build, so it cannot be a new way for one to fail. A project with no
  // `docs/features` at all is legitimate — decision 40 asks for the directory only when there are
  // features — and a loose file beside the directories is not a half-promoted feature.
  const root = makeTempProject();
  try {
    writeJson(path.join(root, 'atlas.config.json'), {
      project: 'Sample',
      repo: 'owner/sample',
      workstreams: [],
    });
    // No docs/features at all.
    assert.deepEqual(unnamedFeatureDirs(loadConfig(root)), []);

    mkdirSync(path.join(root, 'docs', 'features'), { recursive: true });
    writeFileSync(path.join(root, 'docs', 'features', 'README.md'), '# not a feature\n');
    // A dot-directory: the records walk skips these, so a feature in one would not render anyway.
    mkdirSync(path.join(root, 'docs', 'features', '.scratch'), { recursive: true });
    assert.deepEqual(unnamedFeatureDirs(loadConfig(root)), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('promotion: the fixture itself has no half-promoted feature, so the warning stays meaningful', () => {
  // A fixture that always warns is a warning nobody reads.
  assert.deepEqual(unnamedFeatureDirs(loadConfig(FIXTURE_ROOT)), []);
});

// --- proposedDesignDirs: directory-shaped AND loose-file-shaped proposals ----------------------

test('proposedDesignDirs: a slug directory and a loose-file group are both listed', () => {
  const root = makeTempProject();
  try {
    writeJson(path.join(root, 'atlas.config.json'), { project: 'Sample', repo: 'owner/sample', workstreams: [] });
    const proposedRoot = path.join(root, 'docs', 'design', 'proposed');
    mkdirSync(path.join(proposedRoot, 'keystone'), { recursive: true });
    writeFileSync(path.join(proposedRoot, 'keystone', 'decisions.md'), '# Keystone\n');
    writeFileSync(path.join(proposedRoot, 'observability-and-performance-telemetry.md'), '# Observability\n');

    assert.deepEqual(proposedDesignDirs(loadConfig(root)), [
      'keystone',
      'observability-and-performance-telemetry',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('proposedDesignDirs: sibling loose files sharing a filename stem list as one slug, not several', () => {
  const root = makeTempProject();
  try {
    writeJson(path.join(root, 'atlas.config.json'), { project: 'Sample', repo: 'owner/sample', workstreams: [] });
    const proposedRoot = path.join(root, 'docs', 'design', 'proposed');
    mkdirSync(proposedRoot, { recursive: true });
    for (const name of ['display-stale-signals.md', 'display-stale-signals.html', 'display-stale-signals-00.png', 'display-stale-signals-06.png']) {
      writeFileSync(path.join(proposedRoot, name), 'x');
    }
    assert.deepEqual(proposedDesignDirs(loadConfig(root)), ['display-stale-signals']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('proposedDesignDirs: README.md beside the proposals is never listed as one', () => {
  const root = makeTempProject();
  try {
    writeJson(path.join(root, 'atlas.config.json'), { project: 'Sample', repo: 'owner/sample', workstreams: [] });
    const proposedRoot = path.join(root, 'docs', 'design', 'proposed');
    mkdirSync(proposedRoot, { recursive: true });
    writeFileSync(path.join(proposedRoot, 'README.md'), '# Proposed design references\n');
    assert.deepEqual(proposedDesignDirs(loadConfig(root)), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('proposedDesignDirs: an existing manifest for the slug does not exclude it', () => {
  // #18 retired this exclusion for directories; the same must hold for loose-file groups — a
  // feature can already be tracked while its design is still a loose file in proposed/.
  const root = makeTempProject();
  try {
    writeJson(path.join(root, 'atlas.config.json'), { project: 'Sample', repo: 'owner/sample', workstreams: ['nova'] });
    writeJson(path.join(root, 'docs', 'features', 'nova', 'workstream.json'), validManifest());
    const proposedRoot = path.join(root, 'docs', 'design', 'proposed');
    mkdirSync(proposedRoot, { recursive: true });
    writeFileSync(path.join(proposedRoot, 'nova.md'), '# Nova\n');
    assert.deepEqual(proposedDesignDirs(loadConfig(root)), ['nova']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
