// Atlas — the Approve buttons in the Feature Planning page's Upcoming Features section, wired to
// `POST /api/approve` (M9 task, decision 59). Loaded only on that page (`depth.njk`'s own
// `bodyScripts` block), the same way `theme/order.js` and `theme/deploy.js` are.
//
// NO SHA IS SENT, unlike `theme/deploy.js`'s single-record write. `approve` moves several files at
// once and its concurrency guarantee is the branch ref itself, not one record's SHA — see
// `createTreeClient.updateRef` (api/lib/github.mjs): the server re-reads the branch fresh on every
// call and refuses (a 409) if it moved since, which is a real guarantee with nothing for this file
// to hold onto between page load and click. A page listing a proposed design that has since been
// approved by someone else gets exactly that 409, and the message says so.
//
// ONE STEP, no retry loop of its own — same posture as `theme/deploy.js`: a failed click leaves the
// button enabled and the status line naming why, and a person decides what to do next rather than
// this file guessing.

/**
 * The body `POST /api/approve` accepts, and nothing else — `api/lib/payload.mjs`'s
 * `validateApprovePayload` refuses an unknown field by name.
 *
 * @param {{ slug: string }} args
 * @returns {string}
 */
export function approveBody({ slug }) {
  return JSON.stringify({ slug });
}

/**
 * A human-readable line for whatever `POST /api/approve` answered — success, refusal, or a network
 * failure that never reached it.
 *
 * @param {{ status: number, body: object | null }} outcome
 * @returns {string}
 */
export function outcomeMessage({ status, body }) {
  if (status >= 200 && status < 300 && body?.ok) {
    return `Approved — moved to ${body.featurePath}. The page will reflect this on the next rebuild.`;
  }
  if (body?.message) {
    return `Not approved: ${body.message}`;
  }
  return `Not approved: the server answered ${status}.`;
}

// --- the page ------------------------------------------------------------------------------------
//
// `wire` touches the DOM and the network the same small way `theme/deploy.js`'s does — starting
// from the WRAPPER (`[data-approve-trigger]`, not the button directly), the same shape
// `theme/deploy.js` uses for `[data-stage-trigger]`, so finding a row's own status line is a plain
// `querySelector` down from something already found rather than an upward `closest` a fake element
// would also have to implement. `querySelectorAll`, `getAttribute`, `addEventListener`,
// `.disabled`/`.textContent` are the whole DOM surface this needs, so it is exported and exercised
// in `tests/theme.test.mjs` against hand-built fake elements, `fetchImpl` swapped for a mock. The
// auto-wiring call at the bottom is guarded the same way, so importing this module in the test
// runner never touches a real document or a real network on its own.

export function wire(doc, fetchImpl) {
  const triggers = doc.querySelectorAll('[data-approve-trigger]');

  triggers.forEach((trigger) => {
    const status = trigger.querySelector('[data-approve-trigger-status]');
    const button = trigger.querySelector('[data-approve-button]');
    if (!button) return;

    button.addEventListener('click', async () => {
      const slug = button.getAttribute('data-slug');

      button.disabled = true;
      if (status) status.textContent = 'Approving…';

      let outcome;
      try {
        const response = await fetchImpl('/api/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: approveBody({ slug }),
        });
        const body = await response.json().catch(() => null);
        outcome = { status: response.status, body };
      } catch (err) {
        outcome = { status: 0, body: { message: err.message } };
      }

      if (status) status.textContent = outcomeMessage(outcome);
      // Left disabled on success — the row's own proposal is gone from the repository once this
      // succeeds, and the button would 404 (`no-such-proposal`) on a second click before the next
      // rebuild ever runs. Re-enabled on any refusal, so a real failure (a network blip, a stale
      // branch) can be retried.
      if (!(outcome.status >= 200 && outcome.status < 300 && outcome.body?.ok)) {
        button.disabled = false;
      }
    });
  });
}

if (typeof document !== 'undefined') {
  wire(document, window.fetch.bind(window));
}
