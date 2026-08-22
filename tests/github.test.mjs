import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchProjectIssues } from '../src/github.mjs';

// All fixture data below is invented for this test file only — the generator holds no project
// content of its own (decision 40).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ISSUES_FIXTURE = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures', 'issues.json'), 'utf8'),
);

const REPO = 'atlas-fixtures/lighthouse';

// Fixture shape, so the tests below read as descriptions rather than magic numbers:
//   101 — a normal issue, labelled "workstream:beacon" (plus an unrelated "bug" label)
//   302 — an issue carrying two workstream labels: "workstream:tide" AND "workstream:harbor"
//   204 — a pull request; the REST issues endpoint returns it as an "issue" with a `pull_request`
//         key, and it is deliberately also labelled "workstream:beacon" so that if the
//         pull-request filter were ever removed, it would silently inflate that same bucket
//   415 — an issue with no labels at all
//   420 — an issue with a label, but none of them a "workstream:*" label

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

function fetchImplReturning(body, opts) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(body, opts);
  };
  impl.calls = calls;
  return impl;
}

function withSilencedWarn(fn) {
  const original = console.warn;
  const calls = [];
  console.warn = (...args) => calls.push(args);
  return fn(calls).finally(() => {
    console.warn = original;
  });
}

// --- bucketing -----------------------------------------------------------

test('fetchProjectIssues: buckets a normally labelled issue under its workstream label', async () => {
  const fetchImpl = fetchImplReturning(ISSUES_FIXTURE);
  const result = await fetchProjectIssues({ repo: REPO, fetchImpl });

  const beacon = result.byLabel.get('workstream:beacon');
  assert.ok(beacon, 'expected a "workstream:beacon" bucket');
  assert.deepEqual(
    beacon.map((i) => i.number),
    [101],
  );
});

test('fetchProjectIssues: an issue carrying two workstream labels appears under both buckets', async () => {
  const fetchImpl = fetchImplReturning(ISSUES_FIXTURE);
  const result = await fetchProjectIssues({ repo: REPO, fetchImpl });

  const tide = result.byLabel.get('workstream:tide');
  const harbor = result.byLabel.get('workstream:harbor');
  assert.ok(tide && harbor, 'expected both "workstream:tide" and "workstream:harbor" buckets');
  assert.ok(tide.some((i) => i.number === 302), 'issue 302 missing from workstream:tide');
  assert.ok(harbor.some((i) => i.number === 302), 'issue 302 missing from workstream:harbor');
});

test('fetchProjectIssues: pull requests are excluded from every issue bucket', async () => {
  const fetchImpl = fetchImplReturning(ISSUES_FIXTURE);
  const result = await fetchProjectIssues({ repo: REPO, fetchImpl });

  // Issue 204 is the pull request, deliberately labelled "workstream:beacon" — if the
  // `pull_request` filter were removed, it would land in this same bucket alongside 101.
  const beacon = result.byLabel.get('workstream:beacon');
  assert.deepEqual(
    beacon.map((i) => i.number),
    [101],
    'the PR (204) must not appear in the workstream:beacon bucket',
  );

  for (const bucket of result.byLabel.values()) {
    assert.ok(!bucket.some((i) => i.number === 204), 'PR 204 leaked into a byLabel bucket');
  }
  assert.ok(!result.unlabelled.some((i) => i.number === 204), 'PR 204 leaked into unlabelled');
});

test('fetchProjectIssues: pull requests are collected separately in prs', async () => {
  const fetchImpl = fetchImplReturning(ISSUES_FIXTURE);
  const result = await fetchProjectIssues({ repo: REPO, fetchImpl });

  assert.deepEqual(
    result.prs.map((i) => i.number),
    [204],
  );
});

test('fetchProjectIssues: unlabelled issues are collected, not dropped', async () => {
  const fetchImpl = fetchImplReturning(ISSUES_FIXTURE);
  const result = await fetchProjectIssues({ repo: REPO, fetchImpl });

  // 415 has no labels at all; 420 has a label, but not a workstream:* one — both belong here.
  assert.deepEqual(
    result.unlabelled.map((i) => i.number).sort(),
    [415, 420],
  );
});

test('fetchProjectIssues: every open, non-PR issue is accounted for across byLabel and unlabelled', async () => {
  const fetchImpl = fetchImplReturning(ISSUES_FIXTURE);
  const result = await fetchProjectIssues({ repo: REPO, fetchImpl });

  const seen = new Set();
  for (const bucket of result.byLabel.values()) {
    for (const issue of bucket) seen.add(issue.number);
  }
  for (const issue of result.unlabelled) seen.add(issue.number);

  assert.deepEqual([...seen].sort((a, b) => a - b), [101, 302, 415, 420]);
});

// --- one call, not one per label -----------------------------------------

test('fetchProjectIssues: fetches the issue list exactly once, not once per workstream label', async () => {
  const fetchImpl = fetchImplReturning(ISSUES_FIXTURE);
  await fetchProjectIssues({ repo: REPO, fetchImpl });

  assert.equal(fetchImpl.calls.length, 1);
});

test('fetchProjectIssues: requests the list endpoint for the given repo, not the search endpoint', async () => {
  const fetchImpl = fetchImplReturning(ISSUES_FIXTURE);
  await fetchProjectIssues({ repo: REPO, fetchImpl });

  const { url } = fetchImpl.calls[0];
  assert.match(String(url), /\/repos\/atlas-fixtures\/lighthouse\/issues/);
  assert.doesNotMatch(String(url), /\/search\//);
});

test('fetchProjectIssues: sends an Authorization header when a token is given, omits it otherwise', async () => {
  const withToken = fetchImplReturning(ISSUES_FIXTURE);
  await fetchProjectIssues({ repo: REPO, token: 'secret-token', fetchImpl: withToken });
  const headersWithToken = withToken.calls[0].options?.headers ?? {};
  assert.ok(
    Object.entries(headersWithToken).some(
      ([k, v]) => k.toLowerCase() === 'authorization' && String(v).includes('secret-token'),
    ),
    'expected an Authorization header carrying the token',
  );

  const withoutToken = fetchImplReturning(ISSUES_FIXTURE);
  await fetchProjectIssues({ repo: REPO, fetchImpl: withoutToken });
  const headersWithoutToken = withoutToken.calls[0].options?.headers ?? {};
  assert.ok(
    !Object.keys(headersWithoutToken).some((k) => k.toLowerCase() === 'authorization'),
    'expected no Authorization header when no token is given',
  );
});

// --- failure tolerance -----------------------------------------------------

test('fetchProjectIssues: a rejected fetch degrades to empty buckets and warns, without throwing', async () => {
  await withSilencedWarn(async (warnCalls) => {
    const fetchImpl = async () => {
      throw new Error('network unreachable');
    };

    const result = await fetchProjectIssues({ repo: REPO, fetchImpl });

    assert.deepEqual(result.byLabel, new Map());
    assert.deepEqual(result.unlabelled, []);
    assert.deepEqual(result.prs, []);
    assert.ok(warnCalls.length >= 1, 'expected a warning to be logged');
  });
});

test('fetchProjectIssues: a non-OK HTTP response degrades to empty buckets and warns, without throwing', async () => {
  await withSilencedWarn(async (warnCalls) => {
    const fetchImpl = async () => jsonResponse({ message: 'Not Found' }, { ok: false, status: 404 });

    const result = await fetchProjectIssues({ repo: REPO, fetchImpl });

    assert.deepEqual(result.byLabel, new Map());
    assert.deepEqual(result.unlabelled, []);
    assert.deepEqual(result.prs, []);
    assert.ok(warnCalls.length >= 1, 'expected a warning to be logged');
  });
});

test('fetchProjectIssues: a successful response that fails to parse as JSON degrades to empty buckets and warns', async () => {
  await withSilencedWarn(async (warnCalls) => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('unexpected token');
      },
    });

    const result = await fetchProjectIssues({ repo: REPO, fetchImpl });

    assert.deepEqual(result.byLabel, new Map());
    assert.deepEqual(result.unlabelled, []);
    assert.deepEqual(result.prs, []);
    assert.ok(warnCalls.length >= 1, 'expected a warning to be logged');
  });
});

// --- decision 32: a short answer says it may be short ---------------------

// The page size the module asks GitHub for, derived from what the module actually requests rather
// than restated here — a constant compared to itself is a test that cannot fail.
async function requestedPageSize() {
  const fetchImpl = fetchImplReturning([]);
  await fetchProjectIssues({ repo: REPO, fetchImpl });
  const size = new URL(fetchImpl.calls[0].url).searchParams.get('per_page');
  assert.ok(size, 'the request does not ask for a page size at all');
  return Number(size);
}

test('fetchProjectIssues: a full page warns that the backlog may be longer', async () => {
  // One request, no Link header, no pagination — a deliberate design, because the alternative is
  // an unbounded number of requests against a rate limit on a six-hourly schedule. What is not
  // acceptable is answering short and saying nothing: decision 32 exists to forbid exactly that.
  const size = await requestedPageSize();
  const full = Array.from({ length: size }, (_, i) => ({
    number: i + 1,
    title: `Invented issue ${i + 1}`,
    html_url: `https://example.invalid/${i + 1}`,
    labels: [{ name: 'workstream:beacon' }],
  }));

  await withSilencedWarn(async (warnings) => {
    const result = await fetchProjectIssues({ repo: REPO, fetchImpl: fetchImplReturning(full) });

    assert.equal(result.byLabel.get('workstream:beacon').length, size, 'the buckets are still real');
    assert.equal(warnings.length, 1, `expected one warning, saw ${warnings.length}`);
    const message = warnings[0].join(' ');
    assert.match(message, /^atlas: /, 'every warning this generator prints is prefixed');
    assert.ok(message.includes(REPO), 'the warning must name the repository it is about');
    assert.ok(
      /may be|truncat|short/i.test(message),
      `the warning must say the answer may be incomplete: ${message}`,
    );
    // Not the empty-buckets warning: nothing failed here.
    assert.ok(!/empty issue buckets/.test(message), message);
  });
});

test('fetchProjectIssues: one item short of a full page says nothing', async () => {
  const size = await requestedPageSize();
  const nearly = Array.from({ length: size - 1 }, (_, i) => ({
    number: i + 1,
    title: `Invented issue ${i + 1}`,
    html_url: `https://example.invalid/${i + 1}`,
    labels: [],
  }));

  await withSilencedWarn(async (warnings) => {
    const result = await fetchProjectIssues({ repo: REPO, fetchImpl: fetchImplReturning(nearly) });
    assert.equal(result.unlabelled.length, size - 1);
    assert.deepEqual(warnings, [], 'a complete answer must not cry wolf');
  });
});

test('fetchProjectIssues: the page it asks for is large enough to be worth having', async () => {
  // The ceiling is lower than it looks: /issues returns issues AND pull requests interleaved, so
  // this is a combined figure. A page size quietly reduced would make every backlog on the site
  // short, and before this test nothing noticed.
  assert.equal(await requestedPageSize(), 100, 'GitHub\'s maximum page size for this endpoint');
});
