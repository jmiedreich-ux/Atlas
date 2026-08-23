// The credential slot, which may be empty.
//
// Decision 36: writes go through a GitHub App, never `GITHUB_TOKEN`. The reason is mechanical
// rather than a matter of taste — a push made with the Actions token does not trigger workflows,
// so the site would never rebuild after its own write and would sit stale, showing the reader the
// answer it had just failed to render.
//
// The App's installation credentials live in the Static Web App's application settings and never
// in the repository, in a build artifact or in `state.json`. Until the owner creates the App the
// slot is empty, and everything here is about that being an ordinary state rather than a fault:
// the write endpoints refuse, name the settings that are unset, and produce no stack trace.
// Reading the site is unaffected, because the site is static files that were built before any of
// this ran.

/** The application settings a write needs, in the order the owner will set them. */
export const CREDENTIAL_SETTINGS = Object.freeze([
  'ATLAS_GITHUB_APP_ID',
  'ATLAS_GITHUB_APP_INSTALLATION_ID',
  'ATLAS_GITHUB_APP_PRIVATE_KEY',
  'ATLAS_REPO',
]);

/** The branch a write lands on when the project does not say otherwise (decision 1). */
const DEFAULT_BRANCH = 'master';

// The same rule `src/schema.mjs` applies to a project's `repo`: exactly one slash, no whitespace.
const REPO_SLUG_PATTERN = /^[^\s/]+\/[^\s/]+$/;

const PEM_HEADER = '-----BEGIN';

function trimmed(env, name) {
  const value = env?.[name];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * A private key as `crypto.createPrivateKey` needs it, from whichever of the three shapes an
 * application setting is likely to hold.
 *
 * An application setting in the Azure portal is a single-line text box. A PEM pasted into one
 * arrives with literal backslash-n where its line breaks were, and `az staticwebapp appsettings
 * set` is usually fed a base64 of the file to avoid the question entirely. Both are repaired here,
 * because the alternative is an OpenSSL error about a PEM header that sends whoever reads it
 * looking at the key file rather than at how it was pasted.
 */
function normalisePrivateKey(raw) {
  if (raw.includes(PEM_HEADER)) {
    return raw.includes('\\n') ? raw.split('\\n').join('\n') : raw;
  }
  // Not PEM as it stands. It may be a base64 wrapping of one.
  const decoded = Buffer.from(raw, 'base64').toString('utf8');
  return decoded.includes(PEM_HEADER) ? decoded : raw;
}

function refuse(message) {
  return { ok: false, status: 503, error: 'credential-unavailable', message };
}

/**
 * Read the write-back credential out of the environment.
 *
 * Takes the environment and nothing else — deliberately, and asserted by a test. The repository a
 * write can reach is a deployment setting, so no request can name a different one (decision 41,
 * and the plan's "no write that can reach a repository other than the configured one").
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ ok: true, value: { appId: string, installationId: string, privateKey: string,
 *   repo: string, branch: string } }
 *   | { ok: false, status: 503, error: 'credential-unavailable', message: string }}
 *   Never throws, and no refusal ever quotes key material back.
 */
export function readCredential(env) {
  const missing = CREDENTIAL_SETTINGS.filter((name) => trimmed(env, name) === '');

  if (missing.length > 0) {
    return refuse(
      `Atlas can show you the records but cannot write to them yet: its GitHub App is not ` +
        `configured. The Static Web App is missing ${missing.join(', ')} in its application ` +
        `settings. Everything on the site still reads normally.`,
    );
  }

  const repo = trimmed(env, 'ATLAS_REPO');
  if (!REPO_SLUG_PATTERN.test(repo)) {
    return refuse(
      `Atlas cannot write yet: the ATLAS_REPO application setting must name one repository as ` +
        `"owner/name". Reading the site is not affected.`,
    );
  }

  const branch = trimmed(env, 'ATLAS_BRANCH') || DEFAULT_BRANCH;

  return {
    ok: true,
    value: {
      appId: trimmed(env, 'ATLAS_GITHUB_APP_ID'),
      installationId: trimmed(env, 'ATLAS_GITHUB_APP_INSTALLATION_ID'),
      privateKey: normalisePrivateKey(trimmed(env, 'ATLAS_GITHUB_APP_PRIVATE_KEY')),
      repo,
      branch,
    },
  };
}
