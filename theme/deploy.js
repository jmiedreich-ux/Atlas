// Atlas — the trigger buttons a feature's own expanded row carries (Development / Staging /
// Release), wired to `POST /api/deployment-transition` (M8 task 5). Loaded only on the feature
// planning page (`depth.njk`'s own `bodyScripts` block), the same way `theme/order.js` is.
//
// THERE IS NO CLIENT-SIDE WRITE-BACK PRECEDENT IN THIS CODEBASE TO COPY, AND THIS FILE IS NOT ONE.
// `theme/order.js` is the only other script Atlas ships, and it is local-only: an order
// remembered in `localStorage`, deliberately never sent anywhere (see its own header — "writing
// it back to the repository... is Milestone 3", i.e. not this file either, until now).
// `api/answer` and `api/acceptance` are real write-back endpoints that already exist, and neither
// has ever had a caller anywhere in `theme/`: nothing before this file has called `fetch` from a
// rendered Atlas page. Task 7 is the first write-back UI Atlas ships. Say so here rather than let
// a reader assume this follows an established client pattern — it establishes one.
//
// WHAT THIS DOES NOT DO: it does not deploy anything, and its own confirmation text never claims
// it did. `POST /api/deployment-transition` records a requested transition in a workstream's
// deployment log — an append-only fact a later rebuild will pick up — not an instruction any
// pipeline is watching (see the M8 design doc's "What this milestone does NOT build": a
// deployment agent is explicitly out of scope here).
//
// TWO-STEP WRITE. `api/lib/handlers.mjs`'s own header lays out the server's five-step contract;
// this mirrors its read side from the browser, since a page has no installation token of its own
// to call GitHub's contents API the way `api/lib/github.mjs`'s `createContentsClient.read` does
// server-side:
//
//   1. GET the deployment log's current SHA from GitHub's PUBLIC, unauthenticated contents API —
//      same endpoint shape, same field (`sha`) the server reads for itself a moment later.
//   2. POST the transition, carrying that SHA.
//
// The SHA is optional to the endpoint (`api/lib/payload.mjs`'s `checkSha` accepts `null`), and the
// server re-reads the file itself before writing regardless of what this sends — that is the
// endpoint's own narrow guarantee, and it holds with or without a SHA here. What the SHA bought by
// this GET is the WIDE guarantee: catching a page that is stale against what a reader is looking
// at right now, same distinction `api/lib/handlers.mjs`'s `staleAgainstCaller` documents. A GET
// that fails — no network, rate-limited, CORS — does not stop the write from being attempted; it
// only forfeits the wide guarantee, which is why `currentSha` below returns `null` on any failure
// rather than throwing.

const GITHUB_API_ROOT = 'https://api.github.com';

/**
 * The public contents API URL for one file, unauthenticated. `repo` is `"owner/name"`; `path` is
 * repository-relative. No `ref` is sent — a rendered page does not know which branch the site was
 * built from, so this reads whatever GitHub calls the repository's default branch, the same
 * answer opening the file in a browser would give.
 *
 * @param {string} repo
 * @param {string} path
 * @returns {string}
 */
export function contentsUrl(repo, path) {
  return `${GITHUB_API_ROOT}/repos/${repo}/contents/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

/**
 * The body `POST /api/deployment-transition` (Task 5) accepts, and nothing else —
 * `api/lib/payload.mjs`'s `DEPLOYMENT_TRANSITION_FIELDS` refuses an unknown field by name, so this
 * sends exactly `workstream`, `stage`, `sha`. `sha` is `null` when the GET above could not
 * complete; the endpoint still accepts that.
 *
 * @param {{ slug: string, stage: string, sha: string | null }} args
 * @returns {string}
 */
export function transitionBody({ slug, stage, sha }) {
  return JSON.stringify({ workstream: slug, stage, sha: sha ?? null });
}

/**
 * A human-readable line for whatever `POST /api/deployment-transition` answered — success,
 * refusal, or a network failure that never reached it. Never says "deployed": the endpoint
 * records a request, and this line never claims more than that.
 *
 * @param {{ status: number, body: object | null }} outcome
 * @returns {string}
 */
export function outcomeMessage({ status, body }) {
  if (status >= 200 && status < 300 && body?.ok) {
    return 'Recorded — the page will reflect this on the next rebuild.';
  }
  if (body?.message) {
    return `Not recorded: ${body.message}`;
  }
  return `Not recorded: the server answered ${status}.`;
}

// --- the page ------------------------------------------------------------------------------------
//
// Everything below touches the DOM and the network and runs only in a browser. Guarded the same
// way `theme/order.js` guards its own wiring (see its header), so importing this module in the
// test runner exercises the three pure functions above without going near a document, or a
// network, that is not there.

async function currentSha(repo, path, fetchImpl) {
  if (!repo || !path) return null;
  try {
    const response = await fetchImpl(contentsUrl(repo, path), {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return typeof payload?.sha === 'string' ? payload.sha : null;
  } catch (err) {
    // No network, rate-limited, CORS: none of these should stop the write from being attempted —
    // see this file's own header on the narrow-vs-wide guarantee.
    return null;
  }
}

function wire(doc, fetchImpl) {
  const triggers = doc.querySelectorAll('[data-stage-trigger]');

  triggers.forEach((trigger) => {
    const repo = trigger.getAttribute('data-repo');
    const log = trigger.getAttribute('data-log');
    const status = trigger.querySelector('[data-stage-trigger-status]');
    const buttons = [...trigger.querySelectorAll('[data-transition-to]')];

    buttons.forEach((button) => {
      button.addEventListener('click', async () => {
        const stage = button.getAttribute('data-transition-to');
        const slug = button.getAttribute('data-slug');

        buttons.forEach((b) => {
          b.disabled = true;
        });
        if (status) status.textContent = 'Recording…';

        let outcome;
        try {
          const sha = await currentSha(repo, log, fetchImpl);
          const response = await fetchImpl('/api/deployment-transition', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: transitionBody({ slug, stage, sha }),
          });
          const body = await response.json().catch(() => null);
          outcome = { status: response.status, body };
        } catch (err) {
          outcome = { status: 0, body: { message: err.message } };
        }

        if (status) status.textContent = outcomeMessage(outcome);
        buttons.forEach((b) => {
          b.disabled = false;
        });
      });
    });
  });
}

if (typeof document !== 'undefined') {
  wire(document, window.fetch.bind(window));
}
