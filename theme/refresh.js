// Atlas — the refresh button in the site header, wired to `POST /api/refresh` (M9, decision 61).
// Loaded on every page (`base.njk`, unconditionally — not through `bodyScripts`, which only the
// feature planning page overrides), because the point of this button is "stop waiting on CI to
// notice a change, from wherever you're looking," not one page's concern.
//
// EMPTY BODY, ALWAYS. `api/lib/payload.mjs`'s `validateRefreshPayload` accepts `{}` or nothing and
// refuses any named field — there is nothing for this file to send beyond the request itself.
//
// ONE STEP, no retry loop of its own — same posture as `theme/deploy.js` and `theme/approve.js`: a
// failed click leaves the button enabled and the modal naming why, and a person decides what to do
// next. Re-enabled on success too, unlike `approve.js` — a second refresh is always a valid thing
// to ask for, where a second approve of the same slug would 404.
//
// THE MODAL, NOT THE INLINE STATUS LINE. `[data-refresh-trigger-status]` still sits in the DOM
// (`base.njk`) but this file no longer writes to it — `theme/action-modal.js`'s shared modal shows
// the running/success/failure state instead, the same surface `approve.js`/`deploy.js` now open
// too. `openActionModal` returns `null` on a page with no modal markup, so this still degrades to
// "the button worked, nothing visibly confirmed it" rather than throwing — not silent, just quiet.

import { openActionModal } from './action-modal.js';

// M9 follow-up, decision 61's own polling: "we need to keep a poll in a window while the
// background job is refreshing." A dispatch only confirms GitHub ACCEPTED the trigger — the
// rebuild itself takes real minutes (tonight's own deploys ran 60-100s) — so a successful dispatch
// now starts watching the run it created instead of declaring victory immediately.
const POLL_INTERVAL_MS = 4000;
// Bounded, not indefinite — a real rebuild+deploy finishes in a couple of minutes; five is
// generous headroom without polling forever over something genuinely stuck. Timing out is not a
// failure verdict, only an honest "stopped watching" — see `pollRunStatus` below.
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A human-readable line for whatever `POST /api/refresh` answered — success, refusal, or a network
 * failure that never reached it.
 *
 * @param {{ status: number, body: object | null }} outcome
 * @returns {string}
 */
export function outcomeMessage({ status, body }) {
  if (status >= 200 && status < 300 && body?.ok) {
    return `Rebuild triggered (${body.workflow} on ${body.ref}) — reload in a minute or two to see it.`;
  }
  if (body?.message) {
    return `Not triggered: ${body.message}`;
  }
  return `Not triggered: the server answered ${status}.`;
}

/**
 * A human-readable line for one `GET /api/refresh-status` poll's answer.
 *
 * @param {object | null} status
 * @returns {string}
 */
export function pollMessage(status) {
  if (status?.state === 'pending') return 'Dispatched — waiting for GitHub to start the run…';
  if (status?.state === 'running') {
    // `step` is a real, named step from the run's own jobs (`GET /api/refresh-status`, backed by
    // `getRunStep`) — surfaced when GitHub has reported one, never invented when it has not (a run
    // between "queued" and its first step starting has no current step yet, and that gap is shown
    // honestly as a plain "running" line rather than guessed at).
    if (status.step?.name) return `${status.step.name} (${status.step.number} of ${status.step.of})…`;
    return `Building (run #${status.run})…`;
  }
  return 'Building…';
}

/**
 * Poll `GET /api/refresh-status` from just after a dispatch until the run it created finishes,
 * updating `modal` with real progress rather than the dispatch's own immediate "accepted" state.
 *
 * Stops early, without resolving the modal itself, the moment the visitor closes it — polling
 * after that would update text nobody can see (`modal.isOpen()`, `theme/action-modal.js`). Stops
 * on `POLL_TIMEOUT_MS` too, resolved as `ok: true` rather than a failure: nothing is known to have
 * gone wrong, this only stopped watching — the honest middle ground between claiming success and
 * inventing a failure this module has no evidence for.
 *
 * @param {ReturnType<typeof openActionModal>} modal
 * @param {typeof fetch} fetchImpl
 * @param {{ dispatchedAt: string, workflow: string, intervalMs?: number, timeoutMs?: number }} args
 *   `intervalMs`/`timeoutMs` default to the real production values; a test overrides both to run
 *   this loop in milliseconds instead of minutes without touching the loop's own logic.
 */
export async function pollRunStatus(
  modal,
  fetchImpl,
  { dispatchedAt, workflow, intervalMs = POLL_INTERVAL_MS, timeoutMs = POLL_TIMEOUT_MS },
) {
  const deadline = Date.now() + timeoutMs;
  let runId = null;
  let consecutiveNetworkFailures = 0;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    if (modal && !modal.isOpen()) return;

    const query = runId
      ? `run=${encodeURIComponent(runId)}`
      : `since=${encodeURIComponent(dispatchedAt)}&workflow=${encodeURIComponent(workflow)}`;

    let response;
    let body;
    try {
      response = await fetchImpl(`/api/refresh-status?${query}`);
      body = await response.json().catch(() => null);
    } catch {
      // A network hiccup mid-poll is not the same claim as "the run failed" — three of them in a
      // row is a real pattern worth stopping over; one is worth trying again.
      consecutiveNetworkFailures += 1;
      if (consecutiveNetworkFailures >= 3) {
        if (modal) modal.resolve({ ok: false, message: 'Lost the connection while watching the rebuild.' });
        return;
      }
      continue;
    }
    consecutiveNetworkFailures = 0;

    if (!response.ok || !body?.ok) {
      if (modal) modal.resolve({ ok: false, message: body?.message ?? `The status check answered ${response.status}.` });
      return;
    }

    if (body.state === 'done') {
      const ok = body.conclusion === 'success';
      if (modal) {
        modal.resolve({
          ok,
          message: ok ? 'Rebuild deployed.' : `Rebuild finished: ${body.conclusion}.`,
        });
      }
      return;
    }

    if (body.state === 'running') runId = body.run;
    if (modal) modal.update(pollMessage(body));
  }

  if (modal) {
    modal.resolve({
      ok: true,
      message: 'Still running after 5 minutes — check GitHub Actions directly.',
    });
  }
}

// --- the page ------------------------------------------------------------------------------------
//
// `wire` touches the DOM and the network the same small way `theme/approve.js`'s does — starting
// from the WRAPPER (`[data-refresh-trigger]`, not the button directly), so a fake element in a test
// only has to implement a plain `querySelector` down from something already found. `querySelector`,
// `addEventListener`, `.disabled`/`.textContent` are the whole DOM surface this needs, so it is
// exported and exercised in `tests/theme.test.mjs` against hand-built fake elements, `fetchImpl`
// swapped for a mock. The auto-wiring call at the bottom is guarded the same way, so importing this
// module in the test runner never touches a real document or a real network on its own.

export function wire(doc, fetchImpl) {
  const trigger = doc.querySelector('[data-refresh-trigger]');
  if (!trigger) return;

  const button = trigger.querySelector('[data-refresh-button]');
  if (!button) return;

  button.addEventListener('click', async () => {
    button.disabled = true;
    const modal = openActionModal(doc, 'Refreshing…');

    let outcome;
    try {
      const response = await fetchImpl('/api/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const body = await response.json().catch(() => null);
      outcome = { status: response.status, body };
    } catch (err) {
      outcome = { status: 0, body: { message: err.message } };
    }

    const ok = outcome.status >= 200 && outcome.status < 300 && !!outcome.body?.ok;
    // Re-enabled right after the DISPATCH resolves, not after the rebuild it triggers finishes —
    // polling for real completion (below) can run for minutes, and there is no reason a second
    // refresh should be blocked for that whole window; "a second refresh is always valid" already
    // held before polling existed and still does.
    button.disabled = false;

    // A dispatch that names what it triggered (the ordinary success case) hands off to watching
    // the actual run instead of declaring victory the instant GitHub accepted the trigger — see
    // `pollRunStatus`. Not awaited: the click handler's own job (send the request, re-enable the
    // button) is already done: polling runs on its own after this.
    if (ok && outcome.body?.dispatchedAt && outcome.body?.workflow) {
      if (modal) modal.update(outcomeMessage(outcome));
      pollRunStatus(modal, fetchImpl, {
        dispatchedAt: outcome.body.dispatchedAt,
        workflow: outcome.body.workflow,
      });
      return;
    }

    // The modal is the display surface now; the inline status line stays in the DOM (base.njk)
    // but nothing writes to it any more — a page with no modal markup gets a quiet degrade
    // (`openActionModal` returns null) rather than a fallback write, so there is exactly one place
    // this outcome is ever shown, not two that could disagree.
    if (modal) modal.resolve({ ok, message: outcomeMessage(outcome) });
  });
}

if (typeof document !== 'undefined') {
  wire(document, window.fetch.bind(window));
}
