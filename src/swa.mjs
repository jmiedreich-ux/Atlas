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

      // #780 renamed the Records surface to the Library. These two rules are what keeps an old
      // link working, and the alternative — letting it 404 — was considered and rejected: on a
      // site whose whole premise is that it is always current, a dead link is indistinguishable
      // from a broken site, and it teaches a reader to distrust the rest. Links to `/records/`
      // are in the owner's browser history and quite possibly in issues.
      //
      // It belongs in the GENERATOR rather than in one project's own config because `/records/`
      // was ATLAS's route, in every project Atlas has ever built. It is the generator's own
      // history, not any project's content, so decision 40 is untouched.
      //
      // Before the catch-all, because route rules are first-match-wins; and still requiring the
      // role, because the redirect sits inside the gate like everything else.
      { route: '/records', allowedRoles: [ACCESS_ROLE], redirect: '/library/', statusCode: 301 },
      { route: '/records/*', allowedRoles: [ACCESS_ROLE], redirect: '/library/', statusCode: 301 },

      // Everything else, including state.json and every copied document.
      { route: '/*', allowedRoles: [ACCESS_ROLE] },
    ],
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
