#!/usr/bin/env node
// The build: a project repository in, a static site out (decisions 1, 3, 9, 12).
//
// Everything above this module computes one thing well. This one wires them into a program, and
// it is where the milestone's two structural rules are enforced rather than described:
//
//   * **Decision 32 — fail loudly.** A manifest pointing at a plan that does not exist, a status
//     outside the closed vocabulary, a workstream with no gate: each aborts the build, non-zero,
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

import { loadConfig, resolveWorkstreams } from './config.mjs';
import { computeLadder, assertLadderResolves } from './depth.mjs';
import { fetchProjectIssues } from './github.mjs';
import { headingAnchors, renderMarkdown } from './markdown.mjs';
import { buildState, serialiseState } from './state.mjs';
import { orderByTriage } from './triage.mjs';
import configureAtlasEleventy from '../.eleventy.js';

const GENERATOR_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THEME_DIR = path.join(GENERATOR_ROOT, 'theme');
const STYLESHEET = 'tokens.css';

// Decision 40: the fixed convention a project provides, and nothing else.
const ROADMAP = 'ROADMAP.md';
const DOCS_DIRNAME = 'docs';
const MANIFEST_FILENAME = 'workstream.json';

// --- paths ---------------------------------------------------------------------------------------

// A repository-relative, slash-separated path. Nothing that reaches an output file is ever built
// any other way: an absolute path from the build machine in a generated file is both useless to a
// reader and the most common reason a rebuild stops being reproducible.
function relPath(projectRoot, absolute) {
  return path.relative(projectRoot, absolute).split(path.sep).join('/');
}

// A site URL for a repository-relative path, with each segment encoded but the slashes left alone.
function encodeUrlPath(relative) {
  return relative.split('/').map(encodeURIComponent).join('/');
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

      if (!existsSync(absolute) || !statSync(absolute).isFile()) {
        throw new Error(
          `${relPath(projectRoot, stream.manifestPath)}: workstream "${stream.manifest.codename}" ` +
            `milestone ${milestone.id} names plan "${milestone.plan}", but there is no file at ` +
            `${relPath(projectRoot, absolute)}. Either the plan was moved and the manifest was not ` +
            `updated, or the manifest is ahead of the record (decisions 1, 32).`,
        );
      }
    }
  }
}

function assertRoadmapExists(projectRoot) {
  const absolute = path.join(projectRoot, ROADMAP);
  if (!existsSync(absolute)) {
    throw new Error(
      `${ROADMAP} is missing: a project Atlas builds provides ${ROADMAP} at its root (decision 40), ` +
        `and decision 16 makes its tables generated output rather than prose.`,
    );
  }
}

// The output directory is replaced wholesale by every build, so a page whose record was deleted
// does not live on forever. That is a destructive act on a path a caller supplied, so it refuses
// any output directory that overlaps the project or the generator **in either direction**.
//
// Both directions matter, and only one of them is obvious. `atlas <project> /` would delete the
// project, which is easy to picture. `atlas <project> <project>/docs` is the one that actually
// happens — someone building "into the docs folder" — and it deletes every record in the
// repository before failing anyway, because the records it was about to render are the files it
// just removed.
function assertOutputDirIsSafe(projectRoot, outDir) {
  const contains = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);

  // Nothing the build reads may sit inside what the build replaces. That is one rule, and it has
  // to be checked in both directions.
  const readsFrom = [
    [projectRoot, 'the project'],
    // Not the whole generator repository: building into `<generator>/.out` is the ordinary case
    // and must keep working. What the build actually reads from the generator is the theme.
    [THEME_DIR, "Atlas's own theme"],
  ];

  for (const [root, name] of readsFrom) {
    if (outDir === root) {
      throw new Error(
        `refusing to build into ${outDir}: that is ${name}, and the build replaces its output directory`,
      );
    }
    // The obvious direction: `atlas <project> /` would take the project with it.
    if (contains(outDir, root)) {
      throw new Error(
        `refusing to build into ${outDir}: it contains ${name} (${root}), and the build replaces its output directory`,
      );
    }
    // The direction that actually happens: someone builds "into the docs folder", and every
    // record the build was about to render is deleted first.
    if (contains(root, outDir)) {
      throw new Error(
        `refusing to build into ${outDir}: it is inside ${name} (${root}), and the build replaces its ` +
          `output directory — every file under it would be deleted before it could be read`,
      );
    }
  }
}

// --- the project's records --------------------------------------------------------------------------

// The Markdown records: the roadmap, and everything under `docs/` (decision 40). A record renders
// at the URL its own path implies — `docs/x/y.md` becomes `/docs/x/y/` — because that is precisely
// what `src/markdown.mjs` rewrites a relative `y.md` link to. Render them anywhere else and every
// cross-reference in the corpus breaks.
function collectDocuments(projectRoot) {
  // The roadmap first, then the corpus. Its presence is not re-tested here: `assertRoadmapExists`
  // has already thrown if it is missing, and a second check would read as though it might not have.
  const sources = [
    path.join(projectRoot, ROADMAP),
    ...filesUnder(path.join(projectRoot, DOCS_DIRNAME)).filter((file) => file.endsWith('.md')),
  ];

  return sources.map((source) => {
    const relative = relPath(projectRoot, source);
    const withoutExtension = relative.replace(/\.md$/, '');
    const text = readFileSync(source, 'utf8');
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
  });
}

// Decision 10: the standalone documents under `docs/` — thirty-two of them in the real corpus, ten
// loading a sibling `support.js` — and any other file they need. Copied verbatim to the same
// relative location, so a link written for the repository still resolves on the site.
function collectAssets(projectRoot) {
  return filesUnder(path.join(projectRoot, DOCS_DIRNAME))
    .filter((file) => !file.endsWith('.md') && path.basename(file) !== MANIFEST_FILENAME)
    .map((source) => {
      const relative = relPath(projectRoot, source);
      return { source, path: relative, url: `/${encodeUrlPath(relative)}` };
    });
}

// --- the model both the pages and state.json are made from ---------------------------------------

// One model, assembled once. The pages render from it and `buildState` projects it, so the
// agent-facing output cannot drift from the human-facing one — they are not two derivations of the
// same data, they are one.
async function assembleSite(projectRoot, { fetchImpl, token, offline }) {
  const config = loadConfig(projectRoot);

  assertRoadmapExists(config.projectRoot);

  // Throws on an unknown status, a missing gate, a milestone with no title — the closed
  // vocabularies and required fields of `src/schema.mjs` (decision 32).
  const resolved = resolveWorkstreams(config);
  assertPlansExist(config.projectRoot, resolved);

  const ladder = assertLadderResolves(computeLadder(resolved));

  // The one tolerated failure in the whole generator (decision 32's stated exception). `offline`
  // does not tolerate a failure — it declines to make the request at all, which is what a test,
  // and a build of a project with no GitHub, both want.
  const issues = offline
    ? { byLabel: new Map(), unlabelled: [], prs: [] }
    : await fetchProjectIssues({ repo: config.repo, token, fetchImpl });

  // The records first, so a milestone can link its plan and its acceptance record to the pages
  // this same build renders for them, rather than leaving them as text nobody can follow.
  const documents = collectDocuments(config.projectRoot);
  const documentUrlByPath = new Map(documents.map((doc) => [doc.path, doc.url]));

  const unclassified = resolved.map((stream, index) => {
    const relDir = relPath(config.projectRoot, stream.dir);

    return {
      ...stream,
      relDir,
      relManifestPath: relPath(config.projectRoot, stream.manifestPath),
      url: `/workstream/${stream.slug}/`,
      column: ladder.columns[index],
      issues: issues.byLabel.get(stream.manifest.label) ?? [],
      milestones: stream.manifest.milestones.map((milestone) => {
        const planPath = `${relDir}/${milestone.plan}`;
        return {
          manifest: milestone,
          url: `/workstream/${stream.slug}/${milestone.id.toLowerCase()}/`,
          permalink: `/workstream/${stream.slug}/${milestone.id.toLowerCase()}/index.html`,
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
    assets: collectAssets(config.projectRoot),
  };
}

// --- the pages -------------------------------------------------------------------------------------

// The records index, grouped by the directory each record lives in — the repository's own shape,
// which is the only grouping Atlas is entitled to invent. Group order and record order both follow
// the already-sorted document list, so the page is stable between builds.
function groupRecordsByDirectory(documents) {
  const groups = new Map();

  for (const doc of documents) {
    const dirname = path.posix.dirname(doc.path);
    const dir = dirname === '.' ? '/' : `${dirname}/`;
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push({ title: doc.title, path: doc.path, url: doc.url });
  }

  return [...groups].map(([dir, records]) => ({ dir, records }));
}

// Every page as { input, content, data }. `input` is a virtual path inside the generator's theme
// directory that no file occupies; `data.permalink` alone decides where the page is written.
function planPages(site) {
  const shell = { project: site.project, repo: site.repo };
  const pages = [];

  pages.push({
    name: 'depth',
    extend: 'depth.njk',
    data: { ...shell, permalink: '/index.html', title: 'Project depth', workstreams: site.workstreams, ladder: site.ladder },
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
    name: 'records',
    extend: 'records.njk',
    data: {
      ...shell,
      permalink: '/records/index.html',
      title: 'Records',
      groups: groupRecordsByDirectory(site.documents),
    },
  });

  for (const doc of site.documents) {
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
  assertOutputDirIsSafe(root, out);

  // Everything the project can get wrong, fails here — before a single byte is written anywhere.
  const site = await assembleSite(root, { fetchImpl, token, offline });
  const pages = planPages(site);
  const state = buildState(site);

  // A sibling of the output directory, so the swap below is a rename within one filesystem rather
  // than a copy across two.
  const staging = `${out}.atlas-staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  try {
    // Decision 10, and the reason it cannot break: copyFileSync, from a list Eleventy never sees.
    for (const asset of site.assets) {
      const destination = path.join(staging, asset.path);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(asset.source, destination);
    }

    // The theme's own stylesheet, at the path every layout links to.
    copyFileSync(path.join(THEME_DIR, STYLESHEET), path.join(staging, STYLESHEET));

    await renderPages(pages, staging, { quiet });

    writeFileSync(path.join(staging, 'state.json'), serialiseState(state), 'utf8');

    // Only now is anything already published at risk, and only for the moment between these two
    // calls. Before this line a failure costs nothing; a page that did not render cannot take the
    // previous build down with it.
    rmSync(out, { recursive: true, force: true });
    mkdirSync(path.dirname(out), { recursive: true });
    renameSync(staging, out);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  return { outDir: out, pages: pages.length, assets: site.assets.length, state };
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
    console.error('usage: node src/build.mjs <project-root> [<out-dir>] [--offline] [--quiet]');
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
