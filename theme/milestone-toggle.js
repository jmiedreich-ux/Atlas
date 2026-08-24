// The Feature Planning page's per-milestone expand/collapse, and the "Expand all"/"Collapse all"
// pair that acts on every one at once.
//
// `theme/_includes/depth.njk` used to bake a build-time choice into what markup even existed:
// `src/depth.mjs`'s `spineDetail` picked exactly one milestone per workstream (the first one
// marked `next`) to get a full task checklist; everything else got a bare "N sub-tasks" count with
// no way to see which tasks were actually done. That broke down the moment two milestones were
// both `next` at once — a real case (a parent milestone split into sub-milestones, one of which is
// the actual next step) that `spineDetail` was never built to prefer between. The fix here is not a
// smarter build-time pick: every milestone's full checklist is now ALWAYS in the page, and
// `spineDetail` only decides which ones START open. `[data-milestone-toggle]` and `[aria-controls]`
// mirror `theme/order.js`'s `toggleExpand` exactly — same `aria-expanded`/`hidden` mechanism, one
// level deeper (a milestone inside an already-expandable feature row, not the row itself).
//
// WHAT IS TESTABLE IS EXPORTED, same posture `order.js` states for itself: `toggleOne` and
// `setAll` are pure DOM operations with their own tests: `wire` is the event plumbing that calls
// them, covered only by exercising it against fake elements.

/**
 * Flip one milestone toggle's open/closed state.
 *
 * @param {Document} doc
 * @param {Element} handle - the `[data-milestone-toggle]` button.
 */
export function toggleOne(doc, handle) {
  const expanded = handle.getAttribute('aria-expanded') === 'true';
  setOne(doc, handle, !expanded);
}

/**
 * Set one milestone toggle to a known state, rather than flipping it — what "Expand all"/"Collapse
 * all" need, and what `toggleOne` above is built from.
 *
 * @param {Document} doc
 * @param {Element} handle
 * @param {boolean} expanded
 */
export function setOne(doc, handle, expanded) {
  const detail = doc.getElementById(handle.getAttribute('aria-controls'));
  handle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  if (!detail) return;
  if (expanded) detail.removeAttribute('hidden');
  else detail.setAttribute('hidden', '');
}

/**
 * Every milestone toggle on the page, forced to the same state at once — "Expand all milestones" /
 * "Collapse all milestones". Deliberately scoped to `[data-milestone-toggle]` only: it never
 * touches a workstream's own `[data-row-handle]` (`theme/order.js`) — collapsing every feature row
 * was not asked for, and the two controls already do different things.
 *
 * @param {Document} doc
 * @param {boolean} expanded
 */
export function setAll(doc, expanded) {
  for (const handle of doc.querySelectorAll('[data-milestone-toggle]')) {
    setOne(doc, handle, expanded);
  }
}

/**
 * Wire every milestone toggle's click, and the page-level expand-all/collapse-all pair, once.
 *
 * @param {Document} doc
 */
export function wire(doc) {
  for (const handle of doc.querySelectorAll('[data-milestone-toggle]')) {
    handle.addEventListener('click', () => toggleOne(doc, handle));
  }

  const expandAll = doc.querySelector('[data-milestones-expand-all]');
  if (expandAll) expandAll.addEventListener('click', () => setAll(doc, true));

  const collapseAll = doc.querySelector('[data-milestones-collapse-all]');
  if (collapseAll) collapseAll.addEventListener('click', () => setAll(doc, false));
}

if (typeof document !== 'undefined') {
  wire(document);
}
