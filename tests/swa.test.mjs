import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCESS_ROLE,
  API_RUNTIME,
  SWA_CONFIG_FILENAME,
  WRITE_ROLE,
  serialiseSwaConfig,
  staticWebAppConfig,
} from '../src/swa.mjs';
import { AUTHOR_ROLE } from '../api/lib/principal.mjs';

// Decision 7: "Nothing is anonymous. SWA's built-in Microsoft provider with role invitations;
// every route requires a role."
//
// M1 shipped no `staticwebapp.config.json` at all — the gate on the one live site is copied in by
// that project's own workflow — so any OTHER project adopting Atlas got a PUBLIC site by default.
// #780 calls that the top M2 item, and the phrase that matters is "by default": the failure mode
// is a project that does nothing, not a project that does the wrong thing.

test('swa: every route requires a role, so nothing on the site is anonymous', () => {
  const config = staticWebAppConfig();

  const catchAll = config.routes.find((route) => route.route === '/*');
  assert.ok(catchAll, 'there is no rule covering the whole site');
  assert.deepEqual(catchAll.allowedRoles, [ACCESS_ROLE]);

  for (const route of config.routes) {
    assert.ok(Array.isArray(route.allowedRoles), `${route.route} names no roles at all`);
    assert.ok(route.allowedRoles.length > 0, `${route.route} allows no role, which allows everyone through`);
  }
});

test('swa: the role is an invited one, never "authenticated", which is everybody with an account', () => {
  // The trap this is here for. `authenticated` means "signed in to the identity provider" — any
  // GitHub or Microsoft account in the world — which is a login page in front of a public site,
  // not access control. Decision 7 says role INVITATIONS, and the Free tier's 25-invitation
  // ceiling is accepted as sufficient precisely because the roles are handed out one at a time.
  const config = staticWebAppConfig();
  const catchAll = config.routes.find((route) => route.route === '/*');

  assert.notEqual(ACCESS_ROLE, 'authenticated');
  assert.notEqual(ACCESS_ROLE, 'anonymous');
  assert.ok(!catchAll.allowedRoles.includes('authenticated'));
  assert.ok(!catchAll.allowedRoles.includes('anonymous'));
});

test('swa: the sign-in endpoints stay reachable, or the gate locks the reader out of the gate', () => {
  // `/*` matches `/.auth/login/...` too, so a catch-all requiring a role sends an unauthenticated
  // visitor to a login page they are not allowed to open — a redirect loop, and a site nobody can
  // reach at all. The exemption must come FIRST: route rules are first-match-wins.
  const config = staticWebAppConfig();

  const authIndex = config.routes.findIndex((route) => route.route === '/.auth/*');
  const catchAllIndex = config.routes.findIndex((route) => route.route === '/*');
  assert.ok(authIndex !== -1, 'the sign-in endpoints are not exempted');
  assert.ok(authIndex < catchAllIndex, 'the exemption sits after the catch-all, so it never matches');
  assert.ok(config.routes[authIndex].allowedRoles.includes('anonymous'));
});

test('swa: an unauthenticated visitor is sent to sign in rather than shown a bare 401', () => {
  const config = staticWebAppConfig();
  const unauthorised = config.responseOverrides['401'];
  assert.ok(unauthorised, 'a visitor with no role gets no way in');
  assert.equal(unauthorised.statusCode, 302);
  assert.match(unauthorised.redirect, /^\/\.auth\/login\//);
});

test('swa: the emitted file is stable, canonical JSON, and carries no date', () => {
  // The whole site is byte-identical between two builds of one input, and this file is part of it.
  const once = serialiseSwaConfig();
  const twice = serialiseSwaConfig();
  assert.equal(once, twice);
  assert.equal(once, `${JSON.stringify(JSON.parse(once), null, 2)}\n`, 'not canonically formatted');
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(once), 'a date reached a file that is meant never to change');
});

test('swa: it holds no project content — the same file suits any project that adopts Atlas', () => {
  // Decision 40, and the reason this can be emitted by the generator at all rather than written by
  // each project: nothing in it names a project, a host or a tenant.
  const text = serialiseSwaConfig();
  assert.ok(!/vennusign|atlas\.|jmiedreich/i.test(text), 'the emitted config names a project');
  assert.equal(SWA_CONFIG_FILENAME, 'staticwebapp.config.json');
});

// --- M3: the write endpoints' own routes ------------------------------------------------------

test('swa: the write endpoints require `author`, and the rule precedes the catch-all', () => {
  // The role check that actually refuses a caller without `author` lives in the Function
  // (`api/lib/principal.mjs`), where a test can reach it. This is the layer in front of it, and
  // the reason it is emitted rather than written down: the config Atlas emits is REPLACED on every
  // build, so "hand-edit the file afterwards" was advice about a file that does not persist.
  const config = staticWebAppConfig();

  const api = config.routes.findIndex((route) => route.route === '/api/*');
  const catchAll = config.routes.findIndex((route) => route.route === '/*');

  assert.ok(api !== -1, 'the write endpoints are covered only by the catch-all');
  assert.ok(api < catchAll, 'the /api rule sits after the catch-all, so it never matches');
  assert.deepEqual(config.routes[api].allowedRoles, [WRITE_ROLE]);
});

test('swa: `author` is not `reader` — being able to read is not being able to write', () => {
  assert.notEqual(WRITE_ROLE, ACCESS_ROLE);
  assert.notEqual(WRITE_ROLE, 'authenticated');
  assert.notEqual(WRITE_ROLE, 'anonymous');
});

test('swa: the role the Function checks and the role the route requires are one value', () => {
  // Two spellings of the same role is a site where the door and the lock disagree: the route lets
  // somebody through and the Function refuses them, or worse, the other way round.
  assert.equal(WRITE_ROLE, AUTHOR_ROLE);
});

test('swa: the managed Function runtime is declared, because SWA will not guess it', () => {
  // Without `platform.apiRuntime` a Node API is deployed against whatever default the platform
  // has that week, which is the difference between endpoints that answer and endpoints that 404
  // or 500 with nothing useful in the log.
  const config = staticWebAppConfig();
  assert.ok(config.platform, 'no platform block at all');
  assert.match(config.platform.apiRuntime, /^node:\d+$/);
});

test('swa: the emitted runtime is the one constant to change, and it is not the build\'s', () => {
  // The generator builds on Node 22 — `package.json`, `action.yml` and CI all say so. The managed
  // Function runs in Azure on whatever Static Web Apps offers, which is a different runtime in a
  // different place, and this is the one line that says which.
  assert.equal(staticWebAppConfig().platform.apiRuntime, API_RUNTIME);
});
