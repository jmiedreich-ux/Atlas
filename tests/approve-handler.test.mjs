// `POST /api/approve`, end to end (M9, decision 59), against an in-memory git repository —
// branches, trees, blobs, commits and a ref that only moves as a fast-forward. `handleApprove`
// moves several files in one commit rather than editing one, so the contents-API stub
// `writeback-handlers.test.mjs` shares does not fit it; this stub is the Git Data API's own shape,
// small enough to hold in one file and real enough that the fast-forward test is an actual race,
// not an assertion about a mock.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';

import { handleApprove } from '../api/lib/handlers.mjs';

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

function hash(...parts) {
  return createHash('sha1').update(parts.join(':')).digest('hex');
}

function reply(status, json) {
  return { ok: status >= 200 && status < 300, status, json: async () => json, text: async () => JSON.stringify(json) };
}

/**
 * An in-memory repository at the Git Data API's own shape: blobs by content hash, a tree that is
 * just the flat file list `readTree(..., recursive=1)` would return, and a branch ref that only
 * accepts a fast-forward — the same rule real GitHub applies, which is what makes the conflict test
 * below a real race instead of an assertion about a mock.
 *
 * @param {Record<string, string>} initialFiles - path -> text.
 */
function githubTree(initialFiles = {}) {
  const blobs = new Map(); // sha -> text
  const files = new Map(); // path -> { sha, mode }
  for (const [path, text] of Object.entries(initialFiles)) {
    const sha = hash('blob', path, text);
    blobs.set(sha, text);
    files.set(path, { sha, mode: '100644' });
  }

  const commits = new Map(); // sha -> { treeFiles: Map(path -> {sha,mode}), parentSha }
  let commitSha = hash('commit', 'root');
  commits.set(commitSha, { treeFiles: new Map(files), parentSha: null });
  const treeShaFor = (sha) => hash('tree', sha); // one tree per commit, addressed by the commit's own sha for simplicity
  let treeSha = treeShaFor(commitSha);
  const treesByTreeSha = new Map([[treeSha, new Map(files)]]);

  const pendingTrees = new Map(); // new tree sha -> Map(path -> {sha,mode})
  const pendingCommits = new Map(); // new commit sha -> { treeSha, parentSha }

  const calls = [];

  const impl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url, method, body: init.body });

    if (url.includes('/access_tokens')) {
      return reply(201, { token: 'ghs_installation', expires_at: 'later' });
    }

    let m;

    if ((m = /\/repos\/[^/]+\/[^/]+\/branches\/([^/?]+)$/.exec(url))) {
      return reply(200, { commit: { sha: commitSha, commit: { tree: { sha: treeSha } } } });
    }

    if ((m = /\/repos\/[^/]+\/[^/]+\/git\/trees\/([^/?]+)/.exec(url))) {
      const wanted = decodeURIComponent(m[1]);
      const flatFiles = treesByTreeSha.get(wanted) ?? pendingTrees.get(wanted);
      if (!flatFiles) return reply(404, { message: 'Not Found' });
      return reply(200, {
        tree: [...flatFiles.entries()].map(([path, entry]) => ({ path, mode: entry.mode, type: 'blob', sha: entry.sha })),
        truncated: false,
      });
    }

    if ((m = /\/repos\/[^/]+\/[^/]+\/git\/blobs\/([^/?]+)$/.exec(url)) && method === 'GET') {
      const sha = decodeURIComponent(m[1]);
      const text = blobs.get(sha);
      if (text === undefined) return reply(404, { message: 'Not Found' });
      return reply(200, { content: Buffer.from(text, 'utf8').toString('base64'), encoding: 'base64', sha });
    }

    if (/\/repos\/[^/]+\/[^/]+\/git\/blobs$/.test(url) && method === 'POST') {
      const sent = JSON.parse(init.body);
      const text = Buffer.from(sent.content, sent.encoding ?? 'base64').toString('utf8');
      const sha = hash('blob', 'new', text, String(blobs.size));
      blobs.set(sha, text);
      return reply(201, { sha });
    }

    if (/\/repos\/[^/]+\/[^/]+\/git\/trees$/.test(url) && method === 'POST') {
      const sent = JSON.parse(init.body);
      const base = treesByTreeSha.get(sent.base_tree) ?? pendingTrees.get(sent.base_tree);
      if (!base) return reply(422, { message: 'base_tree not found' });
      const next = new Map(base);
      for (const entry of sent.tree) {
        if (entry.sha === null) next.delete(entry.path);
        else next.set(entry.path, { sha: entry.sha, mode: entry.mode });
      }
      const newTreeSha = hash('tree', 'new', JSON.stringify([...next.entries()]));
      pendingTrees.set(newTreeSha, next);
      return reply(201, { sha: newTreeSha });
    }

    if (/\/repos\/[^/]+\/[^/]+\/git\/commits$/.test(url) && method === 'POST') {
      const sent = JSON.parse(init.body);
      const newCommitSha = hash('commit', 'new', sent.tree, sent.parents[0], String(commits.size));
      pendingCommits.set(newCommitSha, { treeSha: sent.tree, parentSha: sent.parents[0] });
      return reply(201, { sha: newCommitSha });
    }

    if ((m = /\/repos\/[^/]+\/[^/]+\/git\/refs\/heads\/([^/?]+)$/.exec(url)) && method === 'PATCH') {
      const sent = JSON.parse(init.body);
      const candidate = pendingCommits.get(sent.sha);
      if (!candidate) return reply(422, { message: 'unknown commit' });
      // The real fast-forward rule: the new commit's parent must be the branch's CURRENT tip.
      if (candidate.parentSha !== commitSha) {
        return reply(422, { message: 'Update is not a fast forward' });
      }
      commitSha = sent.sha;
      treeSha = candidate.treeSha;
      commits.set(commitSha, { treeFiles: pendingTrees.get(treeSha), parentSha: candidate.parentSha });
      treesByTreeSha.set(treeSha, pendingTrees.get(treeSha));
      return reply(200, { object: { sha: commitSha } });
    }

    return reply(404, { message: `no route in the stub for ${method} ${url}` });
  };

  impl.calls = calls;
  impl.currentFiles = () => new Map(treesByTreeSha.get(treeSha));
  // Simulates a real push landing on the branch between this call's readBranch and its updateRef —
  // the same honest way `writeback-handlers.test.mjs`'s `someoneElseCommits` produces a stale write.
  impl.someoneElseCommits = (path, text) => {
    const sha = hash('blob', 'race', path, text);
    blobs.set(sha, text);
    const next = new Map(treesByTreeSha.get(treeSha));
    next.set(path, { sha, mode: '100644' });
    const newTreeSha = hash('tree', 'race', JSON.stringify([...next.entries()]));
    treesByTreeSha.set(newTreeSha, next);
    const newCommitSha = hash('commit', 'race', newTreeSha);
    commits.set(newCommitSha, { treeFiles: next, parentSha: commitSha });
    commitSha = newCommitSha;
    treeSha = newTreeSha;
  };
  return impl;
}

function deps(fetchImpl, env = ENV) {
  return { env, fetchImpl, nowSeconds: NOW };
}

function post(headers, body) {
  return { method: 'POST', headers, body };
}

const SLUG = 'keystone';
const CONFIG = JSON.stringify({ project: 'Vennusign', repo: 'an-owner/a-repo', workstreams: ['other-stream'] }, null, 2) + '\n';

function repoWithProposal(extraFiles = {}) {
  return githubTree({
    'atlas.config.json': CONFIG,
    [`docs/design/proposed/${SLUG}/decisions.md`]: '# Keystone decisions\n',
    [`docs/design/proposed/${SLUG}/decisions.html`]: '<h1>Keystone decisions</h1>\n',
    // Not in a slug folder — a separate loose-file proposal, "some-other-file", left alone by
    // every test targeting SLUG. Its own approvability is exercised below.
    'docs/design/proposed/some-other-file.md': 'a proposal that never got its own directory\n',
    ...extraFiles,
  });
}

// --- the happy path ------------------------------------------------------------------------------

test('approve: an authorised request moves the proposal, scaffolds it, and registers it — in one commit', async () => {
  const github = repoWithProposal();
  const response = await handleApprove(post(AUTHOR, { slug: SLUG }), deps(github));

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.slug, SLUG);
  assert.equal(response.body.featurePath, `docs/features/${SLUG}/`);

  const files = github.currentFiles();
  assert.ok(!files.has(`docs/design/proposed/${SLUG}/decisions.md`), 'the proposed file was not moved out');
  assert.ok(files.has(`docs/features/${SLUG}/decisions.md`), 'the moved design file never landed');
  assert.ok(files.has(`docs/features/${SLUG}/decisions.html`), 'a sibling proposed file was left behind');
  assert.ok(files.has(`docs/features/${SLUG}/workstream.json`), 'no manifest was written');
  assert.ok(files.has(`docs/features/${SLUG}/m1-plan.md`), 'no plan was written');
});

test('approve: the moved file keeps its exact content — a move is a tree change, not a re-upload', async () => {
  const github = repoWithProposal();
  const before = github.currentFiles().get(`docs/design/proposed/${SLUG}/decisions.md`).sha;
  await handleApprove(post(AUTHOR, { slug: SLUG }), deps(github));
  const after = github.currentFiles().get(`docs/features/${SLUG}/decisions.md`).sha;
  // A git blob is content-addressed: the SAME sha at the new path proves the content moved without
  // being re-read and re-uploaded — the handler never called `createBlob` for it.
  assert.equal(after, before);
  const blobPosts = github.calls.filter((c) => c.url.endsWith('/git/blobs') && c.method === 'POST');
  assert.equal(blobPosts.length, 3, 'expected exactly 3 new blobs (manifest, plan, config) — a moved file was re-uploaded');
});

test('approve: the manifest is schema-shaped and scaffolded exactly as the CLI would write it', async () => {
  const github = repoWithProposal();
  await handleApprove(post(AUTHOR, { slug: SLUG }), deps(github));
  const files = github.currentFiles();
  const manifestSha = files.get(`docs/features/${SLUG}/workstream.json`).sha;
  const manifestText = [...github.calls]
    .filter((c) => c.url.endsWith('/git/blobs') && c.method === 'POST')
    .map((c) => JSON.parse(c.body))
    .find((sent) => Buffer.from(sent.content, 'base64').toString('utf8').includes('"codename"'));
  assert.ok(manifestText, 'no manifest blob was created');
  const manifest = JSON.parse(Buffer.from(manifestText.content, 'base64').toString('utf8'));
  assert.equal(manifest.codename, 'Keystone');
  assert.equal(manifest.stage, 'designing');
  assert.equal(manifest.milestones[0].id, 'M1');
  assert.match(manifest.next, /<<.*replace.*>>/i);
});

test('approve: atlas.config.json gains the slug, keeping what was already there', async () => {
  const github = repoWithProposal();
  await handleApprove(post(AUTHOR, { slug: SLUG }), deps(github));
  const configBlob = [...github.calls]
    .filter((c) => c.url.endsWith('/git/blobs') && c.method === 'POST')
    .map((c) => JSON.parse(c.body))
    .map((sent) => Buffer.from(sent.content, 'base64').toString('utf8'))
    .find((text) => text.includes('"workstreams"'));
  assert.ok(configBlob);
  const config = JSON.parse(configBlob);
  assert.deepEqual(config.workstreams.sort(), ['keystone', 'other-stream']);
});

test('approve: the commit message names the slug and who approved it', async () => {
  const github = repoWithProposal();
  await handleApprove(post(AUTHOR, { slug: SLUG }), deps(github));
  const commitCall = github.calls.find((c) => c.url.endsWith('/git/commits') && c.method === 'POST');
  const sent = JSON.parse(commitCall.body);
  assert.match(sent.message, /approve keystone/);
  assert.match(sent.message, /someone@example\.com/);
});

// --- authorisation, same as the other three writes ------------------------------------------------

test('approve: a caller with only "reader" is refused before anything is read', async () => {
  const github = repoWithProposal();
  const response = await handleApprove(post(READER, { slug: SLUG }), deps(github));
  assert.equal(response.status, 403);
  assert.equal(github.calls.filter((c) => c.method !== 'POST' || !c.url.includes('access_tokens')).length, 0);
});

test('approve: an unauthenticated request is a 401, and nothing is requested at all', async () => {
  const github = repoWithProposal();
  const response = await handleApprove(post({}, { slug: SLUG }), deps(github));
  assert.equal(response.status, 401);
  assert.equal(github.calls.length, 0);
});

// --- the preconditions (mirrors src/scaffold.mjs's checkPreconditions) ---------------------------

test('approve: a slug with nothing under proposed/ is refused by name', async () => {
  const github = repoWithProposal();
  const response = await handleApprove(post(AUTHOR, { slug: 'no-such-slug' }), deps(github));
  assert.equal(response.status, 404);
  assert.equal(response.body.error, 'no-such-proposal');
});

test('approve: a loose file with no slug directory of its own moves and scaffolds end to end', async () => {
  // The ordinary shape a real proposal takes — confirmed against a real project's proposed/, not
  // the exception `checkPreconditions` was originally written around.
  const github = repoWithProposal();
  const response = await handleApprove(post(AUTHOR, { slug: 'some-other-file' }), deps(github));

  assert.equal(response.status, 200);
  assert.equal(response.body.featurePath, 'docs/features/some-other-file/');
  const files = github.currentFiles();
  assert.ok(!files.has('docs/design/proposed/some-other-file.md'), 'the loose file was not moved out');
  assert.ok(files.has('docs/features/some-other-file/some-other-file.md'), 'the loose file never landed');
  assert.ok(files.has('docs/features/some-other-file/workstream.json'), 'no manifest was scaffolded');
});

test('approve: a slug whose destination already has a colliding file is refused rather than overwritten', async () => {
  const github = repoWithProposal({ [`docs/features/${SLUG}/decisions.md`]: 'already here' });
  const response = await handleApprove(post(AUTHOR, { slug: SLUG }), deps(github));
  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'name-collision');
});

test('approve: a slug already scaffolded still moves its design in, without touching the existing manifest', async () => {
  // Real case, not hypothetical: this is exactly keystone and platform-operations today — a real
  // manifest predating `approve`, design still sitting in proposed/. See planApproval's own header.
  const existingManifest = JSON.stringify({ codename: 'Keystone', stage: 'planned', marker: 'do-not-touch' });
  const github = repoWithProposal({ [`docs/features/${SLUG}/workstream.json`]: existingManifest });
  const manifestShaBefore = github.currentFiles().get(`docs/features/${SLUG}/workstream.json`).sha;

  const response = await handleApprove(post(AUTHOR, { slug: SLUG }), deps(github));

  assert.equal(response.status, 200);
  const files = github.currentFiles();
  assert.ok(!files.has(`docs/design/proposed/${SLUG}/decisions.md`), 'the proposed file was not moved out');
  assert.ok(files.has(`docs/features/${SLUG}/decisions.md`), 'the moved design file never landed');

  // A git blob is content-addressed: the SAME sha after the call is proof the manifest was never
  // re-read and re-written, not just that its text happens to still match.
  assert.equal(files.get(`docs/features/${SLUG}/workstream.json`).sha, manifestShaBefore);
});

test('approve: does not write a first-milestone plan when a manifest already exists', async () => {
  const github = repoWithProposal({ [`docs/features/${SLUG}/workstream.json`]: '{"codename":"Keystone"}' });
  await handleApprove(post(AUTHOR, { slug: SLUG }), deps(github));
  const files = github.currentFiles();
  assert.ok(!files.has(`docs/features/${SLUG}/m1-plan.md`), 'a plan was scaffolded despite an existing manifest');
});

// --- the payload -----------------------------------------------------------------------------------

test('approve: a request naming a path instead of a slug is rejected, not traversed', async () => {
  const github = repoWithProposal();
  const response = await handleApprove(post(AUTHOR, { slug: '../../etc' }), deps(github));
  assert.equal(response.status, 400);
});

test('approve: an unknown field is rejected by name, same as the other three endpoints', async () => {
  const github = repoWithProposal();
  const response = await handleApprove(post(AUTHOR, { slug: SLUG, sha: 'x'.repeat(40) }), deps(github));
  assert.equal(response.status, 400);
  assert.match(response.body.message, /"sha"/);
});

// --- the race: this is what the tree client's fast-forward-only ref update is for ------------------

test('approve: a commit landing on the branch mid-request is a conflict, and the proposal survives', async () => {
  const github = repoWithProposal();
  const originalFetch = github;
  // Race: something else commits to the branch after the handler reads it, before it can move
  // the ref. `updateRef` refuses because the new commit is no longer a fast-forward.
  const raced = async (url, init) => {
    if (/\/repos\/[^/]+\/[^/]+\/git\/refs\/heads\//.test(url) && (init?.method ?? 'GET') === 'PATCH') {
      github.someoneElseCommits('docs/unrelated.md', 'a change from someone else');
    }
    return originalFetch(url, init);
  };
  raced.calls = github.calls;

  const response = await handleApprove(post(AUTHOR, { slug: SLUG }), deps(raced));
  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'conflict');

  const files = github.currentFiles();
  assert.ok(files.has(`docs/design/proposed/${SLUG}/decisions.md`), 'the proposed file was moved despite the conflict');
  assert.ok(!files.has(`docs/features/${SLUG}/workstream.json`), 'the manifest was written despite the conflict');
});
