// The GitHub contents API, which both commits and gives optimistic concurrency for free.
//
// `PUT /repos/{owner}/{repo}/contents/{path}` takes the SHA the file had when it was read. If the
// file has moved on, GitHub refuses rather than writing, and this module turns that refusal into a
// conflict the caller is told about. Nothing here retries: a retry without the SHA is exactly the
// silent overwrite the SHA exists to prevent, and a retry with a fresh one answers a question
// nobody asked.
//
// Every request goes through an injected `fetchImpl`, the way `src/github.mjs` does, so no test in
// this repository can reach the network.

const GITHUB_API_ROOT = 'https://api.github.com';
const ACCEPT = 'application/vnd.github+json';
const API_VERSION = '2022-11-28';

/** A failure with an HTTP status the endpoint can return as it stands. */
export class GitHubError extends Error {
  constructor(message, { status = 502, code = 'github-unavailable' } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.code = code;
  }
}

/**
 * The guard both `apiPath` (below, for a URL) and the tree client (for a JSON tree entry, which is
 * never URL-encoded) share: the repository is a deployment setting, and a path carrying `..` would
 * climb out of the repository's own segment of either request and reach a repository nobody
 * configured.
 *
 * @param {unknown} repositoryRelative
 * @returns {string[]} the path's segments, unencoded.
 */
function assertRepoRelativePath(repositoryRelative) {
  const segments = String(repositoryRelative).split('/');
  if (
    repositoryRelative === '' ||
    typeof repositoryRelative !== 'string' ||
    repositoryRelative.startsWith('/') ||
    segments.includes('..') ||
    segments.includes('.') ||
    repositoryRelative.includes('\\')
  ) {
    throw new GitHubError(
      `${JSON.stringify(repositoryRelative)} is not a repository-relative path, and Atlas will ` +
        `not build a request from it.`,
      { status: 400, code: 'invalid-path' },
    );
  }
  return segments;
}

/**
 * A repository-relative path, with each segment encoded but the slashes left alone — the same rule
 * the generator uses for a site URL.
 */
function apiPath(repositoryRelative) {
  return assertRepoRelativePath(repositoryRelative).map(encodeURIComponent).join('/');
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Upstream text, with anything URL-shaped taken out of it.
 *
 * GitHub's 4xx bodies carry a `documentation_url` and its messages sometimes quote the API URL,
 * which contains `owner/repo`; undici's network errors quote the URL they failed to reach. The
 * text itself is worth relaying — it is often the only clue about what actually went wrong — but
 * the URLs in it are not, and they are the part that names the deployment's repository back to
 * whoever asked.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function withoutUrls(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '(a URL)')
    .replace(/\s+/g, ' ')
    .trim();
}

function messageFrom(payload) {
  return withoutUrls(payload?.message);
}

// GitHub answers a stale SHA with a 409, and — for some paths through the same check — a 422 whose
// message says the SHA does not match. A 422 that means something else (a branch that is not
// there, a path that is a directory) must not be reported as a conflict, because "somebody else
// changed it, reload and try again" would be a lie.
function isStaleSha(status, message) {
  if (status === 409) return true;
  return status === 422 && /sha/i.test(message);
}

/**
 * A client for one repository's contents API.
 *
 * @param {object} opts
 * @param {string} opts.repo - `owner/name`, from the deployment's settings. Never from a request.
 * @param {string} opts.token - an installation access token.
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {string} [opts.apiRoot]
 */
export function createContentsClient({ repo, token, fetchImpl = fetch, apiRoot = GITHUB_API_ROOT }) {
  const headers = {
    Accept: ACCEPT,
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'atlas-write-back',
  };

  async function request(url, init) {
    try {
      return await fetchImpl(url, init);
    } catch (error) {
      throw new GitHubError(`Atlas could not reach GitHub: ${withoutUrls(error.message)}`);
    }
  }

  return {
    /**
     * Read a record's text and the SHA a write to it will have to carry.
     *
     * @param {string} path - repository-relative.
     * @param {string} ref - the branch the site is built from.
     * @returns {Promise<{ text: string, sha: string }>}
     */
    async read(path, ref) {
      const url = `${apiRoot}/repos/${repo}/contents/${apiPath(path)}?ref=${encodeURIComponent(ref)}`;
      const response = await request(url, { headers });
      const payload = await readJson(response);

      if (response.status === 404) {
        // The repository is a deployment setting and a refusal has no reason to recite one, so
        // every message in this module names the path and the branch and stops there.
        throw new GitHubError(
          `there is no ${path} on ${ref}. Atlas writes into records that already exist; create ` +
            `the file and try again.`,
          { status: 404, code: 'no-such-record' },
        );
      }
      if (!response.ok) {
        throw new GitHubError(
          `GitHub answered ${response.status} reading ${path}${messageFrom(payload) ? `: ${messageFrom(payload)}` : ''}`,
        );
      }
      if (Array.isArray(payload)) {
        throw new GitHubError(`${path} is a directory, not a record.`, {
          status: 400,
          code: 'invalid-path',
        });
      }
      // Over a megabyte the contents API answers with `encoding: "none"` and an empty `content`.
      // Decoding that as though it were the file would write an empty record over a real one.
      if (payload?.encoding !== 'base64' || typeof payload.content !== 'string') {
        throw new GitHubError(
          `${path} is too large for the contents API to return, so Atlas will not write to it.`,
          { status: 413, code: 'record-too-large' },
        );
      }

      return {
        // GitHub wraps its base64 at 60 columns; Buffer ignores the newlines, but stripping them
        // is what makes that a fact rather than a hope.
        text: Buffer.from(payload.content.replace(/\s+/g, ''), 'base64').toString('utf8'),
        sha: payload.sha,
      };
    },

    /**
     * Commit new text for a record.
     *
     * @param {object} opts
     * @param {string} opts.path - repository-relative.
     * @param {string} opts.message - the commit message.
     * @param {string} opts.text - the record's whole new content.
     * @param {string} opts.sha - the SHA the record had when it was read.
     * @param {string} opts.branch
     * @returns {Promise<{ commitUrl: string, sha: string }>}
     * @throws {GitHubError} with `code: 'conflict'` and status 409 when the SHA is stale.
     */
    async write({ path, message, text, sha, branch }) {
      const url = `${apiRoot}/repos/${repo}/contents/${apiPath(path)}`;
      const response = await request(url, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          content: Buffer.from(text, 'utf8').toString('base64'),
          sha,
          branch,
        }),
      });
      const payload = await readJson(response);

      if (isStaleSha(response.status, messageFrom(payload))) {
        throw new GitHubError(
          `${path} changed on ${branch} between Atlas reading it and writing it, so nothing was ` +
            `written. Reload the page and send this again — the other change is still there.`,
          { status: 409, code: 'conflict' },
        );
      }
      if (!response.ok) {
        throw new GitHubError(
          `GitHub answered ${response.status} writing ${path}${messageFrom(payload) ? `: ${messageFrom(payload)}` : ''}`,
        );
      }

      return {
        commitUrl: payload?.commit?.html_url ?? null,
        sha: payload?.content?.sha ?? null,
      };
    },
  };
}

/**
 * A client for one repository's Git Data API — blobs, trees, commits and refs.
 *
 * `createContentsClient` above edits one file at a time: read text, write text, get a new SHA back.
 * That is the wrong shape for an action that moves N files and writes two more in one step (M9's
 * `approve` — decision 59) — a sequence of Contents-API PUTs would leave a real half-state on the
 * repository if any PUT after the first failed (files gone from `proposed/` with no `workstream.json`
 * ever written, the exact half-state decision 37's "nothing is kept anywhere" has refused everywhere
 * else in this codebase). The Git Data API commits a whole tree at once instead: build the new tree
 * from the old one plus a list of additions and removals, wrap it in one commit, and move the branch
 * pointer to it — one commit or none, never half of one.
 *
 * The concurrency guarantee is the branch ref itself rather than a caller-supplied SHA. `updateRef`
 * moves `refs/heads/<branch>` with `force: false`, which GitHub only allows when the new commit is a
 * fast-forward of the ref's CURRENT value — so if the branch moved between this client's `readBranch`
 * and its `updateRef`, the update is refused and nothing is written, the same "reload and try again"
 * guarantee `createContentsClient`'s SHA gives one file at a time.
 *
 * @param {object} opts
 * @param {string} opts.repo - `owner/name`, from the deployment's settings. Never from a request.
 * @param {string} opts.token - an installation access token.
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {string} [opts.apiRoot]
 */
export function createTreeClient({ repo, token, fetchImpl = fetch, apiRoot = GITHUB_API_ROOT }) {
  const headers = {
    Accept: ACCEPT,
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'atlas-write-back',
  };
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };

  async function request(url, init) {
    try {
      return await fetchImpl(url, init);
    } catch (error) {
      throw new GitHubError(`Atlas could not reach GitHub: ${withoutUrls(error.message)}`);
    }
  }

  async function post(path, body) {
    const url = `${apiRoot}/repos/${repo}/${path}`;
    const response = await request(url, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) });
    const payload = await readJson(response);
    if (!response.ok) {
      throw new GitHubError(
        `GitHub answered ${response.status} on ${path}${messageFrom(payload) ? `: ${messageFrom(payload)}` : ''}`,
      );
    }
    return payload;
  }

  return {
    /**
     * The commit and tree a branch currently points at.
     *
     * @param {string} branch
     * @returns {Promise<{ commitSha: string, treeSha: string }>}
     */
    async readBranch(branch) {
      const url = `${apiRoot}/repos/${repo}/branches/${encodeURIComponent(branch)}`;
      const response = await request(url, { headers });
      const payload = await readJson(response);
      if (response.status === 404) {
        throw new GitHubError(`there is no branch ${JSON.stringify(branch)} on this repository.`, {
          status: 404,
          code: 'no-such-branch',
        });
      }
      if (!response.ok) {
        throw new GitHubError(
          `GitHub answered ${response.status} reading branch ${branch}${messageFrom(payload) ? `: ${messageFrom(payload)}` : ''}`,
        );
      }
      return { commitSha: payload.commit.sha, treeSha: payload.commit.commit.tree.sha };
    },

    /**
     * Every blob under a tree, recursively, as flat `{ path, mode, type, sha }` entries.
     *
     * @param {string} treeSha
     * @returns {Promise<{ path: string, mode: string, type: string, sha: string }[]>}
     */
    async readTree(treeSha) {
      const url = `${apiRoot}/repos/${repo}/git/trees/${treeSha}?recursive=1`;
      const response = await request(url, { headers });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new GitHubError(
          `GitHub answered ${response.status} reading the repository tree${messageFrom(payload) ? `: ${messageFrom(payload)}` : ''}`,
        );
      }
      if (payload.truncated) {
        // GitHub caps a recursive listing at 100,000 entries / 7MB and truncates silently past
        // that rather than paging. Acting on a truncated listing risks the move ignoring files it
        // never saw, which is worse than refusing outright.
        throw new GitHubError('the repository tree is too large for Atlas to read in one request.', {
          status: 502,
          code: 'tree-truncated',
        });
      }
      return payload.tree ?? [];
    },

    /**
     * A blob's text content, by its own SHA (not a path — blobs are content-addressed).
     *
     * @param {string} sha
     * @returns {Promise<string>}
     */
    async readBlob(sha) {
      const url = `${apiRoot}/repos/${repo}/git/blobs/${sha}`;
      const response = await request(url, { headers });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new GitHubError(
          `GitHub answered ${response.status} reading a blob${messageFrom(payload) ? `: ${messageFrom(payload)}` : ''}`,
        );
      }
      return Buffer.from(String(payload.content).replace(/\s+/g, ''), 'base64').toString('utf8');
    },

    /**
     * Write text as a new blob and return its SHA. Used only for content this client is creating —
     * a moved file's existing blob SHA is reused as-is, never re-uploaded.
     *
     * @param {string} text
     * @returns {Promise<string>}
     */
    async createBlob(text) {
      const payload = await post('git/blobs', { content: Buffer.from(text, 'utf8').toString('base64'), encoding: 'base64' });
      return payload.sha;
    },

    /**
     * A new tree built from `baseTreeSha` plus `entries`. Each entry's `path` must be a plain
     * repository-relative path (validated, never encoded — this is JSON, not a URL); an entry with
     * `sha: null` removes whatever was at that path in the base tree.
     *
     * @param {{ baseTreeSha: string, entries: { path: string, mode: string, type: string, sha: string | null }[] }} args
     * @returns {Promise<string>} the new tree's SHA.
     */
    async createTree({ baseTreeSha, entries }) {
      const tree = entries.map((entry) => {
        assertRepoRelativePath(entry.path);
        return entry;
      });
      const payload = await post('git/trees', { base_tree: baseTreeSha, tree });
      return payload.sha;
    },

    /**
     * A new commit over an existing tree, with exactly one parent — Atlas never writes a merge.
     *
     * @param {{ treeSha: string, parentSha: string, message: string }} args
     * @returns {Promise<string>} the new commit's SHA.
     */
    async createCommit({ treeSha, parentSha, message }) {
      const payload = await post('git/commits', { message, tree: treeSha, parents: [parentSha] });
      return payload.sha;
    },

    /**
     * Move `branch` to `commitSha`, but only as a fast-forward. This is the whole concurrency
     * guarantee this client gives: if the branch moved since `readBranch` returned the commit this
     * new one is built on top of, GitHub refuses the update and nothing is written.
     *
     * @param {{ branch: string, commitSha: string }} args
     * @returns {Promise<{ commitUrl: string }>}
     */
    async updateRef({ branch, commitSha }) {
      const url = `${apiRoot}/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`;
      const response = await request(url, {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify({ sha: commitSha, force: false }),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        // A non-fast-forward update is GitHub's way of saying the branch moved. Reported the same
        // way `createContentsClient`'s stale-SHA write is: a conflict, not a generic failure, and
        // the message says to reload rather than to retry blindly.
        if (response.status === 422 || response.status === 409) {
          throw new GitHubError(
            `${branch} changed between Atlas reading it and writing to it, so nothing was written. ` +
              `Reload the page and send this again — the other change is still there.`,
            { status: 409, code: 'conflict' },
          );
        }
        throw new GitHubError(
          `GitHub answered ${response.status} updating ${branch}${messageFrom(payload) ? `: ${messageFrom(payload)}` : ''}`,
        );
      }
      return { commitUrl: `https://github.com/${repo}/commit/${commitSha}` };
    },
  };
}
