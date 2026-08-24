#!/usr/bin/env node
// The build: a project repository in, a static site out (decisions 1, 3, 9, 12).
//
// Everything above this module computes one thing well. This one wires them into a program, and
// it is where the milestone's two structural rules are enforced rather than described:
//
//   * **Decision 32 — fail loudly.** A manifest pointing at a plan that does not exist, a status
//     outside the closed vocabulary, a workstream with no `next`: each aborts the build, non-zero,
//     naming the path. Nothing is written. This is what makes decision 1 — built from source,
//     never maintained — structural instead of aspirational: a record Atlas cannot render is a
//     record somebody has to fix, not a blank cell nobody notices. `src/github.mjs` is the whole
//     generator's one tolerated exception, because GitHub being unreachable must not stop the
//     repository rendering.
//   * **Decision 10 — standalone HTML is copied, never templated.** Eleventy's input directory is
//     the generator's own `theme/` (see `.eleventy.js`), so it never walks the project at all. The
//     project's `.html` files and their sibling assets are copied with `copyFileSync`. They cannot
//     be picked up as templates, because nothing that could pick them up ever sees them.
//
// And one property the whole claim rests on: **a second build over the same output is
// byte-identical.** A generator whose output varies run to run cannot be trusted to be current.
// Every directory read here is sorted, every object key order is decided in code rather than
// inherited from a filesystem or a Map, no path from the build machine reaches a generated file,
// and nothing is dated.

import Eleventy from '@11ty/eleventy';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DEPLOYMENT_STAGES } from '../api/lib/contract.mjs';
import { loadConfig, repoRelative, resolveWorkstreams, unnamedFeatureDirs } from './config.mjs';
import { assertOutputDirIsSafe, assertStagingDirIsFree, createStagingDir } from './outdir.mjs';
import { computeLadder, assertLadderResolves, spineDetail } from './depth.mjs';
import { emptyBuckets, fetchIssueBodies, fetchProjectIssues } from './github.mjs';
import { headingAnchors, renderMarkdown } from './markdown.mjs';
import { validateRegister, renderRegisterMarkdown } from './register.mjs';
import { buildState, serialiseState } from './state.mjs';
import { SWA_CONFIG_FILENAME, serialiseSwaConfig } from './swa.mjs';
import { orderByTriage } from './triage.mjs';
import { parseTasks } from './tasks.mjs';
import configureAtlasEleventy from '../.eleventy.js';

const GENERATOR_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THEME_DIR = path.join(GENERATOR_ROOT, 'theme');
// The generator's own files, served at the paths the layouts link to. Copied rather than rendered:
// Eleventy's template formats are `njk` and nothing else (see `.eleventy.js`), so neither of these
// is ever discovered as a page.
//
// `order.js` is the feature planning surface's one piece of behaviour — putting the features in
// your own order (#780). Decision 12 says no framework runtime and no second hosting model, and
// this is neither: it is one static file, with no dependency of its own, doing one thing on one
// page that the reader asked for.
//
// `deploy.js` (M8 task 7) is the feature planning surface's second and only other piece of
// behaviour — the Development/Staging/Release trigger buttons that POST to
// `/api/deployment-transition`. Copied the same way, for the same reason: `theme/_includes/
// depth.njk`'s own `bodyScripts` block links to `/deploy.js`, and nothing else in this generator
// ever copies a file out of `theme/` into a build's output — Eleventy's input directory is
// `theme/_includes` only (`.eleventy.js`), so a file sitting beside it is invisible to Eleventy
// entirely and has to be named here or it 404s on every real build.
const THEME_FILES = Object.freeze(['tokens.css', 'order.js', 'deploy.js']);

// Decision 40: the fixed convention a project provides, and nothing else.
const CONFIG_FILENAME = 'atlas.config.json';
const ROADMAP = 'ROADMAP.md';
const DOCS_DIRNAME = 'docs';
const MANIFEST_FILENAME = 'workstream.json';
// M5: a register source, read and transformed into a generated document (loadRegister above) —
// the same reason workstream.json is excluded from the generic asset-copy pipeline below, not a
// standalone file meant to be served as itself.
const REGISTER_FILENAME = 'register.json';

// --- paths ---------------------------------------------------------------------------------------

// A repository-relative, slash-separated path. Nothing that reaches an output file — or a failure
// message — is ever built any other way: an absolute path from the build machine is both useless
// to a reader and the most common reason a rebuild stops being reproducible.
//
// Defined once, in src/config.mjs, because config.mjs fails before build.mjs is doing anything and
// its messages have to follow the same rule. `tests/build.test.mjs` enforces the rule across every
// module that can fail.
const relPath = repoRelative;

// A site URL for a repository-relative path, with each segment encoded but the slashes left alone.
function encodeUrlPath(relative) {
  return relative.split('/').map(encodeURIComponent).join('/');
}

/**
 * The site URL of a workstream's page, and of one of its milestone pages.
 *
 * Exported because the layouts and the tests must not build these a second way: until this
 * existed, records and assets went through `encodeUrlPath` while workstream and milestone URLs
 * were raw interpolation, so a workstream directory named `har bor` produced
 * `href="/workstream/har bor/"` on the site AND in `state.json` — an invalid URL in a v1 contract —
 * beside a correctly encoded `/docs/field%20notes.html`.
 *
 * The matching `permalink` is deliberately NOT encoded: that one is a filesystem path Eleventy
 * writes to, and it has to be the directory name the project actually chose.
 */
export function workstreamUrl(slug) {
  return `/workstream/${encodeUrlPath(slug)}/`;
}

export function milestoneUrl(slug, milestoneId) {
  return `${workstreamUrl(slug)}${encodeUrlPath(milestoneId.toLowerCase())}/`;
}

// Every file under `dir`, sorted, as absolute paths. Dot-directories and dot-files are skipped:
// `.git`, `.github` and their like are infrastructure, not records.
function filesUnder(dir) {
  if (!existsSync(dir)) return [];

  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(full));
    else if (entry.isFile()) found.push(full);
  }
  // Sorted by the path an output file is keyed on, not by whatever order the filesystem
  // enumerated — the readdir order is not guaranteed and differs between filesystems.
  return found.sort();
}

// --- the checks decision 32 demands ----------------------------------------------------------------

// A manifest that names a plan file which is not there. The single most important failure in the
// generator: it is the one that keeps the manifests honest.
function assertPlansExist(projectRoot, workstreams) {
  for (const stream of workstreams) {
    for (const milestone of stream.manifest.milestones) {
      const absolute = path.join(stream.dir, milestone.plan);
      const where = relPath(projectRoot, absolute);
      const named =
        `${relPath(projectRoot, stream.manifestPath)}: workstream "${stream.manifest.codename}" ` +
        `milestone ${milestone.id} names plan "${milestone.plan}", but `;

      // "Missing" and "there, but not a file" are different things to have got wrong and lead to
      // different fixes, so they are diagnosed separately — the same distinction
      // `assertRoadmapExists` makes fifteen lines below.
      if (!existsSync(absolute)) {
        throw new Error(
          `${named}there is no file at ${where}. Either the plan was moved and the manifest was ` +
            `not updated, or the manifest is ahead of the record (decisions 1, 32).`,
        );
      }
      if (!statSync(absolute).isFile()) {
        throw new Error(
          `${named}${where} is a directory, not a Markdown file. Decision 14 makes "plan" a ` +
            `filename resolved against the workstream's own directory.`,
        );
      }
    }
  }
}

// The sibling of `assertPlansExist`, and it checks the same two things for the same reason: a
// directory named `ROADMAP.md` passed `existsSync` and reached the reader as a bare `EISDIR` from
// somewhere else entirely.
function assertRoadmapExists(projectRoot) {
  const absolute = path.join(projectRoot, ROADMAP);
  const where = relPath(projectRoot, absolute);

  if (!existsSync(absolute)) {
    throw new Error(
      `${where} is missing: a project Atlas builds provides ${ROADMAP} at its root (decision 40), ` +
        `and decision 16 makes its tables generated output rather than prose. Nothing was found ` +
        `at ${where} — check that the project root given to Atlas is the directory that carries ` +
        `${CONFIG_FILENAME}.`,
    );
  }
  if (!statSync(absolute).isFile()) {
    throw new Error(
      `${where} is not a file: a project Atlas builds provides ${ROADMAP} at its root as a ` +
        `Markdown record (decision 40), and this is a directory.`,
    );
  }
}

// --- the project's records --------------------------------------------------------------------------
//
// NAMING, because "document" means two things in this file and an inheritor will trip on it once:
//
//   * `collectDocuments` returns the MARKDOWN RECORDS Atlas renders (decision 15) — the roadmap and
//     every `.md` under `docs/`.
//   * `isDocument`, on an entry from `collectAssets`, marks a COPIED HTML FILE (decision 10) — one
//     a reader opens, as against a `support.js` such a file loads.
//
// They are separate lists, they reach `state.json` under separate keys (`documents` and `assets`),
// and neither is ever the other. Recorded rather than renamed: both names are in the v1 `state.json`
// contract.

// One document entry, from a repository-relative `.md` path and its text — real, on disk, or
// generated (M5's registers, below). The URL/permalink formula is the single thing that must
// never diverge between the two: `docs/x/y.md` becomes `/docs/x/y/`, because that is precisely
// what `src/markdown.mjs` rewrites a relative `y.md` link to, and a generated document that used
// a different formula would be a cross-reference nothing else in the corpus could resolve.
function documentFromMarkdown(source, relative, text) {
  const withoutExtension = relative.replace(/\.md$/, '');
  const anchors = headingAnchors(text);
  return {
    source,
    path: relative,
    url: `/${encodeUrlPath(withoutExtension)}/`,
    permalink: `/${withoutExtension}/index.html`,
    // Decision 15: the file is the authority, so its own first heading names it. Only when a
    // record carries no heading at all does the filename stand in.
    title: anchors.find((anchor) => anchor.level === 1)?.text.trim() || path.basename(withoutExtension),
    hrefBase: path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative),
    text,
    anchors,
  };
}

// A question register (M5, decision 51): `docs/features/<slug>/register.json`, optional. Present
// ones generate their own markdown document as build output — decision 3 applied to a register —
// and are folded into the same `documents` collection every other rendered `.md` file goes
// through, so a register's page is indistinguishable in the pipeline from any other document.
function loadRegister(projectRoot, slug) {
  const registerPath = path.join(projectRoot, DOCS_DIRNAME, 'features', slug, REGISTER_FILENAME);
  if (!existsSync(registerPath)) return null;
  const raw = JSON.parse(readFileSync(registerPath, 'utf8'));
  const result = validateRegister(raw);
  if (!result.ok) {
    throw new Error(
      `atlas: ${relPath(projectRoot, registerPath)} is not a valid register:\n` +
        result.errors.map((e) => `  ${e.path || '(root)'}: ${e.message}`).join('\n'),
    );
  }
  return result.value;
}

// The Markdown records: the roadmap, everything under `docs/` (decision 40), and every
// workstream's register document, generated rather than read (M5). A record renders at the URL
// its own path implies — see `documentFromMarkdown` above.
function collectDocuments(projectRoot, slugs = []) {
  // The roadmap first, then the corpus. Its presence is not re-tested here: `assertRoadmapExists`
  // has already thrown if it is missing, and a second check would read as though it might not have.
  const sources = [
    path.join(projectRoot, ROADMAP),
    ...filesUnder(path.join(projectRoot, DOCS_DIRNAME)).filter((file) => file.endsWith('.md')),
  ];

  const documents = sources.map((source) => {
    const relative = relPath(projectRoot, source);
    return documentFromMarkdown(source, relative, readFileSync(source, 'utf8'));
  });

  for (const slug of slugs) {
    const register = loadRegister(projectRoot, slug);
    if (register === null) continue;
    const virtualPath = path.posix.join(DOCS_DIRNAME, 'features', slug, 'register.md');
    const doc = documentFromMarkdown(null, virtualPath, renderRegisterMarkdown(register));
    // The write-ins section (Task 3, register.njk) links down to each question's full entry.
    // `headingAnchors` already computed the real id markdown-it assigned each `### Q<n> ·
    // <severity>` heading (NOT the clean `#q1` an earlier draft of this plan assumed — a real
    // heading like "Q1 · BLOCKING" slugifies to `q1-blocking`, severity included) — reused here by
    // position (the H1 title is anchors[0], then one heading per question in register order)
    // rather than re-deriving a second slug algorithm that could drift from markdown-it's own.
    doc.register = {
      ...register,
      questions: register.questions.map((q, i) => ({ ...q, anchorId: doc.anchors[i + 1]?.id })),
    };
    // Decision 15's "the path is where the record itself lives" doesn't hold here — `doc.path` is
    // build output, not a file the project ships. `generatedFrom` names the real, hand-edited file
    // it was rendered from, so state.mjs has something true to tell an agent that goes looking for
    // this record on disk.
    doc.generatedFrom = path.posix.join(DOCS_DIRNAME, 'features', slug, REGISTER_FILENAME);
    documents.push(doc);
  }

  return documents;
}

// Task 4: one entry per workstream that has a register of either kind, sorted structured-first
// (most open questions first — the one an owner most needs to look at), legacy-prose after
// (alphabetically by codename, since there is no open count to sort a prose register by).
function buildRegisterIndex(projectRoot, resolved, documents) {
  const entries = [];
  for (const stream of resolved) {
    const virtualPath = path.posix.join(DOCS_DIRNAME, 'features', stream.slug, 'register.md');
    const structuredDoc = documents.find((d) => d.path === virtualPath);
    if (structuredDoc) {
      const openCount = structuredDoc.register.questions.filter((q) => q.chosen.kind === 'deferred').length;
      entries.push({
        slug: stream.slug,
        codename: stream.manifest.codename,
        kind: 'structured',
        title: structuredDoc.register.title,
        url: structuredDoc.url,
        openCount,
      });
      continue;
    }
    const legacyRelative = path.posix.join(DOCS_DIRNAME, 'features', stream.slug, 'open-questions.md');
    const legacyDoc = documents.find((d) => d.path === legacyRelative);
    if (legacyDoc) {
      entries.push({
        slug: stream.slug,
        codename: stream.manifest.codename,
        kind: 'legacy',
        title: legacyDoc.title,
        url: legacyDoc.url,
        openCount: null,
      });
    }
    // Neither register.json nor open-questions.md: this workstream has no register at all, and is
    // absent from the index entirely — decision 3 again, an index cannot list what was not found.
  }

  const structured = entries.filter((e) => e.kind === 'structured').sort((a, b) => b.openCount - a.openCount);
  const legacy = entries
    .filter((e) => e.kind === 'legacy')
    .sort((a, b) => (a.codename < b.codename ? -1 : a.codename > b.codename ? 1 : 0));
  return [...structured, ...legacy];
}

// Decision 10: the standalone documents under `docs/` — thirty-two of them in the real corpus, ten
// loading a sibling `support.js` — and any other file they need. Copied verbatim to the same
// relative location, so a link written for the repository still resolves on the site.
//
// Two kinds, distinguished by `isDocument`, because they are read by different readers. An `.html`
// file is a complete document somebody opens, and decision 10 exists for it; a `support.js`, a
// stylesheet or an image is something such a document *loads*, and is reached by the document
// rather than by a person. Only the first kind belongs in an index of records — listing the second
// would offer a reader a link to raw JavaScript, and in a real corpus would bury the documents
// under their own dependencies.
function collectAssets(projectRoot) {
  return filesUnder(path.join(projectRoot, DOCS_DIRNAME))
    .filter(
      (file) =>
        !file.endsWith('.md') &&
        path.basename(file) !== MANIFEST_FILENAME &&
        path.basename(file) !== REGISTER_FILENAME,
    )
    .map((source) => {
      const relative = relPath(projectRoot, source);
      return {
        source,
        path: relative,
        url: `/${encodeUrlPath(relative)}`,
        // Deliberately just HTML. Decision 10 is about the thirty-two `.html` files under `docs/`,
        // and this is what separates them from the `support.js` files ten of them load.
        //
        // KNOWN LIMIT: a standalone document that is not HTML — a PDF, most plausibly — is copied
        // and served, but is not listed in the records index, which makes it exactly the kind of
        // orphan the index exists to prevent. Nothing in this project's corpus is one today. If
        // one appears, this predicate is the single line to widen, and the orphan test will not
        // catch the omission for you, because it takes its expectation from this same flag.
        isDocument: /\.html?$/i.test(relative),
      };
    });
}

// A git blob SHA-1 — the same value `git hash-object` (and GitHub's contents API `sha` field)
// computes for a file's exact bytes: `sha1("blob " + <byte length> + "\0" + <content>)`. Exported
// so a test can check it against a real `git hash-object` invocation as ground truth, not just a
// hard-coded constant.
//
// Why this exists (M8 task 7 fix round): `theme/deploy.js` used to fetch this value from GitHub's
// public, unauthenticated contents API at click time. Every real Atlas project lives in a private
// repository (decision 7), so that GET 404s every time and `currentSha` always resolved to `null`
// — the round-trip bought nothing but latency. The build already reads the deployment log's exact
// bytes off disk to compute `displayedStage`/`deploymentHistory` below; computing the blob SHA
// from those same bytes, once, at build time, is the value a client-side GET was only ever trying
// to approximate — and unlike the GET, it actually works against a private repository.
//
// @param {string} content - the file's exact text, as read from disk (not re-serialised).
// @returns {string} the 40-character hex blob SHA.
export function gitBlobSha(content) {
  const body = Buffer.from(content, 'utf8');
  const header = Buffer.from(`blob ${body.length}\0`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, body])).digest('hex');
}

// A workstream's *displayed* stage, and the deployment history it was read from — the fix for
// "chip says Shipping, feature is really in dev". `manifest.stage` is the manifest's own,
// possibly-stale word for where a workstream stands; a deployment log, when the workstream has
// one, is the record of what has actually gone out, and its latest entry is what a reader should
// see on the chip. Computed once, here, the same way `triage` is computed from `classifyTriage`
// rather than read off the manifest, so every surface agrees.
//
// Also returns `deploymentLogSha` (M8 task 7 fix round) — the log file's own git blob SHA, `null`
// when there is no log yet (nothing on disk to hash). This is what `depth.njk` renders onto the
// trigger buttons' wrapper, and what `theme/deploy.js` sends back with a transition request
// instead of fetching a SHA from GitHub client-side — see `gitBlobSha`'s own header above.
//
// A workstream that names no `deploymentLog`, or one that has not been written to yet, has
// nothing to override with — this is the normal, unremarkable state of a workstream that has not
// started deploying, not a broken reference, so it is the one file read in this generator that is
// tolerant of a missing file in total silence (contrast `fetchProjectIssues`, which warns when
// GitHub is unreachable: that is a real failure to reach something that should be there; a log
// nobody has written yet is not). A file that IS there and is not valid JSON is a different thing
// — a broken record — and fails the build by decision 32, naming the path, the same as every other
// broken reference here.
function readDeploymentLog(projectRoot, stream) {
  const displayedStage = stream.manifest.stage;

  if (!stream.manifest.deploymentLog) {
    return { displayedStage, deploymentHistory: [], deploymentLogSha: null };
  }

  const absolute = path.join(projectRoot, stream.manifest.deploymentLog);
  if (!existsSync(absolute)) {
    return { displayedStage, deploymentHistory: [], deploymentLogSha: null };
  }

  const where = relPath(projectRoot, absolute);
  const raw = readFileSync(absolute, 'utf8');
  let deploymentHistory;
  try {
    deploymentHistory = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${relPath(projectRoot, stream.manifestPath)}: workstream "${stream.manifest.codename}" names ` +
        `deploymentLog "${stream.manifest.deploymentLog}", but ${where} is not valid JSON ` +
        `(${error.message}).`,
    );
  }
  if (!Array.isArray(deploymentHistory)) {
    throw new Error(
      `${relPath(projectRoot, stream.manifestPath)}: workstream "${stream.manifest.codename}" names ` +
        `deploymentLog "${stream.manifest.deploymentLog}", but ${where}'s content is not a JSON array ` +
        `of transitions.`,
    );
  }

  // Decision 32's closed vocabulary, enforced on the way in rather than trusted. A hand-edited or
  // corrupted log entry (an arbitrary string, or one missing "stage" entirely — e.g. a truncated
  // `{}` as the final write) would otherwise reach `displayedStage` unvalidated, and from there
  // `state.json` and the rendered chip's CSS class/`data-stage` attribute — the exact thing every
  // other broken reference in this generator is held to account for by name, not rendered.
  for (const entry of deploymentHistory) {
    const stageValue =
      entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry.stage : undefined;
    if (!DEPLOYMENT_STAGES.includes(stageValue)) {
      throw new Error(
        `${relPath(projectRoot, stream.manifestPath)}: workstream "${stream.manifest.codename}" names ` +
          `deploymentLog "${stream.manifest.deploymentLog}", but ${where} contains an entry whose "stage" ` +
          `is ${JSON.stringify(stageValue)}, not one of: ${DEPLOYMENT_STAGES.join(', ')}.`,
      );
    }
  }

  const latest = deploymentHistory.at(-1);
  return {
    displayedStage: latest ? latest.stage : displayedStage,
    deploymentHistory,
    deploymentLogSha: gitBlobSha(raw),
  };
}

// --- the model both the pages and state.json are made from ---------------------------------------

// One model, assembled once. The pages render from it and `buildState` projects it, so the
// agent-facing output cannot drift from the human-facing one — they are not two derivations of the
// same data, they are one.
//
// Exported (only) so a test can inspect a computed, not-yet-templated field — `displayedStage`
// and `deploymentHistory` as of M8 task 6 — directly, the same way `triage.mjs` and `depth.mjs`
// are unit-tested against their own inputs rather than only through rendered HTML or state.json.
export async function assembleSite(projectRoot, { fetchImpl, token, offline }) {
  const config = loadConfig(projectRoot);

  assertRoadmapExists(config.projectRoot);

  // Throws on an unknown status, a missing `next`, a milestone with no title — the closed
  // vocabularies and required fields of `src/schema.mjs` (decision 32).
  const resolved = resolveWorkstreams(config);
  assertPlansExist(config.projectRoot, resolved);

  // The manifest paths travel with the ladder so that a broken column names a file rather than
  // just a codename — the same convention every other failure in this generator follows.
  const ladder = assertLadderResolves(
    computeLadder(resolved),
    resolved.map((stream) => relPath(config.projectRoot, stream.manifestPath)),
  );

  // The one tolerated failure in the whole generator (decision 32's stated exception). `offline`
  // does not tolerate a failure — it declines to make the request at all, which is what a test,
  // and a build of a project with no GitHub, both want.
  const issues = offline
    ? emptyBuckets()
    : await fetchProjectIssues({ repo: config.repo, token, fetchImpl });

  // Every milestone's own linked issue, regardless of open/closed state — `fetchProjectIssues`
  // above only ever sees OPEN issues, so a `done` milestone's (almost always closed) issue would
  // never arrive through it. Collected across every workstream so this is one call, not one per
  // milestone rendered.
  const milestoneIssueNumbers = resolved.flatMap((stream) =>
    stream.manifest.milestones.map((m) => m.issue).filter((n) => n !== null),
  );
  const taskBodies = offline
    ? new Map()
    : await fetchIssueBodies({ repo: config.repo, issueNumbers: milestoneIssueNumbers, token, fetchImpl });

  // The records first, so a milestone can link its plan and its acceptance record to the pages
  // this same build renders for them, rather than leaving them as text nobody can follow.
  const documents = collectDocuments(config.projectRoot, resolved.map((stream) => stream.slug));
  const documentUrlByPath = new Map(documents.map((doc) => [doc.path, doc.url]));

  // Task 4: the registers index. Built from the discovered set directly (no hand-maintained list
  // anywhere) — a structured register (register.json present) shows its real open count; a
  // legacy-prose one (a workstream's open-questions.md, and any register not yet migrated — Task 6's
  // stated cost) shows a plain link with none, since nothing parses its open count from prose.
  const registerIndex = buildRegisterIndex(config.projectRoot, resolved, documents);

  const unclassified = resolved.map((stream, index) => {
    const relDir = relPath(config.projectRoot, stream.dir);
    const { displayedStage, deploymentHistory, deploymentLogSha } = readDeploymentLog(config.projectRoot, stream);

    // `computeLadder` (src/depth.mjs) already ran, above, against the raw `manifest.stage` — and
    // `classifyTriage` (src/triage.mjs), below, is about to. Threading `displayedStage` through
    // both is a bigger structural change than this fix deserves; the cheap version is to make the
    // raw value impossible to be stale in the one window that matters. A deployment log with real
    // entries IS evidence the workstream has left the pre-development stages, so a manifest that
    // still claims `not-started` or `designing` at that point is a stale record, not a fact any
    // surface should render — the ladder, the triage order, the chip and state.json would
    // otherwise disagree about the same workstream, the #780 "two surfaces disagree" failure class.
    if (deploymentHistory.length > 0 && (stream.manifest.stage === 'not-started' || stream.manifest.stage === 'designing')) {
      throw new Error(
        `${relPath(config.projectRoot, stream.manifestPath)}: workstream "${stream.manifest.codename}" has a ` +
          `deployment log with ${deploymentHistory.length} entr${deploymentHistory.length === 1 ? 'y' : 'ies'}, ` +
          `but its manifest "stage" is still "${stream.manifest.stage}" — a deployment log with entries is ` +
          `evidence the workstream has left the pre-development stages, so the manifest is a stale record and ` +
          `must be corrected by hand before the build can trust it.`,
      );
    }

    return {
      ...stream,
      relDir,
      relManifestPath: relPath(config.projectRoot, stream.manifestPath),
      url: workstreamUrl(stream.slug),
      column: ladder.columns[index],
      issues: issues.byLabel.get(stream.manifest.label) ?? [],
      // Decision 32's "fail loudly" exception carve-out, and the fix for "chip says Shipping,
      // feature is really in dev": see `readDeploymentLog` above.
      displayedStage,
      deploymentHistory,
      // The log's own build-time git blob SHA, or `null` when there is no log yet. Rendered onto
      // `.stage-trigger`'s `data-sha` in `depth.njk`; `theme/deploy.js` reads it from there instead
      // of fetching it from GitHub client-side (M8 task 7 fix round — see `gitBlobSha`'s header).
      deploymentLogSha,
      milestones: stream.manifest.milestones.map((milestone) => {
        const planPath = `${relDir}/${milestone.plan}`;
        const segment = milestone.id.toLowerCase();
        // `fetchIssueBodies` maps a milestone's own issue to `{ body, assignees }`, or `null` when
        // the fetch itself failed (offline, network error, 404) — never split into two lookups,
        // since both come from the one issue fetch M6 reused rather than doubling the request.
        const issueData = milestone.issue !== null ? taskBodies.get(milestone.issue) ?? null : null;
        return {
          manifest: {
            ...milestone,
            // Computed only, never written back (design doc: "Data model summary" — this is not
            // a schema field, it is attached here the same way `url`/`planUrl` already are).
            tasks: parseTasks(issueData?.body ?? null),
            // Real GitHub assignees on the milestone's own issue (M6: "people are assignees" —
            // the human half; the model-owner tag inside each task line is unrelated and unchanged).
            assignees: issueData?.assignees ?? [],
          },
          url: milestoneUrl(stream.slug, milestone.id),
          permalink: `/workstream/${stream.slug}/${segment}/index.html`,
          planPath,
          planSource: path.join(stream.dir, milestone.plan),
          // The plan's own record page. `assertPlansExist` has already proved the file is there,
          // and every `.md` under docs/ is rendered, so this always resolves.
          planUrl: documentUrlByPath.get(planPath) ?? null,
          // Decision 14's `acceptance.record` is a repository path. When it names a record this
          // build rendered, the page links to it; when it names something else — or nothing —
          // the page still states it, unlinked, rather than dropping it on the floor.
          recordUrl: milestone.acceptance.record
            ? documentUrlByPath.get(milestone.acceptance.record) ?? null
            : null,
          hrefBase: relDir,
        };
      }),
      spineDetail: spineDetail(stream.manifest.milestones),
    };
  });

  // Decision 27's order, decided by ONE call to src/triage.mjs. The per-workstream state is read
  // back out of that call's result rather than classified a second time, so there is exactly one
  // place the mapping is applied.
  const triaged = orderByTriage(unclassified);
  const triageBySlug = new Map(triaged.map((stream) => [stream.slug, stream.triage]));

  const workstreams = unclassified.map((stream) => ({
    ...stream,
    // Carried on the workstream as well as in the ordered list, so an agent reading one workstream
    // out of state.json does not have to cross-reference the other.
    triage: triageBySlug.get(stream.slug),
  }));

  return {
    project: config.project,
    repo: config.repo,
    projectRoot: config.projectRoot,
    workstreams,
    ladder,
    // Used by both the phone view and state.json, from the single `orderByTriage` call above.
    triaged,
    issues,
    documents,
    registerIndex,
    assets: collectAssets(config.projectRoot),
    // #780's task 12: the other half of decision 32. A config naming a directory that is not there
    // already fails the build; a feature that has been WRITTEN and never put on the sheet was
    // silent, and that is the same failure shape as a hidden feature nobody can find. Reported,
    // never thrown — `unnamedFeatureDirs` carries the reason that line is where it is.
    unnamedFeatures: unnamedFeatureDirs(config),
  };
}

// --- the pages -------------------------------------------------------------------------------------

// The records index, grouped by the directory each file lives in — the repository's own shape,
// which is the only grouping Atlas is entitled to invent.
//
// BOTH kinds of record, because a reader cannot reach what is not listed and the distinction
// between them is invisible from the outside: the Markdown records Atlas renders (decision 15),
// and the standalone documents it copies byte-for-byte and never templates (decision 10). In this
// project's real corpus the second kind is thirty-two files, which is the whole reason decision 10
// exists — listing only the first kind leaves all thirty-two reachable by luck or not at all.
//
// Entries carry `kind` so the page can say which is which. Group order follows the repository
// path; within a group the two kinds are interleaved in path order, because a reader looking for
// a file knows where it lives, not how Atlas chose to put it on the site.
function groupRecordsByDirectory(documents, assets) {
  const entries = [
    ...documents.map((doc) => ({ title: doc.title, path: doc.path, url: doc.url, kind: 'rendered' })),
    // Only the copied files that are documents in their own right. The files those documents load
    // — `support.js` and its like — are reached through the document, not by a reader, and an
    // index that offered a link to raw JavaScript would be worse than one that did not.
    //
    // A copied document has no heading for Atlas to read, because Atlas never parses it, so its
    // file name is its name. Anything else would be Atlas inventing a title for a file it does not
    // render, which is the opposite of decision 2.
    ...assets
      .filter((asset) => asset.isDocument)
      .map((asset) => ({
        title: path.posix.basename(asset.path),
        path: asset.path,
        url: asset.url,
        kind: 'copied',
      })),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const groups = new Map();
  for (const entry of entries) {
    const dirname = path.posix.dirname(entry.path);
    const dir = dirname === '.' ? '/' : `${dirname}/`;
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(entry);
  }

  return [...groups].map(([dir, grouped]) => ({ dir, entries: grouped }));
}

// Every page as { input, content, data }. `input` is a virtual path inside the generator's theme
// directory that no file occupies; `data.permalink` alone decides where the page is written.
function planPages(site) {
  const shell = { project: site.project, repo: site.repo };
  const pages = [];

  pages.push({
    name: 'depth',
    extend: 'depth.njk',
    data: {
      ...shell,
      permalink: '/index.html',
      title: 'Feature planning',
      workstreams: site.workstreams,
    },
  });

  pages.push({
    name: 'mobile',
    extend: 'mobile.njk',
    data: { ...shell, permalink: '/mobile/index.html', title: 'What needs you', triaged: site.triaged },
  });

  for (const stream of site.workstreams) {
    pages.push({
      name: `workstream-${stream.slug}`,
      extend: 'workstream.njk',
      data: {
        ...shell,
        permalink: `/workstream/${stream.slug}/index.html`,
        title: stream.manifest.codename,
        workstream: stream,
        issues: stream.issues,
      },
    });

    for (const milestone of stream.milestones) {
      const plan = readFileSync(milestone.planSource, 'utf8');
      pages.push({
        name: `milestone-${stream.slug}-${milestone.manifest.id.toLowerCase()}`,
        extend: 'milestone.njk',
        data: {
          ...shell,
          permalink: milestone.permalink,
          title: `${stream.manifest.codename} ${milestone.manifest.label}`,
          workstream: stream,
          milestone: milestone.manifest,
          planUrl: milestone.planUrl,
          recordUrl: milestone.recordUrl,
          // Decision 11: rendered by src/markdown.mjs, as GitHub renders it. Named `record` and
          // not `content`, which Eleventy reserves — see `.eleventy.js`.
          record: renderMarkdown(plan, { hrefBase: milestone.hrefBase }),
          anchors: headingAnchors(plan),
        },
      });
    }
  }

  // The way into the records. Without it the roadmap and the design authorities render at URLs
  // nothing links to: the pages exist, so nothing looks broken, and no reader can reach them.
  // Generated from the very list the record pages are rendered from (decision 3), so it cannot
  // list a page that was not written or omit one that was.
  pages.push({
    name: 'library',
    extend: 'library.njk',
    data: {
      ...shell,
      permalink: '/library/index.html',
      title: 'Library',
      groups: groupRecordsByDirectory(site.documents, site.assets),
    },
  });

  // Task 4: the registers index, absent entirely when no workstream has a register of either
  // kind — an empty page nobody would ever reach is not better than no page.
  if (site.registerIndex.length > 0) {
    pages.push({
      name: 'registers',
      extend: 'registers-index.njk',
      data: {
        ...shell,
        permalink: '/registers/index.html',
        title: 'Registers',
        registers: site.registerIndex,
      },
    });
  }

  for (const doc of site.documents) {
    // A register (M5) renders through its own purpose-built template — "surfaced as a group"
    // needs real layout over the structured question data, not a heading grep over rendered
    // markdown, which is what every other document gets.
    if (doc.register) {
      pages.push({
        name: `document-${doc.path.replace(/[^a-zA-Z0-9]+/g, '-')}`,
        extend: 'register.njk',
        data: {
          ...shell,
          permalink: doc.permalink,
          title: doc.title,
          doc: { title: doc.title, path: doc.path },
          register: doc.register,
          // Decision 11: a record's own heading, not one Atlas re-prints — the same rule
          // document.njk follows for every other document. doc.anchors[0] is the title's real,
          // markdown-it-assigned id (the same one a reader following the generated document's own
          // contents list would land on), computed once by documentFromMarkdown above and reused
          // here rather than the template inventing a plain, id-less <h1>.
          titleAnchorId: doc.anchors[0]?.id,
        },
      });
      continue;
    }
    pages.push({
      name: `document-${doc.path.replace(/[^a-zA-Z0-9]+/g, '-')}`,
      extend: 'document.njk',
      data: {
        ...shell,
        permalink: doc.permalink,
        title: doc.title,
        doc: { title: doc.title, path: doc.path },
        // Named `record` and not `content`, which Eleventy reserves — see `.eleventy.js`.
        record: renderMarkdown(doc.text, { hrefBase: doc.hrefBase }),
        anchors: doc.anchors,
      },
    });
  }

  // The virtual input path is derived from the page's position in this list as well as its name,
  // so it is stable between builds and unique even if two records normalise to the same name.
  return pages.map((page, index) => ({
    input: `@pages/${String(index).padStart(4, '0')}-${page.name}.njk`,
    content: `{% extends "${page.extend}" %}`,
    data: page.data,
  }));
}

async function renderPages(pages, outDir, { quiet }) {
  const eleventy = new Eleventy(THEME_DIR, outDir, {
    // The generator's own `.eleventy.js` is applied below, explicitly. Auto-discovery would pick
    // up whatever config happened to sit in the current working directory, which for a generator
    // consumed as a composite action (decision 39) is the consuming project's directory.
    configPath: false,
    quietMode: quiet,
    config(eleventyConfig) {
      configureAtlasEleventy(eleventyConfig);
      for (const page of pages) {
        eleventyConfig.addTemplate(page.input, page.content, page.data);
      }
    },
  });

  // `quietMode` alone is not enough. Eleventy's completion line — `[11ty] Wrote N files` — is
  // logged with `force: true`, which is documented to bypass verbose mode, so a `--quiet` build
  // still printed it. `disableLogger()` is the switch that reaches it: it replaces the logger
  // itself, and `force` cannot bypass a logger that is not there. Errors are unaffected — they
  // travel by exception, not through this logger.
  if (quiet) eleventy.disableLogger();

  await eleventy.write();
}

// --- the build ---------------------------------------------------------------------------------------

/**
 * Build a project repository into a static site.
 *
 * The whole site is written to a staging directory beside `outDir` and swapped into place only
 * once every page has rendered. So `outDir` is either the previous build or this one, never a
 * half-built mixture: a build that fails leaves whatever was already published exactly as it was.
 * The staging directory is removed either way.
 *
 * @param {string} projectRoot - a directory following the Atlas convention (decision 40).
 * @param {string} outDir - where the site is written. **Replaced wholesale** on success, so a page
 *   whose record was deleted does not survive the rebuild. Must not overlap the project or the
 *   generator in either direction.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] - injected so the build is testable with no network.
 * @param {string} [options.token] - a GitHub token; without one the request is unauthenticated.
 * @param {boolean} [options.offline] - skip GitHub entirely rather than attempt and tolerate.
 * @param {boolean} [options.quiet] - suppress Eleventy's own progress output.
 * @returns {Promise<{ outDir: string, pages: number, assets: number, state: object }>}
 * @throws {Error} on any broken reference in the project (decision 32), or on any render failure.
 *   `outDir` is untouched when it throws.
 */
export async function build(projectRoot, outDir, options = {}) {
  const { fetchImpl, token, offline = false, quiet = false } = options;

  const root = path.resolve(projectRoot);
  const out = path.resolve(outDir);
  // Both destructive paths, before anything is read: the output directory and the staging
  // directory beside it. See src/outdir.mjs — this is the only call site.
  assertOutputDirIsSafe(root, out, GENERATOR_ROOT);
  assertStagingDirIsFree(out);

  // Everything the project can get wrong, fails here — before a single byte is written anywhere.
  const site = await assembleSite(root, { fetchImpl, token, offline });
  const pages = planPages(site);
  const state = buildState(site);

  // A sibling of the output directory, so the swap below is a rename within one filesystem rather
  // than a copy across two. Created by src/outdir.mjs, which claims it with a non-recursive
  // `mkdir` — the filesystem's own atomic test-and-set. The check above runs before the project is
  // read, so a leftover staging directory is reported immediately; this is what makes the answer
  // still correct when a second build arrives in the meantime. Throwing here happens BEFORE the
  // `try` below, so a build that loses the race removes nothing.
  const staging = createStagingDir(out);

  try {
    // Decision 10, and the reason it cannot break: copyFileSync, from a list Eleventy never sees.
    for (const asset of site.assets) {
      const destination = path.join(staging, asset.path);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(asset.source, destination);
    }

    // The theme's own files, at the paths the layouts link to.
    for (const file of THEME_FILES) {
      copyFileSync(path.join(THEME_DIR, file), path.join(staging, file));
    }

    await renderPages(pages, staging, { quiet });

    writeFileSync(path.join(staging, 'state.json'), serialiseState(state), 'utf8');

    // Decision 7: nothing on an Atlas site is anonymous. Emitted rather than left to each project,
    // because the failure mode this closes is a project that does NOTHING — M1 shipped no
    // configuration at all, so a project adopting Atlas got a public site by default while the one
    // live site was gated by a file its own workflow copied in. A project that needs a different
    // identity provider still overwrites this after the build; a project that does nothing is
    // now gated instead of open. See src/swa.mjs.
    writeFileSync(path.join(staging, SWA_CONFIG_FILENAME), serialiseSwaConfig(), 'utf8');

    // Only now is anything already published at risk, and only for the moment between these two
    // calls. Before this line a failure costs nothing; a page that did not render cannot take the
    // previous build down with it.
    rmSync(out, { recursive: true, force: true });
    mkdirSync(path.dirname(out), { recursive: true });
    renameSync(staging, out);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  return {
    outDir: out,
    pages: pages.length,
    assets: site.assets.length,
    state,
    // Carried out of the build rather than printed from inside it, so a caller that is not the
    // command line — a test, or another tool — gets the finding rather than a line of somebody
    // else's stdout.
    unnamedFeatures: site.unnamedFeatures,
  };
}

// --- the command line ----------------------------------------------------------------------------------

const KNOWN_FLAGS = ['--offline', '--quiet'];

// An unrecognised flag is a broken reference of its own kind: `--offlien` would otherwise build
// online without a word, in a generator whose whole ethos is decision 32. It fails rather than
// guesses.
function parseArgv(argv) {
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const flags = argv.filter((arg) => arg.startsWith('--'));

  const unknown = flags.filter((flag) => !KNOWN_FLAGS.includes(flag));
  if (unknown.length > 0) {
    throw new Error(
      `unknown option${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} — this build accepts ${KNOWN_FLAGS.join(' and ')}`,
    );
  }

  return {
    projectRoot: positional[0],
    outDir: positional[1] ?? '.atlas-out',
    offline: flags.includes('--offline'),
    quiet: flags.includes('--quiet'),
  };
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    console.error(`atlas: ${error.message}`);
    return 2;
  }

  const { projectRoot, outDir, offline, quiet } = parsed;

  if (!projectRoot) {
    console.error('atlas: usage: node src/build.mjs <project-root> [<out-dir>] [--offline] [--quiet]');
    return 2;
  }

  try {
    const result = await build(projectRoot, outDir, {
      offline,
      quiet,
      token: process.env.GITHUB_TOKEN || undefined,
    });
    console.log(
      `atlas: built ${result.pages} pages and copied ${result.assets} files into ${path.relative(process.cwd(), result.outDir) || '.'}`,
    );

    // NOT suppressed by --quiet. That flag suppresses Eleventy's progress, and a finding is not
    // progress. It names the exact edit that closes it, because a warning a reader has to go and
    // work out is a warning they will read twice and act on once.
    for (const slug of result.unnamedFeatures) {
      console.error(
        `atlas: warning: docs/features/${slug}/ exists but atlas.config.json does not name it, so ` +
          `this feature is not on the sheet. Add "${slug}" to the "workstreams" list to promote it, ` +
          `or delete the directory if the idea was abandoned.`,
      );
    }
    return 0;
  } catch (error) {
    // Decision 32: loudly, and non-zero, naming what is broken. A documentation merge that breaks
    // a reference must fail the workflow rather than publish a blank cell.
    console.error(`atlas: build failed — ${error.message}`);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
