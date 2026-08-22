import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, resolveWorkstreams } from '../src/config.mjs';

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

function validManifest(overrides = {}) {
  return {
    codename: 'Nova',
    what: 'A sample workstream used only to exercise config loading',
    stage: 'planned',
    position: 'Designed, not approved',
    gate: 'Owner sign-off before build',
    label: 'workstream:nova',
    design: [{ name: 'nova/Overview v1', where: 'design-project' }],
    milestones: [],
    ...overrides,
  };
}

// --- loadConfig --------------------------------------------------------

test('loadConfig: reads the fixture project and normalises absolute paths', () => {
  const config = loadConfig(FIXTURE_ROOT);
  assert.equal(config.project, 'Lighthouse Fixture');
  assert.equal(config.repo, 'atlas-fixtures/lighthouse');
  assert.deepEqual(config.workstreams, ['beacon', 'tide', 'harbor', 'anchor']);
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
        assert.ok(err.message.includes(path.join(root, 'atlas.config.json')));
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
      assert.ok(err.message.includes(path.join(root, 'atlas.config.json')));
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig: resolves paths relative to the given project root, never the caller's cwd or the generator's own directory", () => {
  const originalCwd = process.cwd();
  // A directory that shares FIXTURE_ROOT's filesystem root, not os.tmpdir(): on this
  // environment's Windows Node reaching into WSL over a UNC path, os.tmpdir() lives on a
  // different root (C:\...\Temp) than the fixture (\\wsl.localhost\...), so path.relative()
  // between them degrades to returning the absolute path unchanged — which would make the
  // relative-path assertion below unfalsifiable again, for a different reason. A sibling of
  // FIXTURE_ROOT keeps the relative path genuinely relative.
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
    ['beacon', 'tide', 'harbor', 'anchor'],
  );
  assert.deepEqual(
    workstreams.map((w) => w.manifest.codename),
    ['Beacon', 'Tide', 'Harbor', 'Anchor'],
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
    const expectedPath = path.join(config.workstreamsRoot, 'ghost');
    assert.throws(
      () => resolveWorkstreams(config),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes(expectedPath));
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
        assert.ok(err.message.includes(notADirPath));
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
      validManifest({ codename: 'Bad', stage: 'not-a-real-stage' }),
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
        assert.ok(err.message.includes(manifestPath));
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
