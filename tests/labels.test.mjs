import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureWorkstreamLabels, parseArgv } from '../src/labels.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, '..', 'fixture');
const REPO = 'atlas-fixtures/lighthouse';
const TOKEN = 'secret-token';

// The fixture's own six workstreams, each declaring "workstream:<slug>" (confirmed against the
// real fixture manifests rather than assumed).
const ALL_LABELS = ['workstream:beacon', 'workstream:tide', 'workstream:reef', 'workstream:harbor', 'workstream:anchor', 'workstream:shoal'];

function fetchImplFor({ existingLabels = [], failCreateFor = [], openIssues = [] } = {}) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const method = options.method ?? 'GET';

    const getLabel = /\/labels\/([^/]+)$/.exec(String(url));
    if (getLabel && method === 'GET') {
      const name = decodeURIComponent(getLabel[1]);
      return existingLabels.includes(name)
        ? { ok: true, status: 200, json: async () => ({ name }) }
        : { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    }

    if (/\/labels$/.test(String(url)) && method === 'POST') {
      const body = JSON.parse(options.body);
      if (failCreateFor.includes(body.name)) {
        return { ok: false, status: 422, json: async () => ({ message: 'Validation Failed' }) };
      }
      return { ok: true, status: 201, json: async () => body };
    }

    if (/\/issues\?/.test(String(url)) && method === 'GET') {
      return { ok: true, status: 200, json: async () => openIssues };
    }

    throw new Error(`unexpected request in test: ${method} ${url}`);
  };
  impl.calls = calls;
  return impl;
}

test('ensureWorkstreamLabels: creates every workstream label that does not yet exist', async () => {
  const fetchImpl = fetchImplFor({ existingLabels: ['workstream:beacon'] });
  const result = await ensureWorkstreamLabels({ projectRoot: FIXTURE_ROOT, token: TOKEN, fetchImpl });

  assert.deepEqual(result.alreadyExisted, ['workstream:beacon']);
  assert.deepEqual(
    result.created.sort(),
    ALL_LABELS.filter((l) => l !== 'workstream:beacon').sort(),
  );
});

test('ensureWorkstreamLabels: a label that already exists is left alone, not recreated', async () => {
  const fetchImpl = fetchImplFor({ existingLabels: ALL_LABELS });
  await ensureWorkstreamLabels({ projectRoot: FIXTURE_ROOT, token: TOKEN, fetchImpl });

  const posts = fetchImpl.calls.filter((c) => (c.options.method ?? 'GET') === 'POST');
  assert.equal(posts.length, 0, 'no label should have been created when every label already exists');
});

test('ensureWorkstreamLabels: checks before creating — GET first, POST only on a real 404', async () => {
  const fetchImpl = fetchImplFor({ existingLabels: [] });
  await ensureWorkstreamLabels({ projectRoot: FIXTURE_ROOT, token: TOKEN, fetchImpl });

  const first = fetchImpl.calls[0];
  assert.equal(first.options.method ?? 'GET', 'GET');
  assert.match(first.url, /\/labels\/workstream%3Abeacon$/);
});

test('ensureWorkstreamLabels: an unexpected GET failure (not 404) is a real error, not silently treated as missing', async () => {
  const fetchImpl = async (url, options = {}) => {
    if (/\/labels\/[^/]+$/.test(String(url)) && (options.method ?? 'GET') === 'GET') {
      return { ok: false, status: 500, json: async () => ({ message: 'Internal Server Error' }) };
    }
    throw new Error('should not reach here');
  };
  await assert.rejects(
    () => ensureWorkstreamLabels({ projectRoot: FIXTURE_ROOT, token: TOKEN, fetchImpl }),
    /500/,
  );
});

test('ensureWorkstreamLabels: a failed label creation is a real error, not swallowed', async () => {
  const fetchImpl = fetchImplFor({ existingLabels: [], failCreateFor: ['workstream:beacon'] });
  await assert.rejects(
    () => ensureWorkstreamLabels({ projectRoot: FIXTURE_ROOT, token: TOKEN, fetchImpl }),
    /workstream:beacon/,
  );
});

test('ensureWorkstreamLabels: reports open issues carrying no workstream label, for a human to label by hand', async () => {
  const openIssues = [
    { number: 101, title: 'Unlabelled thing', html_url: 'https://github.com/x/y/issues/101', labels: [] },
    { number: 102, title: 'Already labelled', html_url: 'https://github.com/x/y/issues/102', labels: [{ name: 'workstream:beacon' }] },
    { number: 103, title: 'A pull request', html_url: 'https://github.com/x/y/pull/103', labels: [], pull_request: {} },
  ];
  const fetchImpl = fetchImplFor({ existingLabels: ALL_LABELS, openIssues });
  const result = await ensureWorkstreamLabels({ projectRoot: FIXTURE_ROOT, token: TOKEN, fetchImpl });

  assert.deepEqual(
    result.unlabelledIssues.map((i) => i.number),
    [101],
    'only the genuinely unlabelled issue should be reported, not the labelled one or the pull request',
  );
});

test('ensureWorkstreamLabels: never guesses which workstream an unlabelled issue belongs to — it only reports', async () => {
  // The whole point of not auto-applying: confirm no POST/PATCH ever targets an issue, only labels.
  const openIssues = [{ number: 101, title: 'X', html_url: 'https://github.com/x/y/issues/101', labels: [] }];
  const fetchImpl = fetchImplFor({ existingLabels: ALL_LABELS, openIssues });
  await ensureWorkstreamLabels({ projectRoot: FIXTURE_ROOT, token: TOKEN, fetchImpl });

  const issueWrites = fetchImpl.calls.filter(
    (c) => /\/issues\/\d+$/.test(c.url) && (c.options.method ?? 'GET') !== 'GET',
  );
  assert.equal(issueWrites.length, 0, 'no issue should ever be written to by this script');
});

test('parseArgv: reads the project root from the first argument', () => {
  assert.deepEqual(parseArgv(['/some/project']), { projectRoot: '/some/project' });
});
