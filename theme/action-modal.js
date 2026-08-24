// Atlas — the shared modal every write-back trigger (approve, deploy, refresh) opens while its
// request is in flight, and resolves to success or failure in. Replaces the per-trigger inline
// status line (`[data-*-trigger-status]`, still present in the DOM for a page that has not loaded
// this module, so nothing throws if one is missing) with one shared surface.
//
// THE ANIMATION IS THE SPINE'S OWN VISUAL LANGUAGE, TURNED SIDEWAYS. `.milestone-spine`
// (theme/tokens.css) already draws "a filled segment for what is done, a hollow ring for what is
// next" down a feature's own progress (decision 24). This reuses that exact idea horizontally: a
// track fills left-to-right in `--sky-color-primary` — the same accent `.milestone-node.tone-done`
// and `.stage-node`'s dot already use — rather than a new visual vocabulary invented for this one
// surface.
//
// INDETERMINATE, BECAUSE THE DURATION IS UNKNOWN. Unlike the spine (real progress through real,
// counted milestones), a fetch's duration cannot be known in advance, so the running state loops
// rather than ties itself to elapsed time — the same honesty `theme/deploy.js`'s own confirmation
// text already insists on: never claim more than is actually known.
//
// PREFERS-REDUCED-MOTION DROPS THE SWEEP, NOT THE STATE. `theme/tokens.css`'s
// `@media (prefers-reduced-motion: reduce)` block turns the keyframe animation off; the
// running/success/failure classes below still switch, so a visitor who asked for less motion still
// learns a request is running and how it ended, just without the sweep itself.
//
// ONE MODULE, IMPORTED RATHER THAN LOADED AS ITS OWN <script>. `theme/refresh.js` (every page) and
// `theme/approve.js`/`theme/deploy.js` (feature planning only) each `import` from this file
// directly; a browser's module graph loads and runs this exactly once regardless of how many
// callers import it, so `wire(document)` below — the close/backdrop/Escape chrome — only ever
// attaches its listeners a single time. No separate `<script src="/action-modal.js">` tag in
// `base.njk` is needed or present.

/**
 * The modal's parts, read fresh from `doc` on every call rather than cached at module load — a
 * test builds a new fake `doc` per case, and a real page only ever has one modal, so there is
 * nothing this loses by not caching.
 *
 * @param {Document} doc
 * @returns {{ backdrop: object, modal: object, title: object, track: object, message: object,
 *   closeButton: object } | null} `null` when the page carries no modal markup — a template that
 *   has not adopted `base.njk`'s block, or a fake `doc` in a test that is checking the no-op path.
 */
function modalParts(doc) {
  const backdrop = doc.querySelector('[data-action-modal-backdrop]');
  if (!backdrop) return null;
  const modal = backdrop.querySelector('[data-action-modal]');
  const title = backdrop.querySelector('[data-action-modal-title]');
  const track = backdrop.querySelector('[data-action-modal-track]');
  const message = backdrop.querySelector('[data-action-modal-message]');
  const closeButton = backdrop.querySelector('[data-action-modal-close]');
  if (!modal || !title || !track || !message || !closeButton) return null;
  return { backdrop, modal, title, track, message, closeButton };
}

function close(parts) {
  parts.backdrop.hidden = true;
  parts.modal.setAttribute('aria-hidden', 'true');
}

// How long a SUCCESSFUL outcome stays on screen before closing itself. A failure never auto-closes
// — its whole point is a message the visitor has to actually read and act on, where a success is
// just a confirmation nobody needs to dismiss by hand. Long enough to read "Rebuild deployed.",
// short enough that it does not feel like a modal that forgot to leave.
const AUTO_CLOSE_MS = 3000;

// The one pending auto-close timer, if any — module-level rather than per-call, because the modal
// itself is one shared element and a stale timer from a PREVIOUS resolved action must not close a
// NEW one a visitor opened inside that same window (two clicks a few seconds apart, on a page with
// several trigger buttons all sharing this one modal). `openActionModal` clears it below on every
// open, which is the only place a new action's lifetime begins.
let pendingAutoClose = null;

/**
 * Open the modal in its running state.
 *
 * @param {Document} doc
 * @param {string} title - e.g. "Approving <slug>…", "Refreshing…". Named by the caller, never
 *   guessed here — this module knows nothing about which endpoint is running.
 * @param {{ autoCloseMs?: number }} [opts] - `autoCloseMs` defaults to the real production value;
 *   a test overrides it to run the auto-close timer in milliseconds instead of seconds without
 *   touching this function's own logic, the same convention `pollRunStatus` (theme/refresh.js)
 *   already uses for its own interval/timeout.
 * @returns {{ resolve(outcome: { ok: boolean, message: string }): void } | null} `null` when the
 *   page has no modal markup; a caller falls back to whatever it already does (its own inline
 *   status line, if it still sets one) rather than throwing.
 */
export function openActionModal(doc, title, { autoCloseMs = AUTO_CLOSE_MS } = {}) {
  const parts = modalParts(doc);
  if (!parts) return null;

  if (pendingAutoClose !== null) {
    clearTimeout(pendingAutoClose);
    pendingAutoClose = null;
  }

  parts.title.textContent = title;
  parts.track.className = 'action-modal-track is-running';
  parts.message.textContent = '';
  parts.message.className = 'action-modal-message';
  parts.backdrop.hidden = false;
  parts.modal.setAttribute('aria-hidden', 'false');

  return {
    // A caller that needs to report interim progress before the outcome is known (M9 follow-up,
    // decision 61's own run-status polling: "queued", "building…") without ending the running
    // state — `resolve` below is still the only thing that switches the track's class.
    update(message) {
      parts.message.textContent = message;
    },
    resolve({ ok, message }) {
      parts.track.className = `action-modal-track ${ok ? 'is-success' : 'is-failure'}`;
      parts.message.textContent = message;
      parts.message.className = `action-modal-message ${ok ? 'is-success' : 'is-failure'}`;
      if (ok) {
        pendingAutoClose = setTimeout(() => {
          pendingAutoClose = null;
          close(parts);
        }, autoCloseMs);
      }
    },
    // A poll loop's own exit condition: the visitor closed the modal (the X, the backdrop, or
    // Escape — all three go through `close()` below, which this reads live rather than caching,
    // the same reason `modalParts` itself is read fresh on every `openActionModal` call) before
    // the thing it was watching finished. Polling after that would update text nobody can see.
    isOpen() {
      return !parts.backdrop.hidden;
    },
  };
}

/**
 * Wire the modal's own chrome — the close button, the backdrop click, and Escape — once. Exported
 * so a test can call it directly against a fake `doc`, the convention every other `wire()` in this
 * theme already follows.
 *
 * @param {Document} doc
 */
export function wire(doc) {
  const parts = modalParts(doc);
  if (!parts) return;

  // A manual close cancels any pending auto-close too — otherwise the timer would still fire later
  // and call `close()` again on whatever the visitor has since opened in its place. Harmless either
  // way (`close()` is idempotent), but this is the precise version, not just the safe one.
  function closeNow() {
    if (pendingAutoClose !== null) {
      clearTimeout(pendingAutoClose);
      pendingAutoClose = null;
    }
    close(parts);
  }

  parts.closeButton.addEventListener('click', closeNow);
  parts.backdrop.addEventListener('click', (event) => {
    if (event.target === parts.backdrop) closeNow();
  });
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !parts.backdrop.hidden) closeNow();
  });
}

if (typeof document !== 'undefined') {
  wire(document);
}
