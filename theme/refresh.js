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

    const message = outcomeMessage(outcome);
    const ok = outcome.status >= 200 && outcome.status < 300 && !!outcome.body?.ok;
    // The modal is the display surface now; the inline status line stays in the DOM (base.njk)
    // but nothing writes to it any more — a page with no modal markup gets a quiet degrade
    // (`openActionModal` returns null) rather than a fallback write, so there is exactly one place
    // this outcome is ever shown, not two that could disagree.
    if (modal) modal.resolve({ ok, message });
    button.disabled = false;
  });
}

if (typeof document !== 'undefined') {
  wire(document, window.fetch.bind(window));
}
