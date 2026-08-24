// `POST /api/refresh`, end to end (M9, decision 61): a content GET for atlas.config.json's
// "workflow" field, then a workflow-dispatch POST — no write, ever. Its own stub because it needs
// both shapes at once: the Contents API `writeback-handlers.test.mjs`'s stub already covers, and
// the Actions dispatch endpoint neither existing stub in this repository answers.

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

import { handleRefresh } from '../api/lib/handlers.mjs';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const ENV = {
  ATLAS_GITHUB_APP_ID: '123456',
  ATLAS_GITHUB_APP_INSTALLATION_ID: '78901234',
  ATLAS_GITHUB_APP_PRIVATE_KEY: privateKey,
  ATLAS_REPO: 'an-owner/a-repo',
};

const NOW = 1_760_000_000;

function principalHeader(roles, userDetails = 'someone@example.com') {
  return {
    'x-ms-client-principal': Buffer.from(
      JSON.stringify({ identityProvider: 'aad', userId: 'abc123', userDetails, userRoles: roles }),
      'utf8',
    ).toString('base64'),
  };
}

const AUTHOR = principalHeader(['anonymous', 'authenticated', 'reader', 'author']);
const READER = principalHeader(['anonymous', 'authenticated', 'reader']);

function reply(status, json) {
  return { ok: status >= 200 && status < 300, status, json: async () => json, text: async () => JSON.stringify(json) };
}

function post(headers, body) {
  return { method: 'POST', headers, body };
}

function deps(fetchImpl, env = ENV) {
  return { env, fetchImpl, nowSeconds: NOW };
}

/**
 * A stub holding one file (`atlas.config.json`, the only thing `handleRefresh` ever reads) and
 * answering the Actions dispatch endpoint. `dispatchStatus` lets a test pick what GitHub says back
 * to the dispatch call — 204 (the real, bodyless success), 404 (no such workflow), 403 (the App
 * lacks the permission), or anything else to exercise the generic-failure path.
 *
 * @param {{ config?: object | null, dispatchStatus?: number }} [opts]
 */
function stub({ config = { workflow: 'atlas.yml' }, dispatchStatus = 204 } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url, method, body: init.body });

    if (url.includes('/access_tokens')) {
      return reply(201, { token: 'ghs_installation', expires_at: 'later' });
    }

    const dispatchMatch = /\/repos\/[^/]+\/[^/]+\/actions\/workflows\/([^/]+)\/dispatches/.exec(url);
    if (dispatchMatch) {
      assert.equal(method, 'POST', 'a dispatch must be a POST');
      calls.dispatchedWorkflow = decodeURIComponent(dispatchMatch[1]);
      calls.dispatchedRef = JSON.parse(init.body).ref;
      if (dispatchStatus === 204) return { ok: true, status: 204, json: async () => null, text: async () => '' };
      return reply(dispatchStatus, { message: `dispatch answered ${dispatchStatus}` });
    }

    const contentsMatch = /\/repos\/[^/]+\/[^/]+\/contents\/([^?]+)/.exec(url);
    if (contentsMatch) {
      const path = decodeURIComponent(contentsMatch[1]);
      if (path !== 'atlas.config.json' || config === null) return reply(404, { message: 'Not Found' });
      return reply(200, {
        type: 'file',
        encoding: 'base64',
        sha: 'a'.repeat(40),
        content: Buffer.from(JSON.stringify(config), 'utf8').toString('base64'),
      });
    }

    return reply(404, { message: 'Not Found' });
  };
  impl.calls = calls;
  return impl;
}

// --- the happy path ------------------------------------------------------------------------------

test('an authorised refresh dispatches the configured workflow on the configured branch', async () => {
  const github = stub();
  const response = await handleRefresh(post(AUTHOR, {}), deps(github));

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.workflow, 'atlas.yml');
  assert.equal(response.body.ref, 'master');
  assert.equal(response.body.triggeredBy, 'someone@example.com');
  assert.equal(github.calls.dispatchedWorkflow, 'atlas.yml');
  assert.equal(github.calls.dispatchedRef, 'master');
});

test('a missing body is the ordinary case, not a refusal', async () => {
  const github = stub();
  const response = await handleRefresh({ method: 'POST', headers: AUTHOR, body: undefined }, deps(github));
  assert.equal(response.status, 200);
});

test('nothing is ever written — no PUT, no contents write of any kind', async () => {
  const github = stub();
  await handleRefresh(post(AUTHOR, {}), deps(github));
  assert.ok(github.calls.every((c) => c.method !== 'PUT'), 'refresh must never write a record');
});

// --- authorisation and the credential slot --------------------------------------------------------

test('a reader (not an author) is refused before anything is attempted', async () => {
  const github = stub();
  const response = await handleRefresh(post(READER, {}), deps(github));
  assert.equal(response.status, 403);
  assert.equal(github.calls.length, 0, 'an unauthorised caller reached the network');
});

test('an unauthenticated caller is refused, and the credential is never read', async () => {
  const github = stub();
  const response = await handleRefresh(post({}, {}), deps(github));
  assert.equal(response.status, 401);
  assert.equal(github.calls.length, 0);
});

test('an empty credential slot refuses clearly, without reaching GitHub', async () => {
  const github = stub();
  const response = await handleRefresh(post(AUTHOR, {}), deps(github, {}));
  assert.equal(response.status, 503);
  assert.equal(response.body.error, 'credential-unavailable');
  assert.equal(github.calls.length, 0);
});

// --- the closed vocabulary -------------------------------------------------------------------------

test('an unexpected field is refused by name, not silently ignored', async () => {
  const github = stub();
  const response = await handleRefresh(post(AUTHOR, { workstream: 'a-stream' }), deps(github));
  assert.equal(response.status, 400);
  assert.match(response.body.message, /"workstream"/);
  assert.equal(github.calls.length, 0, 'a bad payload never reaches GitHub');
});

// --- atlas.config.json's "workflow" field -----------------------------------------------------------

test('atlas.config.json missing the "workflow" field refuses clearly, and dispatches nothing', async () => {
  const github = stub({ config: {} });
  const response = await handleRefresh(post(AUTHOR, {}), deps(github));
  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'no-workflow');
  assert.match(response.body.message, /atlas\.config\.json/);
  assert.equal(github.calls.some((c) => c.url.includes('/dispatches')), false);
});

test('atlas.config.json that is not valid JSON refuses clearly', async () => {
  const github = async (url, init) => {
    if (url.includes('/access_tokens')) return reply(201, { token: 'ghs_installation', expires_at: 'later' });
    if (url.includes('/contents/')) {
      return reply(200, { type: 'file', encoding: 'base64', sha: 'a'.repeat(40), content: Buffer.from('{not json').toString('base64') });
    }
    return reply(404, { message: 'Not Found' });
  };
  const response = await handleRefresh(post(AUTHOR, {}), deps(github));
  assert.equal(response.status, 502);
  assert.equal(response.body.error, 'unreadable-config');
});

// --- what GitHub says back about the dispatch itself -------------------------------------------------

test('GitHub 404ing the workflow name maps to a clear refusal, not a stack trace', async () => {
  const github = stub({ dispatchStatus: 404 });
  const response = await handleRefresh(post(AUTHOR, {}), deps(github));
  assert.equal(response.status, 404);
  assert.equal(response.body.error, 'no-such-workflow');
  assert.match(response.body.message, /atlas\.yml/);
});

test('GitHub 403ing the dispatch names the real cause: the App needs a permission it does not have', async () => {
  const github = stub({ dispatchStatus: 403 });
  const response = await handleRefresh(post(AUTHOR, {}), deps(github));
  assert.equal(response.status, 403);
  assert.equal(response.body.error, 'forbidden-dispatch');
  assert.match(response.body.message, /Actions/i);
  assert.match(response.body.message, /permission/i);
});

test('an unrecognised GitHub failure is reported without a stack trace', async () => {
  const github = stub({ dispatchStatus: 500 });
  const response = await handleRefresh(post(AUTHOR, {}), deps(github));
  assert.equal(response.status, 502);
  assert.ok(!/at handleRefresh|node_modules/.test(response.body.message), 'a stack trace leaked to the caller');
});
