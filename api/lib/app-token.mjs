// A GitHub App installation token, which is what decision 36 is about.
//
// **Why not `GITHUB_TOKEN`.** The reason on record is mechanical rather than a matter of security
// posture: a push made with the Actions token does not trigger workflows. Atlas's whole write-back
// story is decision 37 — the answer becomes a commit, and the page is then rebuilt from that
// commit — so a token whose pushes do not start the build would leave the site sitting stale,
// showing the reader the answer it had just failed to render. A GitHub App's pushes do trigger
// workflows.
//
// The exchange is two steps. Atlas signs a short-lived assertion with the App's private key, and
// GitHub trades that for an installation access token scoped to the one installation. Neither
// value is ever logged, returned to the caller, or written anywhere.
//
// `node:crypto` signs the assertion, so this Function has no dependencies at all — there is no
// `jsonwebtoken` here to justify, and nothing to keep patched in a deployable that ships beside
// the site.

import { createSign } from 'node:crypto';

import { GitHubError, withoutUrls } from './github.mjs';

const GITHUB_API_ROOT = 'https://api.github.com';

// GitHub rejects an assertion whose `iat` is in its own future, and the clock on a Function host
// does not agree with GitHub's to the second. Backdating a minute is the documented remedy.
const BACKDATE_SECONDS = 60;

// GitHub refuses an assertion valid for more than ten minutes. Nine leaves room for the skew above
// to be spent at both ends.
const LIFETIME_SECONDS = 540;

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

/**
 * Sign the App's assertion.
 *
 * @param {object} opts
 * @param {string} opts.appId - the App's id, which is its issuer.
 * @param {string} opts.privateKey - the App's private key, PEM.
 * @param {number} opts.nowSeconds - injected rather than read, so this is testable and so nothing
 *   in Atlas reaches for a clock that a test cannot hold still.
 * @returns {string} a compact RS256 JWT.
 * @throws {GitHubError} when the key is not a key — as a refusal, never as an OpenSSL stack trace.
 */
export function signAppJwt({ appId, privateKey, nowSeconds }) {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iat: nowSeconds - BACKDATE_SECONDS,
      exp: nowSeconds - BACKDATE_SECONDS + LIFETIME_SECONDS,
      iss: String(appId),
    }),
  );

  try {
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${payload}`);
    return `${header}.${payload}.${signer.sign(privateKey, 'base64url')}`;
  } catch (error) {
    // The message deliberately describes the SETTING rather than the key, because that is what
    // whoever reads it can act on, and because quoting an OpenSSL error about a PEM header sends
    // them to the key file when the problem is nearly always how it was pasted.
    throw new GitHubError(
      `the GitHub App's private key could not be used to sign: the ` +
        `ATLAS_GITHUB_APP_PRIVATE_KEY application setting does not hold a PEM private key ` +
        `(${withoutUrls(error.message)}).`,
      { status: 503, code: 'credential-unusable' },
    );
  }
}

/**
 * Exchange the App's assertion for an installation access token.
 *
 * @param {object} opts
 * @param {string} opts.appId
 * @param {string} opts.installationId
 * @param {string} opts.privateKey
 * @param {number} opts.nowSeconds
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {string} [opts.apiRoot]
 * @returns {Promise<string>} the token. Never logged and never returned to a caller.
 * @throws {GitHubError}
 */
export async function fetchInstallationToken({
  appId,
  installationId,
  privateKey,
  nowSeconds,
  fetchImpl = fetch,
  apiRoot = GITHUB_API_ROOT,
}) {
  const assertion = signAppJwt({ appId, privateKey, nowSeconds });
  const url = `${apiRoot}/app/installations/${encodeURIComponent(installationId)}/access_tokens`;

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${assertion}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'atlas-write-back',
      },
    });
  } catch (error) {
    // The assertion is a bearer credential. It must not reach a log line, and the only way to be
    // sure of that is for no failure path to interpolate it.
    throw new GitHubError(
      `Atlas could not reach GitHub to authenticate: ${withoutUrls(error.message)}`,
    );
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok || typeof payload?.token !== 'string') {
    const detail = withoutUrls(payload?.message) ? `: ${withoutUrls(payload.message)}` : '';
    throw new GitHubError(
      `GitHub would not issue an installation token for Atlas's GitHub App ` +
        `(${response.status})${detail}. Check that the App is installed on the repository and ` +
        `that ATLAS_GITHUB_APP_ID and ATLAS_GITHUB_APP_INSTALLATION_ID name the same App.`,
    );
  }

  return payload.token;
}
