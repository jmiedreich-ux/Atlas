// The credential slot, which may be empty.
//
// Decision 36: writes go through a GitHub App, never `GITHUB_TOKEN`, because a push made with the
// Actions token does not trigger workflows — the site would never rebuild after its own write and
// would sit stale showing the answer it failed to render.
//
// The App does not exist until the owner creates it. Everything below is about what happens
// meanwhile: the endpoint refuses clearly, names the settings that are unset, and never produces a
// stack trace. Nothing about reading the site depends on any of it — the site is static files.

import test from 'node:test';
import assert from 'node:assert/strict';

import { readCredential, CREDENTIAL_SETTINGS } from '../api/lib/credentials.mjs';

// A PEM-shaped string. Whether it is a usable key is `api/lib/app-token.mjs`'s problem; this
// module's job is only to notice that the slot is empty.
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n';

const FULL = {
  ATLAS_GITHUB_APP_ID: '123456',
  ATLAS_GITHUB_APP_INSTALLATION_ID: '78901234',
  ATLAS_GITHUB_APP_PRIVATE_KEY: PEM,
  ATLAS_REPO: 'an-owner/a-repo',
};

test('credentials: a full slot resolves, and carries the branch the site is built from', () => {
  const result = readCredential(FULL);
  assert.equal(result.ok, true);
  assert.equal(result.value.appId, '123456');
  assert.equal(result.value.installationId, '78901234');
  assert.equal(result.value.repo, 'an-owner/a-repo');
  // Decision 1: the site is built from `master`, so that is where a write lands unless the
  // project says otherwise.
  assert.equal(result.value.branch, 'master');
});

test('credentials: an empty slot refuses cleanly, naming every setting that is unset', () => {
  const result = readCredential({});
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.error, 'credential-unavailable');
  for (const name of CREDENTIAL_SETTINGS) {
    assert.ok(result.message.includes(name), `the refusal does not name ${name}`);
  }
});

test('credentials: the refusal reads as "not configured yet", not as a fault', () => {
  const { message } = readCredential({});
  // Whoever reads this is looking at a page that works, having pressed a button that did not.
  // The sentence has to tell them nothing is broken. These words are the check because they are
  // the difference between "I should stop and investigate" and "ah, that is not set up yet".
  assert.match(message, /not configured|not yet/i);
  assert.ok(!/error|failed|exception/i.test(message), `the refusal reads as a fault: ${message}`);
});

test('credentials: one missing setting is named on its own, not lost among the others', () => {
  const result = readCredential({ ...FULL, ATLAS_GITHUB_APP_PRIVATE_KEY: '' });
  assert.equal(result.ok, false);
  assert.match(result.message, /ATLAS_GITHUB_APP_PRIVATE_KEY/);
  assert.ok(
    !result.message.includes('ATLAS_GITHUB_APP_ID,'),
    `a setting that IS configured was reported missing: ${result.message}`,
  );
});

test('credentials: whitespace is not a credential', () => {
  const result = readCredential({ ...FULL, ATLAS_GITHUB_APP_ID: '   ' });
  assert.equal(result.ok, false);
  assert.match(result.message, /ATLAS_GITHUB_APP_ID/);
});

test('credentials: no refusal ever quotes the private key back', () => {
  const result = readCredential({ ...FULL, ATLAS_REPO: '' });
  assert.equal(result.ok, false);
  assert.ok(!result.message.includes('MIIB'), 'the refusal contains key material');
  assert.ok(!result.message.includes('BEGIN'), 'the refusal contains key material');
});

test('credentials: a private key pasted with escaped newlines is repaired, because they all are', () => {
  // An application setting in the Azure portal is a single-line text box. A PEM pasted into one
  // arrives with literal backslash-n where its line breaks were, and `crypto.createPrivateKey`
  // rejects it with a message about the header that sends the reader looking at the wrong thing.
  const escaped = PEM.split('\n').join('\\n');
  const result = readCredential({ ...FULL, ATLAS_GITHUB_APP_PRIVATE_KEY: escaped });
  assert.equal(result.ok, true);
  assert.equal(result.value.privateKey, PEM);
});

test('credentials: a base64-wrapped private key is unwrapped, because the CLI hands one over', () => {
  const wrapped = Buffer.from(PEM, 'utf8').toString('base64');
  const result = readCredential({ ...FULL, ATLAS_GITHUB_APP_PRIVATE_KEY: wrapped });
  assert.equal(result.ok, true);
  assert.equal(result.value.privateKey, PEM);
});

test('credentials: a repository that is not owner/name is refused before any request is made', () => {
  for (const repo of ['just-a-name', 'too/many/parts', 'owner /name', 'owner/']) {
    const result = readCredential({ ...FULL, ATLAS_REPO: repo });
    assert.equal(result.ok, false, `${JSON.stringify(repo)} was accepted as a repository`);
    assert.match(result.message, /ATLAS_REPO/);
  }
});

test('credentials: the repository comes from the settings and can never come from a request', () => {
  // Decision 41 and the plan's "no write that can reach a repository other than the configured
  // one". The only argument this function takes is the environment.
  assert.equal(readCredential.length, 1);
  const result = readCredential({ ...FULL, repo: 'somebody-else/their-repo' });
  assert.equal(result.value.repo, 'an-owner/a-repo');
});

test('credentials: a project on a different trunk can say so', () => {
  const result = readCredential({ ...FULL, ATLAS_BRANCH: 'main' });
  assert.equal(result.value.branch, 'main');
});
