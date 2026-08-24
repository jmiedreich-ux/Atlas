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
// ONE STEP, A BUILD-TIME SHA (M8 task 7 fix round). This file used to GET the deployment log's
// current SHA from GitHub's PUBLIC, unauthenticated contents API before every POST, on the theory
// that it bought a "staleness guarantee" beyond the server's own check. That GET never actually
// worked: every real Atlas project lives in a PRIVATE repository (decision 7 — the site itself is
// gated behind an invited role), so an unauthenticated request to GitHub's contents API 404s on it
// every time. `currentSha` always resolved to `null` in practice, and the round-trip bought
// nothing but latency — not the guarantee its own header used to claim.
//
// The SHA the endpoint actually wants (`api/lib/payload.mjs:87` — `"sha" must be the... blob SHA
// the page was rendered from`) is exactly what it says: the SHA the *page* was rendered from.
// `src/build.mjs` already knows that value at build time, because it is the one reading the
// deployment log's bytes off disk in the first place (`gitBlobSha`, computed inside
// `readDeploymentLog`). `depth.njk` renders it onto `.stage-trigger`'s `data-sha`; this file reads
// it straight from the DOM below — no network call, and no private-repo problem to route around.
//
// What this SHA still protects against, and what it never did: `api/lib/handlers.mjs`'s
// `staleAgainstCaller` check compares the SHA sent here against the log file's SHA at write time
// and refuses the write if they differ. In that function's own vocabulary (`api/lib/handlers.mjs`'s
// comment on `staleAgainstCaller`), this is the WIDE guarantee — "the page was built, somebody else
// answered, and this caller is submitting against what they saw" — not the narrow one (Atlas's own
// read-then-write race between its own read of the log and its own write, which the SHA-on-the-PUT
// covers server-side regardless of what this file sends). It does not, and never did (with or
// without the old GET), guarantee the page reflects a change that happened after the page was
// built; that would need a live re-read, which is what the removed GET was reaching for and never
// actually achieved against a private repository.
//
// THE SHA IS HELD IN MEMORY, NOT RE-READ FROM THE PAGE (M8 task 7 round 2). The three buttons in
// one `.stage-trigger` group started out sharing a single `data-sha` value for the whole page load.
// But the intended workflow is exactly three clicks against the same group in one page load
// (Development, then Staging, then Release) — and a successful POST returns the log's new blob SHA
// (`sha: commit.sha` in `handleDeploymentTransition`'s 200 body). Resending the original,
// now-superseded `data-sha` on the next click would be stale against what this caller itself just
// wrote, and the server's refusal would correctly 409 it — its "reload and try again" message can't
// actually help, since `data-sha` is static HTML until the next rebuild. So the SHA below is
// reassigned from each successful response, and the next click in the same group sends the current
// value. A 409 from someone *else's* write in between still needs a reload — that guarantee is
// real and unchanged.

/**
 * The body `POST /api/deployment-transition` (Task 5) accepts, and nothing else —
 * `api/lib/payload.mjs`'s `DEPLOYMENT_TRANSITION_FIELDS` refuses an unknown field by name, so this
 * sends exactly `workstream`, `stage`, `sha`. `sha` is `null` when the page was rendered before
 * any log existed (`stream.deploymentLogSha` is `null` in that case, per `readDeploymentLog`); the
 * endpoint still accepts that.
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
// `wire` touches the DOM and the network, but only calls the small handful of DOM methods used
// below — `querySelectorAll`, `querySelector`, `getAttribute`, `addEventListener`, and setting
// `.disabled`/`.textContent` — so, unlike `theme/order.js`'s own unexported `wire` (no browser in
// this test environment, per its header), this one is exported and exercised in
// `tests/theme.test.mjs` against hand-built fake elements that implement just that interface, with
// `fetchImpl` swapped for a mock server. The auto-wiring call at the bottom of this file is still
// guarded by `typeof document !== 'undefined'`, so importing this module in the test runner never
// touches a real document or a real network on its own.

export function wire(doc, fetchImpl) {
  const triggers = doc.querySelectorAll('[data-stage-trigger]');

  triggers.forEach((trigger) => {
    // The blob SHA this group's next POST will send. Seeded once from the build-time value
    // (`stream.deploymentLogSha`, `depth.njk`'s `data-sha`) — empty string when the workstream has
    // no log yet, normalised to `null` here, the same value `transitionBody` already treats as "no
    // SHA to send" — then reassigned after every successful transition (see the header comment's
    // "SHA IS HELD IN MEMORY" section) so a second click in the same page load sends what the first
    // click's response actually returned, not the stale value the page was built with.
    let sha = trigger.getAttribute('data-sha') || null;
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
          const response = await fetchImpl('/api/deployment-transition', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: transitionBody({ slug, stage, sha }),
          });
          const body = await response.json().catch(() => null);
          outcome = { status: response.status, body };
          if (outcome.status >= 200 && outcome.status < 300 && body?.ok && body?.sha) {
            sha = body.sha;
          }
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
