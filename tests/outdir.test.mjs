import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  linkSync,
  lstatSync,
  realpathSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertOutputDirIsSafe,
  assertStagingDirIsFree,
  createStagingDir,
  canonicalise,
  containsByInode,
  containsLexically,
  isSameFile,
  stagingDirFor,
} from '../src/outdir.mjs';

// The guard, reached directly rather than through `build()`.
//
// That is the whole reason this file exists. Every mechanism in `src/outdir.mjs` was, until this
// file, reachable only end-to-end, and on the shapes a build test naturally reaches for the three
// checks agree with each other — so each one survived its own deletion with a green suite. This
// is the code that gates an `rmSync` over a user's records and it has already shipped one
// corpus-destroying hole; "the suite is green" was not evidence about any single check in it.
//
// So each mechanism below is aimed at with a shape **only that mechanism refuses**, measured by
// disabling the others one at a time. Those four shapes are marked THE ONLY CHECK THAT FIRES, and
// each was verified by applying the mutation, watching the test go red, and restoring:
//
//   isSameFile / containsByInode   a hard link to a read path
//   canonicalise                   a symlinked ancestor, with the read path not yet created
//   containsLexically(source→out)  the read path not yet created, output beneath where it will be
//   containsLexically(out→source)  `atlas <project> <project>`
//
// Nothing here needs a case-insensitive volume. `ln -s docs DOCS` gives `DOCS` the same `dev`/`ino`
// as `docs`, exactly as APFS would.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// Beside the repository rather than in os.tmpdir(): see .gitignore.
const ARENA = path.join(REPO_ROOT, '.tmp-tests', 'outdir');

let sequence = 0;

// A project and a generator, each with the files the guard treats as read paths. Both are real
// directories, because every check in the guard asks the filesystem something.
function arena() {
  const root = path.join(ARENA, `case-${(sequence += 1)}`);
  rmSync(root, { recursive: true, force: true });

  const project = path.join(root, 'project');
  const generator = path.join(root, 'generator');
  mkdirSync(path.join(project, 'docs', 'features'), { recursive: true });
  writeFileSync(path.join(project, 'atlas.config.json'), '{}\n');
  writeFileSync(path.join(project, 'ROADMAP.md'), '# Roadmap\n');
  writeFileSync(path.join(project, 'docs', 'a-record.md'), '# A record\n');

  for (const dir of ['theme', 'src', 'api', 'node_modules', 'tests', 'fixture']) {
    mkdirSync(path.join(generator, dir), { recursive: true });
    writeFileSync(path.join(generator, dir, 'a-file.txt'), 'content\n');
  }
  writeFileSync(path.join(generator, '.eleventy.js'), '// config\n');
  writeFileSync(path.join(generator, 'package.json'), '{}\n');

  return { root, project, generator };
}

// The guard's answer as a string: the refusal message, or null when it allowed the build.
function refusal(project, outDir, generator) {
  try {
    assertOutputDirIsSafe(project, outDir, generator);
    return null;
  } catch (error) {
    return error.message;
  }
}

function refuses(project, outDir, generator, because) {
  const message = refusal(project, outDir, generator);
  assert.ok(message, `the guard allowed ${outDir}, which ${because}`);
  assert.match(message, /^refusing to build into /, message);
  return message;
}

function allows(project, outDir, generator, because) {
  const message = refusal(project, outDir, generator);
  assert.equal(message, null, `the guard refused ${outDir}, which ${because}: ${message}`);
}

// --- the primitives ----------------------------------------------------------------------------

test('canonicalise: resolves the deepest ancestor that exists and keeps the rest', () => {
  const { project } = arena();
  symlinkSync(project, path.join(path.dirname(project), 'plink'));

  const through = path.join(path.dirname(project), 'plink', 'docs', 'not-yet', 'either');
  assert.equal(canonicalise(through), path.join(project, 'docs', 'not-yet', 'either'));
  assert.equal(canonicalise(path.join(project, 'docs')), path.join(project, 'docs'));
});

test('canonicalise: a path with no existing ancestor at all comes back resolved, not thrown', () => {
  const invented = path.join(ARENA, 'nothing-here', 'at', 'all');
  assert.equal(canonicalise(invented), path.resolve(invented));
});

test('isSameFile: two names for one file are the same file; a missing path is nothing', () => {
  const { project } = arena();
  const roadmap = path.join(project, 'ROADMAP.md');
  const second = path.join(project, 'second-name');
  linkSync(roadmap, second);

  assert.equal(isSameFile(roadmap, second), true, 'a hard link is the same file');
  assert.equal(isSameFile(roadmap, path.join(project, 'atlas.config.json')), false);
  assert.equal(isSameFile(roadmap, path.join(project, 'never-created')), false);
  assert.equal(isSameFile(path.join(project, 'never-created'), path.join(project, 'nor-this')), false);
});

test('containsLexically: a directory contains itself and what is beneath it, and no prefix twin', () => {
  assert.equal(containsLexically('/a/docs', '/a/docs'), true);
  assert.equal(containsLexically('/a/docs', '/a/docs/site'), true);
  // The one every string-prefix check gets wrong.
  assert.equal(containsLexically('/a/docs', '/a/docs-backup'), false);
  assert.equal(containsLexically('/a/docs/site', '/a/docs'), false);
});

test('containsByInode: walks the literal ancestors, never the resolved path', () => {
  const { project } = arena();
  const docs = path.join(project, 'docs');
  const escape = path.join(ARENA, 'escape-target');
  mkdirSync(escape, { recursive: true });
  // The shape that shipped: the final component is a symlink pointing out of the project. Its
  // RESOLVED form is harmless; the link itself is a file inside the corpus.
  symlinkSync(escape, path.join(docs, 'out'));

  assert.equal(containsByInode(docs, path.join(docs, 'out')), true);
  assert.equal(containsByInode(docs, path.join(docs, 'not-created-yet')), true);
  assert.equal(containsByInode(docs, path.join(project, '_site')), false);
});

// --- I3: each mechanism, aimed at on its own -----------------------------------------------------

test('guard: a hard link to a read path is refused — THE ONLY CHECK THAT FIRES is the inode one', () => {
  // Two names for one file, with two different real paths. `realpathSync` cannot collapse them,
  // because neither is more real than the other, so no lexical comparison of any spelling sees it
  // — only `dev`+`ino` does. Verified by mutation: with `isSameFile` returning false, or with the
  // `containsByInode` call removed, this test is the one that goes red.
  const { project, generator } = arena();
  const output = path.join(project, 'out-by-another-name');
  linkSync(path.join(project, 'ROADMAP.md'), output);

  const message = refuses(project, output, generator, "is the project's roadmap under another name");
  assert.match(message, /roadmap/);
});

test('guard: a read path that does not exist yet is still refused — THE ONLY CHECK THAT FIRES is the lexical one', () => {
  // `dev`/`ino` needs both paths to be real. This guard runs before anything is loaded, so a
  // project part-way through being set up — `docs/` not created yet — still reaches it, and
  // "build into docs/site" would create the very directory the next build reads from. Verified by
  // mutation: with the source-contains-output comparison removed, this test is the one that goes
  // red.
  const { project, generator } = arena();
  rmSync(path.join(project, 'docs'), { recursive: true, force: true });

  refuses(
    project,
    path.join(project, 'docs', 'site'),
    generator,
    'is inside where the records will be, and would become records on the next build',
  );
});

test('guard: a symlinked ancestor with a read path not yet created is refused — THE ONLY CHECK THAT FIRES is canonicalise', () => {
  // Both halves at once, which is the case `canonicalise` exists for and the only one it is alone
  // in catching: the inode check has nothing to compare because `docs/` does not exist, and no
  // lexical comparison of the literal spellings shares a single character with the project's own
  // path. Verified by mutation: with `canonicalise` reduced to `path.resolve`, this test is the
  // one that goes red.
  const { root, project, generator } = arena();
  rmSync(path.join(project, 'docs'), { recursive: true, force: true });
  const viaLink = path.join(root, 'plink');
  symlinkSync(project, viaLink);

  refuses(
    project,
    path.join(viaLink, 'docs'),
    generator,
    'is the project\'s records reached by another spelling',
  );
});

test('guard: an output that would swallow a read path is refused — THE ONLY CHECK THAT FIRES is the reverse containment', () => {
  // The other direction, and a different failure: the output takes the input with it. Verified by
  // mutation: with the output-contains-source comparison removed, `atlas <project> <project>` is
  // allowed and the build deletes the project it was pointed at.
  const { project, generator } = arena();
  refuses(project, project, generator, 'is the project itself');
  refuses(project, path.parse(project).root, generator, 'is the filesystem root');
});

// --- I1: a symlink as the final component --------------------------------------------------------

test('guard: an output that is a symlink pointing out of the project is refused', () => {
  // `rmSync(out, { recursive: true })` unlinks THE LINK, not what it points at — and the link is a
  // file inside the corpus. The guard used to resolve the output through `realpathSync` first, so
  // it compared `/elsewhere` against the project, found no overlap, and allowed it. Every rebuild
  // then added the whole site to `docs/`, which the next build ingested.
  const { project, generator } = arena();
  const escape = path.join(ARENA, 'symlink-escape-target');
  rmSync(escape, { recursive: true, force: true });
  mkdirSync(escape, { recursive: true });

  const link = path.join(project, 'docs', 'out');
  symlinkSync(escape, link);

  refuses(project, link, generator, 'is a link that lives inside the records');
});

test('guard: the same, one level down, and through a symlink named like the records', () => {
  const { project, generator } = arena();
  // `ln -s docs DOCS` gives DOCS the same dev/ino as docs — what a case-insensitive volume does
  // for free, and the reason this suite needs no macOS runner to cover it.
  symlinkSync('docs', path.join(project, 'DOCS'));

  refuses(project, path.join(project, 'DOCS'), generator, 'is the records under a folded name');
  refuses(project, path.join(project, 'DOCS', 'site'), generator, 'is inside the records');
});

// --- I2: the generator's own read paths ----------------------------------------------------------

test('guard: every path the build reads is protected, the generator\'s own code included', () => {
  const { project, generator } = arena();

  // `api` is on this list for the same reason `src` is: `src/schema.mjs` imports the closed
  // vocabularies out of `api/lib/contract.mjs`, so the build reads that directory on every run.
  for (const readPath of ['theme', 'src', 'api', 'node_modules', '.eleventy.js', 'package.json']) {
    refuses(
      project,
      path.join(generator, readPath),
      generator,
      `is ${readPath}, which the build reads`,
    );
  }
  for (const readPath of ['atlas.config.json', 'ROADMAP.md', 'docs']) {
    refuses(project, path.join(project, readPath), generator, `is the project's ${readPath}`);
  }
});

test('guard: naming the read paths one by one is what keeps the ordinary invocations working', () => {
  // The reason the list is file-by-file rather than "the generator repository" and "the project".
  // Refuse these and Atlas is unusable in the one shape decision 39 says it always runs in.
  const { project, generator } = arena();

  allows(project, path.join(generator, '.out'), generator, 'is the ordinary local invocation');
  allows(project, path.join(project, '_site'), generator, 'is what a composite action does');
  allows(project, path.join(project, 'docs-backup'), generator, 'merely starts like docs');
  allows(project, path.join(generator, 'theme-of-my-own'), generator, 'merely starts like theme');
});

// --- I4: the staging directory ----------------------------------------------------------------------

test('guard: the staging directory is a sibling of the output directory, and nothing else', () => {
  // The reason `assertOutputDirIsSafe` checks one path and not two. A sibling shares every
  // ancestor with the output directory, so the checks that cleared the output directory cleared
  // this too; and no read path ends in `.atlas-staging`, so it cannot BE one. What is left — a
  // path already sitting there — is `assertStagingDirIsFree`'s job, below.
  const { project } = arena();
  const outDir = path.join(project, '_site');

  assert.equal(stagingDirFor(outDir), `${outDir}.atlas-staging`);
  assert.equal(path.dirname(stagingDirFor(outDir)), path.dirname(path.resolve(outDir)));
  assert.equal(stagingDirFor('relative-out'), `${path.resolve('relative-out')}.atlas-staging`);
});

test('guard: a staging directory that is already there stops the build rather than being deleted', () => {
  // Verified before this test existed: a pre-existing `<project>/site.atlas-staging/precious.txt`
  // was deleted by the unguarded `rmSync`, exit 0, no warning. It is also where two concurrent
  // builds into one output directory collide.
  const { project } = arena();
  const outDir = path.join(project, 'site');
  const staging = stagingDirFor(outDir);
  mkdirSync(staging, { recursive: true });

  assert.throws(
    () => assertStagingDirIsFree(outDir),
    (error) => {
      assert.match(error.message, /^refusing to build into /);
      assert.ok(error.message.includes(staging), 'the message must name the directory to remove');
      return true;
    },
  );

  // And nothing was touched on the way to refusing.
  assert.ok(existsSync(staging), 'the staging directory must be left for the caller to look at');
});

test('guard: a clear staging path is not an obstacle', () => {
  const { project } = arena();
  assert.doesNotThrow(() => assertStagingDirIsFree(path.join(project, '_site')));
});

// --- the corpus survives ------------------------------------------------------------------------------

test('guard: refusing costs the project nothing — no path is created or removed on the way', () => {
  const { project, generator } = arena();
  const before = readdirSync(path.join(project, 'docs')).sort();

  for (const outDir of [
    path.join(project, 'docs'),
    path.join(project, 'docs', 'site'),
    project,
    path.join(generator, 'src'),
  ]) {
    refuses(project, outDir, generator, 'overlaps something the build reads');
  }

  assert.deepEqual(readdirSync(path.join(project, 'docs')).sort(), before);
  assert.ok(existsSync(path.join(project, 'ROADMAP.md')));
  assert.ok(existsSync(path.join(generator, 'src', 'a-file.txt')));
});

test('guard: claiming the staging directory is an atomic test-and-set, not a check then an act', () => {
  // `assertStagingDirIsFree` runs before the project is read, which is check-then-act with the
  // ENTIRE build as its race window — and `mkdirSync(staging, { recursive: true })` succeeds
  // silently when the directory is already there, so two builds could both check, both find it
  // free, and both write into one directory. `mkdir` WITHOUT `recursive` is the filesystem's own
  // atomic claim: exactly one caller creates it, every other gets EEXIST.
  const { project } = arena();
  const outDir = path.join(project, '_site');

  const staging = createStagingDir(outDir);
  assert.equal(staging, stagingDirFor(outDir));
  assert.ok(existsSync(staging), 'the winner must actually own a directory');

  assert.throws(
    () => createStagingDir(outDir),
    (error) => {
      assert.match(error.message, /^refusing to build into /);
      assert.ok(error.message.includes(staging), 'the message must name the directory to remove');
      return true;
    },
    'a second build claimed a staging directory another build already holds',
  );

  // And the loser took nothing with it: it throws before the build's own try/finally is entered,
  // so the winner's directory is still there and still its own.
  assert.ok(existsSync(staging), 'the losing build removed the winner\'s staging directory');
});

test('guard: the staging claim creates the parent, but never a directory that is already there', () => {
  const { project } = arena();
  const outDir = path.join(project, 'nested', 'deeper', '_site');

  const staging = createStagingDir(outDir);
  assert.ok(existsSync(staging), 'a missing parent must not stop the claim');
  assert.equal(path.dirname(staging), path.join(project, 'nested', 'deeper'));
});

test('guard: a dangling symlink at the staging path is seen, not looked through', () => {
  // `existsSync` follows symlinks, so it answers FALSE for a dangling one — and the guard would
  // declare the path free, only for `mkdirSync` to fail with a raw EEXIST for a name that is very
  // much taken. `lstat` asks the question that is actually being asked: is this name in use?
  const { project } = arena();
  const outDir = path.join(project, '_site');
  const staging = stagingDirFor(outDir);
  symlinkSync(path.join(project, 'nothing-is-here'), staging);

  assert.equal(existsSync(staging), false, 'the premise: existsSync looks through the dangling link');
  assert.throws(
    () => assertStagingDirIsFree(outDir),
    (error) => {
      assert.ok(error.message.includes(staging), error.message);
      return true;
    },
    'a dangling symlink occupies the staging path and must be reported as such',
  );
  assert.throws(() => createStagingDir(outDir), /refusing to build into /);
});

test('guard: an output directory that is itself a symbolic link is refused, not quietly replaced', () => {
  // `rmSync` unlinks a symlink rather than following it, and `renameSync` then puts a real
  // directory where the link was. No data is lost — the target survives — but a deliberate
  // indirection like `site -> /var/www/current` is destroyed silently, and the location it pointed
  // at goes stale forever with nobody told. That is the quietest possible failure and it used to
  // be the behaviour.
  const { project, generator } = arena();
  const real = path.join(project, 'published');
  mkdirSync(real, { recursive: true });
  const link = path.join(project, 'site');
  symlinkSync(real, link);

  const message = refuses(project, link, generator, 'is a symbolic link the build would replace');
  assert.match(message, /symbolic link/i, message);

  // Nothing was touched on the way to refusing: the link is still a link, still pointing there.
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(realpathSync(link), realpathSync(real));

  // And the same path, as a real directory, is fine — the refusal is about the indirection, not
  // about the name.
  rmSync(link, { force: true });
  mkdirSync(link, { recursive: true });
  allows(project, link, generator, 'is an ordinary directory');
});
