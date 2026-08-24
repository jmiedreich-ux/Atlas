// A local CLI that ensures every workstream's declared `workstream:*` GitHub label actually
// exists on the repository (Atlas M6, task 1 — carried over unchanged from the old m6-plan.md,
// since M4.1 never touched this: `fetchProjectIssues` already buckets by this label if present,
// this script is the missing other half, making the label namespace real).
//
// Never invoked from the website or from write-back — the current write-back scope (decisions 34
// to 37, 58, 59) has no endpoint for this, and adding one would be its own decision, the same
// posture `src/scaffold.mjs`'s header states for scaffolding. This is a local tool, run against a
// real checkout, its effect (labels existing on GitHub) is not something a build produces.
//
// Deliberately does NOT auto-apply labels to existing unlabelled open issues: which workstream an
// unlabelled issue belongs to is a judgement call, not something inferable from the issue alone,
// and decision 1's "never maintained" cuts against a script guessing. It reports them instead, for
// a human to label by hand — the same caution `scaffold.mjs` applies to milestone content it
// cannot infer from a design's prose.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, resolveWorkstreams } from './config.mjs';

const GITHUB_API_ROOT = 'https://api.github.com';
const WORKSTREAM_LABEL_PREFIX = 'workstream:';
const LABEL_COLOR = '5319e7';

/**
 * @param {object} opts
 * @param {string} opts.repo - `owner/name`.
 * @param {string} opts.token - required; creating a label is a write, unlike every read elsewhere
 *   in this generator that tolerates an absent token.
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<boolean>} true if the label already existed, false if it had to be created.
 */
async function ensureLabel({ repo, name, token, fetchImpl = fetch }) {
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` };
  const getUrl = `${GITHUB_API_ROOT}/repos/${repo}/labels/${encodeURIComponent(name)}`;
  const existing = await fetchImpl(getUrl, { headers });
  if (existing.ok) return true;
  if (existing.status !== 404) {
    throw new Error(`checking label ${JSON.stringify(name)} failed: GitHub responded ${existing.status}`);
  }

  const createUrl = `${GITHUB_API_ROOT}/repos/${repo}/labels`;
  const created = await fetchImpl(createUrl, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, color: LABEL_COLOR, description: 'Atlas workstream label' }),
  });
  if (!created.ok) {
    throw new Error(`creating label ${JSON.stringify(name)} failed: GitHub responded ${created.status}`);
  }
  return false;
}

/**
 * Fetch every open issue's labels once, so unlabelled issues can be reported without a second
 * round of requests per workstream.
 */
async function fetchUnlabelledOpenIssues({ repo, token, fetchImpl = fetch }) {
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` };
  const url = `${GITHUB_API_ROOT}/repos/${repo}/issues?state=open&per_page=100`;
  const response = await fetchImpl(url, { headers });
  if (!response.ok) {
    throw new Error(`listing open issues failed: GitHub responded ${response.status}`);
  }
  const items = await response.json();
  return items
    .filter((item) => item.pull_request == null)
    .filter((item) => {
      const names = (item.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
      return !names.some((n) => n?.startsWith(WORKSTREAM_LABEL_PREFIX));
    })
    .map((item) => ({ number: item.number, title: item.title, url: item.html_url }));
}

/**
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {string} opts.token
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<{ repo: string, created: string[], alreadyExisted: string[], unlabelledIssues: object[] }>}
 */
export async function ensureWorkstreamLabels({ projectRoot, token, fetchImpl = fetch }) {
  const config = loadConfig(projectRoot);
  const resolved = resolveWorkstreams(config);
  // A workstream's own declared `label` field, deduplicated — two workstreams naming the same
  // label would already have failed `resolveWorkstreams`' own validation (decision 32), so this
  // is defensive, not load-bearing.
  const labels = [...new Set(resolved.map((stream) => stream.manifest.label))];

  const created = [];
  const alreadyExisted = [];
  for (const name of labels) {
    const existed = await ensureLabel({ repo: config.repo, name, token, fetchImpl });
    (existed ? alreadyExisted : created).push(name);
  }

  const unlabelledIssues = await fetchUnlabelledOpenIssues({ repo: config.repo, token, fetchImpl });

  return { repo: config.repo, created, alreadyExisted, unlabelledIssues };
}

export function parseArgv(argv) {
  return { projectRoot: argv[0] };
}

export async function main(argv) {
  const { projectRoot } = parseArgv(argv);
  if (!projectRoot) {
    console.error('atlas: usage: GITHUB_TOKEN=... node src/labels.mjs <project-root>');
    return 2;
  }
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('atlas: labels — GITHUB_TOKEN is required (creating a label is a write)');
    return 2;
  }

  let result;
  try {
    result = await ensureWorkstreamLabels({ projectRoot, token });
  } catch (err) {
    console.error(`atlas: labels — ${err.message}`);
    return 1;
  }

  console.log(`atlas: labels — ${result.repo}`);
  if (result.created.length) console.log(`  created: ${result.created.join(', ')}`);
  if (result.alreadyExisted.length) console.log(`  already existed: ${result.alreadyExisted.join(', ')}`);
  if (result.unlabelledIssues.length) {
    console.log(`  ${result.unlabelledIssues.length} open issue(s) still carry no workstream label — label these by hand:`);
    for (const issue of result.unlabelledIssues) {
      console.log(`    #${issue.number} ${issue.title} — ${issue.url}`);
    }
  } else {
    console.log('  every open issue already carries a workstream label');
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
