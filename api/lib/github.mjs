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
 * A repository-relative path, with each segment encoded but the slashes left alone — the same rule
 * the generator uses for a site URL.
 *
 * The guard in front of it is the reason this function exists rather than a template string: the
 * repository is a deployment setting, and a path carrying `..` would climb out of the repository's
 * own segment of the API URL and make a request against a repository nobody configured.
 */
function apiPath(repositoryRelative) {
  const segments = String(repositoryRelative).split('/');
  if (
    repositoryRelative === '' ||
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
  return segments.map(encodeURIComponent).join('/');
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
