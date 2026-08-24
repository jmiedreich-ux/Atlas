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

/**
 * Open the modal in its running state.
 *
 * @param {Document} doc
 * @param {string} title - e.g. "Approving <slug>…", "Refreshing…". Named by the caller, never
 *   guessed here — this module knows nothing about which endpoint is running.
 * @returns {{ resolve(outcome: { ok: boolean, message: string }): void } | null} `null` when the
 *   page has no modal markup; a caller falls back to whatever it already does (its own inline
 *   status line, if it still sets one) rather than throwing.
 */
export function openActionModal(doc, title) {
  const parts = modalParts(doc);
  if (!parts) return null;

  parts.title.textContent = title;
  parts.track.className = 'action-modal-track is-running';
  parts.message.textContent = '';
  parts.message.className = 'action-modal-message';
  parts.backdrop.hidden = false;
  parts.modal.setAttribute('aria-hidden', 'false');

  return {
    resolve({ ok, message }) {
      parts.track.className = `action-modal-track ${ok ? 'is-success' : 'is-failure'}`;
      parts.message.textContent = message;
      parts.message.className = `action-modal-message ${ok ? 'is-success' : 'is-failure'}`;
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

  parts.closeButton.addEventListener('click', () => close(parts));
  parts.backdrop.addEventListener('click', (event) => {
    if (event.target === parts.backdrop) close(parts);
  });
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !parts.backdrop.hidden) close(parts);
  });
}

if (typeof document !== 'undefined') {
  wire(document);
}
