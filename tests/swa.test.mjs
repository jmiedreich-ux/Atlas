import test from 'node:test';
import assert from 'node:assert/strict';

import { ACCESS_ROLE, SWA_CONFIG_FILENAME, serialiseSwaConfig, staticWebAppConfig } from '../src/swa.mjs';

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

test('swa: the route Records used to live at redirects to Library rather than 404ing', () => {
  // #780 renamed the surface. The plan for this milestone required the redirect question to be
  // DECIDED rather than left to fall out: links to `/records/` exist in the owner's browser
  // history and possibly in issues, and a 404 there is indistinguishable from a broken site — on a
  // site whose whole premise is that it is always current, that teaches a reader to distrust it.
  //
  // It belongs in the generator rather than in a project's own config because `/records/` was
  // ATLAS's route, in every project Atlas has ever built. It is the generator's own history, not
  // any project's content.
  const config = staticWebAppConfig();
  const routes = config.routes;

  const catchAllIndex = routes.findIndex((route) => route.route === '/*');
  for (const path of ['/records', '/records/*']) {
    const index = routes.findIndex((route) => route.route === path);
    assert.ok(index !== -1, `nothing handles ${path}, so an old link 404s`);
    assert.equal(routes[index].redirect, '/library/', `${path} does not land on the surface that replaced it`);
    assert.equal(routes[index].statusCode, 301, `${path} redirects impermanently, so nothing updates a bookmark`);
    // First-match-wins, so a rule after the catch-all never runs at all.
    assert.ok(index < catchAllIndex, `${path} sits after the catch-all, where it can never match`);
  }
});
