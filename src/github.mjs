// Fetches a project's open issues and pull requests from GitHub and buckets them by workstream
// label, so each workstream's page can show its own backlog without anyone curating a list
// (decision 1: the site is built from GitHub, never maintained).
//
// This is the one place in the generator where a failure is tolerated (decision 32 is the rule;
// this module is the deliberate exception): GitHub being unreachable must not stop the site
// rendering the repository, which is the part that matters. Every other module in Atlas fails
// loudly on a broken reference.

const GITHUB_API_ROOT = 'https://api.github.com';
const PER_PAGE = 100;
const WORKSTREAM_LABEL_PREFIX = 'workstream:';

/**
 * The shape every caller of this module gets, empty.
 *
 * Exported because `src/build.mjs` needs exactly this when `--offline` declines to make the request
 * at all, and it used to carry its own copy of the literal — so a fifth bucket added here would
 * simply have been missing from the offline path, with nothing to notice.
 *
 * @returns {{ byLabel: Map<string, object[]>, unlabelled: object[], prs: object[] }}
 */
export function emptyBuckets() {
  return { byLabel: new Map(), unlabelled: [], prs: [] };
}

function warn(message) {
  console.warn(`atlas: ${message} — rendering with empty issue buckets`);
}

// A warning that is not a failure: the buckets are real, they may just be short.
function warnPossiblyTruncated(repo, count) {
  console.warn(
    `atlas: GitHub returned ${count} open items for ${repo}, which is this build's whole page — ` +
      `the backlog may be longer, and any workstream's list below may be short. Atlas asks for one ` +
      `page and does not follow the Link header.`,
  );
}

function labelNames(issue) {
  return (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name));
}

function isPullRequest(issue) {
  return issue.pull_request != null;
}

/**
 * Fetch a project's open issues and pull requests from GitHub, in a single list call, and bucket
 * them by workstream label (a workstream's manifest carries that label verbatim — see
 * `docs/features/<workstream>/workstream.json`'s `label` field).
 *
 * One request for the whole open-issues list, bucketed here in memory, rather than one search
 * request per workstream: an open backlog of any ordinary size fits a single page, and the search
 * endpoint carries a lower rate limit than the list endpoint.
 *
 * That single page is a ceiling, and a lower one than it looks: `/issues` returns issues AND pull
 * requests interleaved, so `per_page=100` is 100 COMBINED, not 100 issues. When the response comes
 * back exactly full, the answer may be short — and a silently short answer is the one failure mode
 * decision 32 exists to forbid, so it says so. It says so rather than paginating because the
 * single-request design is deliberate: the alternative is an unbounded number of requests against
 * a rate limit, on decision 30's six-hourly schedule, to render a backlog nobody reads past the
 * first screen of.
 *
 * @param {object} opts
 * @param {string} opts.repo - `owner/name`, as recorded in `atlas.config.json`.
 * @param {string} [opts.token] - a GitHub token. Omitted requests are unauthenticated.
 * @param {typeof fetch} [opts.fetchImpl] - injected so callers (and tests) never depend on the
 *   network. Defaults to the platform's global `fetch`.
 * @returns {Promise<{ byLabel: Map<string, object[]>, unlabelled: object[], prs: object[] }>}
 *   On any failure — network error, a non-OK response, or a response that doesn't parse as
 *   JSON — resolves to empty buckets after logging a warning. Never rejects and never throws.
 */
export async function fetchProjectIssues({ repo, token, fetchImpl = fetch }) {
  const url = `${GITHUB_API_ROOT}/repos/${repo}/issues?state=open&per_page=${PER_PAGE}`;
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response;
  try {
    response = await fetchImpl(url, { headers });
  } catch (err) {
    warn(`could not reach GitHub to fetch issues for ${repo}: ${err.message}`);
    return emptyBuckets();
  }

  if (!response.ok) {
    warn(`GitHub responded ${response.status} fetching issues for ${repo}`);
    return emptyBuckets();
  }

  let items;
  try {
    items = await response.json();
  } catch (err) {
    warn(`could not parse GitHub's issues response for ${repo}: ${err.message}`);
    return emptyBuckets();
  }

  if (Array.isArray(items) && items.length === PER_PAGE) {
    warnPossiblyTruncated(repo, items.length);
  }

  const buckets = emptyBuckets();

  for (const item of items) {
    if (isPullRequest(item)) {
      buckets.prs.push(item);
      continue;
    }

    const workstreamLabels = labelNames(item).filter((name) =>
      name?.startsWith(WORKSTREAM_LABEL_PREFIX),
    );

    if (workstreamLabels.length === 0) {
      buckets.unlabelled.push(item);
      continue;
    }

    for (const label of workstreamLabels) {
      if (!buckets.byLabel.has(label)) {
        buckets.byLabel.set(label, []);
      }
      buckets.byLabel.get(label).push(item);
    }
  }

  return buckets;
}

function warnIssueFetch(repo, number, detail) {
  console.warn(`atlas: could not fetch issue #${number} for ${repo}: ${detail} — its tasks will be empty`);
}

function assigneesOf(item) {
  return (item.assignees ?? [])
    .filter((a) => typeof a?.login === 'string')
    .map((a) => ({
      login: a.login,
      avatarUrl: typeof a.avatar_url === 'string' ? a.avatar_url : null,
      htmlUrl: typeof a.html_url === 'string' ? a.html_url : null,
    }));
}

/**
 * Fetch the body and real GitHub assignees of every distinct issue number given, regardless of
 * open/closed state — unlike `fetchProjectIssues`, which only ever sees OPEN issues. A milestone
 * marked `done` almost always has a *closed* issue, and its checklist has to come from somewhere.
 *
 * One request per distinct issue number, run concurrently — the single-issue endpoint already
 * returns `assignees` alongside `body`, so this is the one fetch both need, not two. Bounded by
 * how many milestones this project has (a few dozen at most), not by the open backlog — this is a
 * different shape of request from `fetchProjectIssues`'s single list call on purpose.
 *
 * Decision 32's stated tolerated-failure module extends to this call the same way it already
 * covers the list fetch: a network error or non-OK response for one issue logs a warning and maps
 * that issue to `null` (the whole value — a fetch that never happened has no assignees to report
 * either), never rejects, never fails the build. A successful fetch always maps to an object, even
 * when `body` itself is malformed, because the issue's assignees are still real information.
 *
 * @param {object} opts
 * @param {string} opts.repo - `owner/name`.
 * @param {number[]} opts.issueNumbers - may contain duplicates; each distinct number is fetched once.
 * @param {string} [opts.token]
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<Map<number, { body: string | null, assignees: { login: string, avatarUrl: string | null, htmlUrl: string | null }[] } | null>>}
 *   every distinct number given, mapped to its issue's body/assignees, or `null` on any failure
 *   for that issue.
 */
export async function fetchIssueBodies({ repo, issueNumbers, token, fetchImpl = fetch }) {
  const unique = [...new Set(issueNumbers)];
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const entries = await Promise.all(
    unique.map(async (number) => {
      const url = `${GITHUB_API_ROOT}/repos/${repo}/issues/${number}`;
      try {
        const response = await fetchImpl(url, { headers });
        if (!response.ok) {
          warnIssueFetch(repo, number, `GitHub responded ${response.status}`);
          return [number, null];
        }
        const item = await response.json();
        return [
          number,
          { body: typeof item.body === 'string' ? item.body : null, assignees: assigneesOf(item) },
        ];
      } catch (err) {
        warnIssueFetch(repo, number, err.message);
        return [number, null];
      }
    }),
  );

  return new Map(entries);
}
