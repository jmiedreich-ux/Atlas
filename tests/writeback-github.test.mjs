// The GitHub App path: a signed assertion, an installation token, and the contents API that both
// commits and gives optimistic concurrency for free.
//
// No network. Every request is answered by a stub, the way `src/github.mjs` takes an injected
// `fetchImpl` — the generator's one tolerated failure mode is GitHub being unreachable, and a test
// suite that could reach GitHub would be the same unreliability from the other end.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';

import { fetchInstallationToken, signAppJwt } from '../api/lib/app-token.mjs';
import { GitHubError, createContentsClient, createTreeClient } from '../api/lib/github.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const NOW = 1_760_000_000; // A fixed second. Nothing in this suite reads a clock.

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

// A stub that records what it was asked and replies from a script.
function stubFetch(script) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    const reply = typeof script === 'function' ? script(url, init, calls.length) : script;
    if (reply instanceof Error) throw reply;
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.json,
      text: async () => JSON.stringify(reply.json ?? ''),
    };
  };
  impl.calls = calls;
  return impl;
}

// --- signing ---------------------------------------------------------------------------------

test('app token: the assertion is an RS256 JWT the App\'s own public key verifies', () => {
  const jwt = signAppJwt({ appId: '123456', privateKey, nowSeconds: NOW });
  const [header, payload, signature] = jwt.split('.');

  assert.deepEqual(decodeSegment(header), { alg: 'RS256', typ: 'JWT' });

  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${header}.${payload}`);
  assert.ok(
    verifier.verify(createPublicKey(publicKey), Buffer.from(signature, 'base64url')),
    'the signature does not verify against the key that made it',
  );
});

test('app token: the assertion is issued in the past and expires inside GitHub\'s ten minutes', () => {
  const claims = decodeSegment(signAppJwt({ appId: '123456', privateKey, nowSeconds: NOW }).split('.')[1]);
  assert.equal(claims.iss, '123456');
  // GitHub rejects an assertion whose `iat` is in its own future, and clocks between a Function
  // host and GitHub do not agree to the second. Backdating is what makes that survivable.
  assert.ok(claims.iat < NOW, `iat ${claims.iat} is not backdated from ${NOW}`);
  assert.ok(NOW - claims.iat <= 60, 'the assertion is backdated further than GitHub allows');
  assert.ok(claims.exp > NOW, 'the assertion is already expired');
  assert.ok(claims.exp - claims.iat <= 600, 'GitHub refuses an assertion longer than ten minutes');
});

test('app token: a private key that is not a key fails as a refusal, not as a stack trace', () => {
  assert.throws(
    () => signAppJwt({ appId: '1', privateKey: 'not a key at all', nowSeconds: NOW }),
    (error) => error instanceof GitHubError && /private key/i.test(error.message),
  );
});

// --- exchanging it for an installation token ---------------------------------------------------

test('app token: the assertion is exchanged for an installation token, at the installation', () => {
  const fetchImpl = stubFetch({ status: 201, json: { token: 'ghs_installation', expires_at: 'later' } });

  return fetchInstallationToken({
    appId: '123456',
    installationId: '78901234',
    privateKey,
    nowSeconds: NOW,
    fetchImpl,
  }).then((token) => {
    assert.equal(token, 'ghs_installation');
    const [call] = fetchImpl.calls;
    assert.equal(call.method, 'POST');
    assert.match(call.url, /\/app\/installations\/78901234\/access_tokens$/);
    assert.match(call.headers.Authorization, /^Bearer eyJ/);
  });
});

test('app token: GitHub refusing the App is reported as the App, not as the caller\'s fault', async () => {
  const fetchImpl = stubFetch({ status: 401, json: { message: 'A JSON web token could not be decoded' } });
  await assert.rejects(
    fetchInstallationToken({ appId: '1', installationId: '2', privateKey, nowSeconds: NOW, fetchImpl }),
    (error) => {
      assert.ok(error instanceof GitHubError);
      assert.equal(error.status, 502);
      assert.match(error.message, /GitHub App/);
      return true;
    },
  );
});

test('app token: GitHub being unreachable is a refusal too, and never leaks the assertion', async () => {
  const fetchImpl = stubFetch(new TypeError('fetch failed'));
  await assert.rejects(
    fetchInstallationToken({ appId: '1', installationId: '2', privateKey, nowSeconds: NOW, fetchImpl }),
    (error) => {
      assert.ok(error instanceof GitHubError);
      assert.ok(!error.message.includes('eyJ'), 'the refusal quotes the signed assertion back');
      return true;
    },
  );
});

// --- the contents API -------------------------------------------------------------------------

function client(fetchImpl) {
  return createContentsClient({ repo: 'an-owner/a-repo', token: 'ghs_x', fetchImpl });
}

test('contents: a record is read back as text, with the SHA the write will need', async () => {
  const fetchImpl = stubFetch({
    status: 200,
    json: {
      type: 'file',
      encoding: 'base64',
      sha: 'sha-one',
      // GitHub wraps its base64 at 60 columns. A decoder that forgets is one that works on short
      // files and truncates long ones.
      content: Buffer.from('# A record\n', 'utf8').toString('base64') + '\n',
    },
  });

  const result = await client(fetchImpl).read('docs/features/a-stream/open-questions.md', 'master');
  assert.equal(result.text, '# A record\n');
  assert.equal(result.sha, 'sha-one');
  assert.match(fetchImpl.calls[0].url, /repos\/an-owner\/a-repo\/contents\//);
  assert.match(fetchImpl.calls[0].url, /ref=master/);
});

test('contents: a path with a space is requested as a path, not as a broken URL', async () => {
  const fetchImpl = stubFetch({
    status: 200,
    json: { type: 'file', encoding: 'base64', sha: 's', content: Buffer.from('x').toString('base64') },
  });
  await client(fetchImpl).read('docs/field notes/a.md', 'master');
  assert.match(fetchImpl.calls[0].url, /field%20notes/);
  assert.ok(!fetchImpl.calls[0].url.includes('field notes'), 'the path went out unencoded');
});

test('contents: a record that is not there is reported as missing, naming the path', async () => {
  const fetchImpl = stubFetch({ status: 404, json: { message: 'Not Found' } });
  await assert.rejects(client(fetchImpl).read('docs/features/a-stream/open-questions.md', 'master'), (error) => {
    assert.equal(error.status, 404);
    assert.match(error.message, /docs\/features\/a-stream\/open-questions\.md/);
    return true;
  });
});

test('contents: a directory where a record was expected is refused rather than decoded', async () => {
  const fetchImpl = stubFetch({ status: 200, json: [{ name: 'a.md' }] });
  await assert.rejects(client(fetchImpl).read('docs/features/a-stream', 'master'), (error) => {
    assert.match(error.message, /directory/);
    return true;
  });
});

test('contents: a record too large for the contents API is named, not silently emptied', async () => {
  // Over a megabyte, GitHub answers with `encoding: "none"` and an empty `content`. Decoding that
  // as though it were the file writes an empty record over a real one.
  const fetchImpl = stubFetch({ status: 200, json: { type: 'file', encoding: 'none', sha: 's', content: '' } });
  await assert.rejects(client(fetchImpl).read('docs/big.md', 'master'), (error) => {
    assert.match(error.message, /docs\/big\.md/);
    assert.match(error.message, /too large/i);
    return true;
  });
});

test('contents: a write is a PUT carrying the SHA it read, and answers with the commit', async () => {
  const fetchImpl = stubFetch({
    status: 200,
    json: { commit: { html_url: 'https://github.com/an-owner/a-repo/commit/abc', sha: 'abc' }, content: { sha: 'sha-two' } },
  });

  const result = await client(fetchImpl).write({
    path: 'docs/features/a-stream/open-questions.md',
    message: 'atlas: answer Q1',
    text: '# A record\n',
    sha: 'sha-one',
    branch: 'master',
  });

  assert.equal(result.commitUrl, 'https://github.com/an-owner/a-repo/commit/abc');
  const [call] = fetchImpl.calls;
  assert.equal(call.method, 'PUT');
  const sent = JSON.parse(call.body);
  assert.equal(sent.sha, 'sha-one', 'the write did not carry the SHA it read');
  assert.equal(sent.branch, 'master');
  assert.equal(Buffer.from(sent.content, 'base64').toString('utf8'), '# A record\n');
});

test('contents: a stale SHA comes back as a conflict, and nothing is retried without one', async () => {
  // GitHub answers 409 when the SHA no longer matches the file. This is the whole optimistic
  // concurrency story: the caller is told, rather than the other person's commit being overwritten.
  const fetchImpl = stubFetch({ status: 409, json: { message: 'is at 9f8e7d6 but expected 1a2b3c4' } });

  await assert.rejects(
    client(fetchImpl).write({ path: 'docs/a.md', message: 'm', text: 'x', sha: 'stale', branch: 'master' }),
    (error) => {
      assert.ok(error instanceof GitHubError);
      assert.equal(error.status, 409);
      assert.equal(error.code, 'conflict');
      return true;
    },
  );

  assert.equal(fetchImpl.calls.length, 1, 'the write was retried, which would overwrite somebody');
});

test('contents: GitHub\'s other refusal for a stale SHA — a 422 — is a conflict too', async () => {
  // The contents API answers 422 rather than 409 for some stale-SHA cases, and always with this
  // sentence. Treating it as a generic failure would tell the caller to try again, which is the
  // one thing that must not be suggested.
  const fetchImpl = stubFetch({ status: 422, json: { message: 'sha does not match' } });
  await assert.rejects(
    client(fetchImpl).write({ path: 'docs/a.md', message: 'm', text: 'x', sha: 'stale', branch: 'master' }),
    (error) => {
      assert.equal(error.code, 'conflict');
      assert.equal(error.status, 409);
      return true;
    },
  );
});

test('contents: no request this client makes can name a repository other than the configured one', async () => {
  const fetchImpl = stubFetch({
    status: 200,
    json: { type: 'file', encoding: 'base64', sha: 's', content: Buffer.from('x').toString('base64') },
  });
  const c = createContentsClient({ repo: 'an-owner/a-repo', token: 't', fetchImpl });
  // A path that tries to climb out of the repository segment of the URL.
  await assert.rejects(c.read('../../somebody-else/their-repo/contents/secret.md', 'master'), (error) => {
    assert.match(error.message, /repository-relative/);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 0, 'a request was made for a path that should never be requested');
});

// --- relayed upstream text carries no URL, and so no repository slug ------------------------------

test('contents: GitHub\'s own error text is relayed with any URL taken out of it', async () => {
  // GitHub's 4xx bodies carry a `documentation_url`, and its messages sometimes carry the API URL
  // — which contains `owner/repo`. undici's network errors do the same by another route. The text
  // is worth relaying because it is often the only clue about what went wrong; the URLs in it are
  // not, and they are the part that names the deployment's repository.
  const fetchImpl = stubFetch({
    status: 403,
    json: {
      message:
        'Resource not accessible by integration — see ' +
        'https://api.github.com/repos/an-owner/a-repo/contents/docs/x.md',
      documentation_url: 'https://docs.github.com/rest',
    },
  });

  await assert.rejects(client(fetchImpl).read('docs/x.md', 'master'), (error) => {
    assert.match(error.message, /Resource not accessible by integration/, 'the useful text was dropped');
    assert.ok(!error.message.includes('an-owner/a-repo'), `the repository leaked: ${error.message}`);
    assert.ok(!/https?:\/\//.test(error.message), `a URL leaked: ${error.message}`);
    return true;
  });
});

test('contents: a network error message is relayed the same way', async () => {
  const fetchImpl = stubFetch(
    new TypeError('fetch failed: connect ECONNREFUSED https://api.github.com/repos/an-owner/a-repo/contents/x'),
  );
  await assert.rejects(client(fetchImpl).read('docs/x.md', 'master'), (error) => {
    assert.ok(!error.message.includes('an-owner/a-repo'), `the repository leaked: ${error.message}`);
    assert.ok(!/https?:\/\//.test(error.message), `a URL leaked: ${error.message}`);
    return true;
  });
});

test('app token: the same, on the two paths that report an App failure', async () => {
  const refused = stubFetch({
    status: 401,
    json: { message: 'Bad credentials for https://api.github.com/repos/an-owner/a-repo' },
  });
  await assert.rejects(
    fetchInstallationToken({ appId: '1', installationId: '2', privateKey, nowSeconds: NOW, fetchImpl: refused }),
    (error) => {
      assert.ok(!/https?:\/\//.test(error.message), `a URL leaked: ${error.message}`);
      return true;
    },
  );

  const unreachable = stubFetch(
    new TypeError('fetch failed https://api.github.com/app/installations/2/access_tokens'),
  );
  await assert.rejects(
    fetchInstallationToken({ appId: '1', installationId: '2', privateKey, nowSeconds: NOW, fetchImpl: unreachable }),
    (error) => {
      assert.ok(!/https?:\/\//.test(error.message), `a URL leaked: ${error.message}`);
      return true;
    },
  );
});

test('app token: a key that will not sign is reported without quoting a URL either', () => {
  assert.throws(
    () => signAppJwt({ appId: '1', privateKey: 'not a key at all', nowSeconds: NOW }),
    (error) => {
      assert.ok(!/https?:\/\//.test(error.message), `a URL leaked: ${error.message}`);
      return true;
    },
  );
});

// --- the tree client (M9, decision 59) -----------------------------------------------------------

function treeClient(fetchImpl) {
  return createTreeClient({ repo: 'an-owner/a-repo', token: 'ghs_x', fetchImpl });
}

test('tree: readBranch reads the commit and tree SHAs a branch currently points at', async () => {
  const fetchImpl = stubFetch({
    status: 200,
    json: { commit: { sha: 'commit-1', commit: { tree: { sha: 'tree-1' } } } },
  });
  const result = await treeClient(fetchImpl).readBranch('master');
  assert.deepEqual(result, { commitSha: 'commit-1', treeSha: 'tree-1' });
  assert.match(fetchImpl.calls[0].url, /\/branches\/master$/);
});

test('tree: a branch that does not exist is named in the refusal', async () => {
  const fetchImpl = stubFetch({ status: 404, json: { message: 'Branch not found' } });
  await assert.rejects(treeClient(fetchImpl).readBranch('no-such-branch'), (error) => {
    assert.equal(error.status, 404);
    assert.match(error.message, /no-such-branch/);
    return true;
  });
});

test('tree: readTree returns the flat, recursive blob listing', async () => {
  const fetchImpl = stubFetch({
    status: 200,
    json: { tree: [{ path: 'a.md', mode: '100644', type: 'blob', sha: 's1' }], truncated: false },
  });
  const result = await treeClient(fetchImpl).readTree('tree-1');
  assert.deepEqual(result, [{ path: 'a.md', mode: '100644', type: 'blob', sha: 's1' }]);
  assert.match(fetchImpl.calls[0].url, /git\/trees\/tree-1\?recursive=1/);
});

test('tree: a truncated tree listing is refused rather than acted on partially', async () => {
  const fetchImpl = stubFetch({ status: 200, json: { tree: [], truncated: true } });
  await assert.rejects(treeClient(fetchImpl).readTree('tree-1'), (error) => {
    assert.equal(error.code, 'tree-truncated');
    return true;
  });
});

test('tree: readBlob decodes a blob\'s content by its own SHA', async () => {
  const fetchImpl = stubFetch({
    status: 200,
    json: { content: Buffer.from('hello\n', 'utf8').toString('base64'), encoding: 'base64', sha: 's1' },
  });
  const text = await treeClient(fetchImpl).readBlob('s1');
  assert.equal(text, 'hello\n');
});

test('tree: createBlob POSTs base64 content and returns the new SHA', async () => {
  const fetchImpl = stubFetch({ status: 201, json: { sha: 'new-blob-sha' } });
  const sha = await treeClient(fetchImpl).createBlob('hello\n');
  assert.equal(sha, 'new-blob-sha');
  const sent = JSON.parse(fetchImpl.calls[0].body);
  assert.equal(Buffer.from(sent.content, 'base64').toString('utf8'), 'hello\n');
  assert.match(fetchImpl.calls[0].url, /git\/blobs$/);
});

test('tree: createTree POSTs the base tree and entries, and validates every entry path', async () => {
  const fetchImpl = stubFetch({ status: 201, json: { sha: 'new-tree-sha' } });
  const sha = await treeClient(fetchImpl).createTree({
    baseTreeSha: 'tree-1',
    entries: [{ path: 'docs/a.md', mode: '100644', type: 'blob', sha: 's1' }],
  });
  assert.equal(sha, 'new-tree-sha');
  const sent = JSON.parse(fetchImpl.calls[0].body);
  assert.equal(sent.base_tree, 'tree-1');
  assert.equal(sent.tree[0].path, 'docs/a.md');
});

test('tree: createTree refuses an entry path that tries to climb out of the repository', async () => {
  const fetchImpl = stubFetch({ status: 201, json: { sha: 'x' } });
  await assert.rejects(
    treeClient(fetchImpl).createTree({
      baseTreeSha: 'tree-1',
      entries: [{ path: '../../outside.md', mode: '100644', type: 'blob', sha: 's1' }],
    }),
    (error) => {
      assert.match(error.message, /repository-relative/);
      return true;
    },
  );
  assert.equal(fetchImpl.calls.length, 0, 'a request was made for a path that should never be requested');
});

test('tree: createCommit POSTs exactly one parent — Atlas never writes a merge', async () => {
  const fetchImpl = stubFetch({ status: 201, json: { sha: 'new-commit-sha' } });
  const sha = await treeClient(fetchImpl).createCommit({ treeSha: 'tree-2', parentSha: 'commit-1', message: 'atlas: approve x' });
  assert.equal(sha, 'new-commit-sha');
  const sent = JSON.parse(fetchImpl.calls[0].body);
  assert.deepEqual(sent.parents, ['commit-1']);
  assert.equal(sent.tree, 'tree-2');
  assert.equal(sent.message, 'atlas: approve x');
});

test('tree: updateRef moves the branch as a fast-forward, force: false always', async () => {
  const fetchImpl = stubFetch({ status: 200, json: { object: { sha: 'new-commit-sha' } } });
  const result = await treeClient(fetchImpl).updateRef({ branch: 'master', commitSha: 'new-commit-sha' });
  assert.equal(result.commitUrl, 'https://github.com/an-owner/a-repo/commit/new-commit-sha');
  const sent = JSON.parse(fetchImpl.calls[0].body);
  assert.equal(sent.sha, 'new-commit-sha');
  assert.equal(sent.force, false);
  assert.match(fetchImpl.calls[0].url, /git\/refs\/heads\/master$/);
});

test('tree: a non-fast-forward ref update is a conflict, the same shape a stale SHA answers with', async () => {
  const fetchImpl = stubFetch({ status: 422, json: { message: 'Update is not a fast forward' } });
  await assert.rejects(
    treeClient(fetchImpl).updateRef({ branch: 'master', commitSha: 'x' }),
    (error) => {
      assert.ok(error instanceof GitHubError);
      assert.equal(error.status, 409);
      assert.equal(error.code, 'conflict');
      return true;
    },
  );
});

test('tree: a 409 on the ref update is a conflict too', async () => {
  const fetchImpl = stubFetch({ status: 409, json: { message: 'reference update failed' } });
  await assert.rejects(treeClient(fetchImpl).updateRef({ branch: 'master', commitSha: 'x' }), (error) => {
    assert.equal(error.code, 'conflict');
    return true;
  });
});
