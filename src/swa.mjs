// The Azure Static Web Apps configuration Atlas emits beside the pages.
//
// M1 shipped none, and #780 calls that the top item of its generator gaps: the gate on the one
// live Atlas site is copied in by that PROJECT's own workflow, so any other project adopting the
// generator got a **public** site by default. Decision 7 says nothing on an Atlas site is
// anonymous, and a default that contradicts a decision is worse than no default at all — the
// failure mode is a project that does nothing, not one that does the wrong thing.
//
// TWO THINGS THIS FILE GETS RIGHT THAT ARE EASY TO GET WRONG:
//
//   * **The role is an invited one, not `authenticated`.** `authenticated` means "signed in to the
//     identity provider" — any account in the world — which is a login page in front of a public
//     site rather than access control. Decision 7 says role INVITATIONS, and accepts the Free
//     tier's 25-invitation ceiling as sufficient precisely because the roles are handed out one at
//     a time.
//   * **The sign-in endpoints are exempted, FIRST.** `/*` matches `/.auth/login/...` too, so a
//     catch-all requiring a role sends a visitor with no role to a page they are not allowed to
//     open. Route rules are first-match-wins, so the exemption has to precede the catch-all.
//
// THE IDENTITY PROVIDER IS DECISION 7'S: Microsoft (`aad`). A project that signs in with another
// provider overwrites this file in its own deploy — which is exactly what the one live consumer
// does today — and the README says so. It is not read from `atlas.config.json`, because widening
// a project's config contract is the owner's call to make and not a side effect of closing a gap.
//
// It holds no project content (decision 40): the same file suits any project, which is what lets
// the generator emit it rather than each project writing its own.

export const SWA_CONFIG_FILENAME = 'staticwebapp.config.json';

// The role a person is INVITED into. Not `authenticated`; see above.
export const ACCESS_ROLE = 'reader';

// Decision 7's provider. `aad` is SWA's built-in Microsoft one.
export const LOGIN_PROVIDER = 'aad';

// The role a WRITE requires (decisions 35 to 37), separate from `ACCESS_ROLE` so that being able
// to read the records is not being able to commit to them. It has to be the same string
// `api/lib/principal.mjs` checks, and a test asserts the two are one value — two spellings of one
// role is a site where the door and the lock disagree.
export const WRITE_ROLE = 'author';

// The runtime Static Web Apps runs the managed Function on.
//
// NOT the runtime the generator builds on. Atlas builds on Node 22 — `package.json`, `action.yml`
// and CI all say so — in GitHub Actions; the Function runs in Azure on whatever Static Web Apps
// offers managed Functions, which is a different runtime in a different place. This constant is
// the one line that says which, and raising it to `node:22` when the platform offers it is the
// whole change: the Function's code is plain ESM and runs unchanged on any of them.
//
// It is declared rather than left out because Static Web Apps does not guess — without it a Node
// API is deployed against whatever default the platform has that week, which is the difference
// between endpoints that answer and endpoints that 404 with nothing useful in the log.
export const API_RUNTIME = 'node:20';

/**
 * The configuration, as an object.
 *
 * @returns {object} a fresh object each call, so a caller cannot mutate the next one's answer.
 */
export function staticWebAppConfig() {
  return {
    $schema: 'https://json.schemastore.org/staticwebapp.config.json',
    // Atlas writes every page as `<path>/index.html`, so `/docs/x/y` and `/docs/x/y/` are the same
    // record and a reader who types either should land on it.
    trailingSlash: 'auto',
    routes: [
      // First, and anonymous: without this the gate locks the reader out of the gate.
      { route: '/.auth/*', allowedRoles: ['anonymous', 'authenticated'] },
      // The write endpoints, BEFORE the catch-all, or `/*` would match them first and every
      // reader would reach them. First-match-wins, same trap as the line above.
      //
      // This is a layer in front of the check that actually refuses a caller without `author`,
      // which lives in `api/lib/principal.mjs` where a test can reach it. It is emitted rather
      // than written down in the README because the file Atlas emits is REPLACED on every build:
      // "add this rule to staticwebapp.config.json afterwards" was advice about a file that does
      // not persist.
      { route: '/api/*', allowedRoles: [WRITE_ROLE] },
      // Everything else, including state.json and every copied document.
      { route: '/*', allowedRoles: [ACCESS_ROLE] },
    ],
    // Which runtime the managed Function runs on; see API_RUNTIME. Harmless for a project that
    // publishes no API — it is a declaration of what to use if there is one.
    platform: { apiRuntime: API_RUNTIME },
    responseOverrides: {
      // A visitor with no role is sent to sign in rather than shown a bare 401 they cannot act on.
      401: { statusCode: 302, redirect: `/.auth/login/${LOGIN_PROVIDER}` },
    },
    globalHeaders: {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      // Decision 1: the site is built from the repository and is always current. A cached copy of
      // an internal record is a second truth with a shorter half-life than the page it came from.
      'Cache-Control': 'no-store',
    },
  };
}

/**
 * The file's bytes: two-space JSON with a trailing newline, exactly as `state.json` is written.
 *
 * Nothing here varies between runs, which is what keeps two builds of one input byte-identical.
 *
 * @returns {string}
 */
export function serialiseSwaConfig() {
  return `${JSON.stringify(staticWebAppConfig(), null, 2)}\n`;
}
