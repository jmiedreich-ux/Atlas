// Who the caller is, and whether they may write.
//
// Static Web Apps injects `x-ms-client-principal` on every request it has authenticated: a
// base64-encoded JSON object carrying the identity provider, a stable user id, the display name
// and the roles the invitation granted. That header is the ONLY identity the write path accepts.
// A body field naming a user is not identity — it is a value the caller chose — and the tests
// below say so by sending one and watching it be ignored.
//
// Reading the site needs `reader`; writing needs `author`. They are separate roles on purpose, so
// that everyone invited to read the records is not thereby able to commit to them.

import test from 'node:test';
import assert from 'node:assert/strict';

import { AUTHOR_ROLE, authorise } from '../api/lib/principal.mjs';

function header(principal) {
  return Buffer.from(JSON.stringify(principal), 'utf8').toString('base64');
}

const READER = {
  identityProvider: 'aad',
  userId: 'abc123',
  userDetails: 'someone@example.com',
  userRoles: ['anonymous', 'authenticated', 'reader'],
};

const AUTHOR = { ...READER, userRoles: [...READER.userRoles, 'author'] };

test('principal: the writing role is its own, and is not "reader"', () => {
  assert.equal(AUTHOR_ROLE, 'author');
});

test('principal: an authorised caller is identified by the header, and the answer says who', () => {
  const result = authorise({ 'x-ms-client-principal': header(AUTHOR) });
  assert.equal(result.ok, true);
  assert.equal(result.principal.author, 'someone@example.com');
  assert.equal(result.principal.userId, 'abc123');
});

test('principal: a caller with no principal header at all is refused, unauthenticated', () => {
  const result = authorise({});
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.error, 'unauthenticated');
  assert.match(result.message, /x-ms-client-principal/);
});

test('principal: a caller with `reader` but not `author` is refused, and told which role', () => {
  const result = authorise({ 'x-ms-client-principal': header(READER) });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.error, 'forbidden');
  assert.match(result.message, /author/);
  // Naming the role the caller is missing is the whole value of the message: "forbidden" alone
  // sends the owner to the wrong place — the App, the token, the workflow — for a role
  // invitation.
  assert.match(result.message, /reader/);
});

test('principal: `authenticated` alone is not enough — every SWA caller has it', () => {
  const bare = { ...READER, userRoles: ['anonymous', 'authenticated'] };
  const result = authorise({ 'x-ms-client-principal': header(bare) });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});

test('principal: a role named in the BODY is not a role — identity never comes from the payload', () => {
  // The exact shape of a forged request: a reader who has read the source, seen the role name and
  // put it where they can control it.
  const result = authorise(
    { 'x-ms-client-principal': header(READER) },
    { userRoles: ['author'], userDetails: 'someone-else@example.com' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});

test('principal: a header that is not base64 JSON is refused rather than throwing', () => {
  for (const bad of ['not-base64-at-all!!', Buffer.from('{oh no', 'utf8').toString('base64'), '']) {
    const result = authorise({ 'x-ms-client-principal': bad });
    assert.equal(result.ok, false, `${JSON.stringify(bad)} was accepted`);
    assert.equal(result.status, 401);
  }
});

test('principal: a header whose roles are not a list of strings is refused, not coerced', () => {
  for (const roles of ['author', { author: true }, [1, 2], null, undefined]) {
    const result = authorise({ 'x-ms-client-principal': header({ ...READER, userRoles: roles }) });
    assert.equal(result.ok, false, `roles ${JSON.stringify(roles)} were accepted`);
  }
});

test('principal: the header is found whatever case the host used for its name', () => {
  const result = authorise({ 'X-MS-CLIENT-PRINCIPAL': header(AUTHOR) });
  assert.equal(result.ok, true);
});

test('principal: a principal with no display name still commits under something identifying', () => {
  const anonymousish = { ...AUTHOR, userDetails: '' };
  const result = authorise({ 'x-ms-client-principal': header(anonymousish) });
  assert.equal(result.ok, true);
  assert.ok(result.principal.author.includes('abc123'), 'the commit would name nobody');
});

test('principal: a display name cannot smuggle newlines into a commit message or a record', () => {
  const injected = { ...AUTHOR, userDetails: 'someone@example.com\n\n## A heading' };
  const result = authorise({ 'x-ms-client-principal': header(injected) });
  assert.equal(result.ok, true);
  assert.ok(!result.principal.author.includes('\n'), 'a newline reached the author name');
  assert.ok(!result.principal.author.includes('#'), 'a heading marker reached the author name');
});
