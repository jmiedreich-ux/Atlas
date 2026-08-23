// The feature planning surface's one piece of behaviour: putting the features in your own order.
//
// The owner asked for this and knows what it is: an order remembered on THIS DEVICE. It lives in
// `localStorage` and goes no further. It does not follow him from his desk to his phone, and the
// page says so in as many words, because an order that silently fails to travel is worse than no
// order at all. Ordering that travels would mean writing it back to the repository (decisions
// 34-37), and that is Milestone 3.
//
// NO DRAG LIBRARY. Decision 9 fixes the runtime dependencies at exactly two, a test asserts it,
// and a page that needs a library to let a reader drag a column has lost an argument somewhere.
// Pointer events, which handle mouse, touch and pen with one code path.
//
// NO GEOMETRY HERE EITHER. The feature list is real DOM rows, not an SVG drawing — reordering
// them is `container.appendChild` in the wanted order, which also moves each row in the tab
// order and the accessibility tree for free. There is no chart to redraw and nothing to measure
// except a row's own rendered height, used only as the drag's distance unit.
//
// WHAT IS TESTABLE IS EXPORTED. The rules that can be got wrong are pure functions with their
// own tests, because a unit test states what is meant to be true where a rendered page only
// shows what happened:
// which order to render, what to do with a stored order that has gone stale, and where each lane
// lands. What is left is event plumbing, which these tests do not cover — but a browser is
// available (Playwright ships a Linux Chromium in this environment), so "untested" here means
// not yet written rather than not possible. That is stated rather than hidden.

export const ORDER_KEY = 'atlas-feature-order';

// Hiding a feature is remembered under its OWN key, never the order's. Two concerns with two
// lifetimes: "back to the generated order" must not bring a hidden feature back, and bringing one
// back must not reshuffle the page.
export const HIDDEN_KEY = 'atlas-hidden-features';

// How far a pointer may travel and still count as a click rather than a drag. In real screen
// pixels, because that is what the drag is measured in — there is no drawing here, no scaled SVG
// viewBox to correct for. It exists because the feature's header is both the drag handle and the
// way into that feature's own spine, so one gesture has to resolve to one of two meanings — by
// DISTANCE rather than by time, since a slow, deliberate click is still a click.
export const CLICK_SLOP = 4;

/**
 * The localStorage key a milestone's task order is remembered under. Namespaced per milestone
 * (the same `{slug}-{milestoneId}` id Task 6's `data-task-list` carries) so reordering one
 * milestone's tasks can never collide with, or be mistaken for, another's.
 *
 * @param {string} milestoneKey
 * @returns {string}
 */
export function taskOrderKey(milestoneKey) {
  return `atlas-task-order:${milestoneKey}`;
}

/**
 * Which original task indices to render, and in what order — the task-row equivalent of
 * `orderSlugs`, operating on positions (0..count-1) instead of slugs, since a task has no stable
 * identity of its own beyond its position in the parsed checklist.
 *
 * Same three guarantees as `orderSlugs`: an index the stored order doesn't know about (the
 * checklist grew) goes to the end in original order; a stored index no longer valid (the
 * checklist shrank) is dropped; a stored value that isn't a list of numbers is no stored order.
 *
 * @param {number} count - how many tasks this milestone has right now.
 * @param {unknown} stored - whatever came out of storage.
 * @returns {number[]} every index 0..count-1, exactly once.
 */
export function orderTaskIndices(count, stored) {
  const known = new Set(Array.from({ length: count }, (_, i) => i));
  const taken = new Set();
  const result = [];

  if (Array.isArray(stored)) {
    for (const index of stored) {
      if (typeof index !== 'number' || !known.has(index) || taken.has(index)) continue;
      taken.add(index);
      result.push(index);
    }
  }
  for (const index of known) {
    if (!taken.has(index)) result.push(index);
  }
  return result;
}

/**
 * The order to render, from the order the generator produced and whatever storage remembered.
 *
 * Three rules, and none of them may throw or lose a feature:
 *
 *   * a slug the stored order does not know goes to the END, in the order the config gives — so a
 *     workstream added to `atlas.config.json` appears, rather than vanishing because a months-old
 *     stored order has never heard of it;
 *   * a stored slug that no longer exists is ignored — a workstream removed from the config does
 *     not leave a hole or a ghost;
 *   * a stored value that is not a list of strings at all is treated as no stored order.
 *
 * @param {string[]} generated - the slugs in the order the build rendered them.
 * @param {unknown} stored - whatever came out of storage. Anything at all.
 * @returns {string[]} every generated slug, exactly once.
 */
export function orderSlugs(generated, stored) {
  const known = new Set(generated);
  const taken = new Set();
  const result = [];

  if (Array.isArray(stored)) {
    for (const slug of stored) {
      // A duplicate in storage would otherwise render one feature twice and drop another.
      if (typeof slug !== 'string' || !known.has(slug) || taken.has(slug)) continue;
      taken.add(slug);
      result.push(slug);
    }
  }

  for (const slug of generated) {
    if (!taken.has(slug)) result.push(slug);
  }

  return result;
}

/**
 * Move one slug by `delta` places, clamped at both ends. The keyboard's half of the interaction.
 *
 * @param {string[]} order
 * @param {string} slug
 * @param {number} delta
 * @returns {string[]} a new array; the input is not touched.
 */
export function moveSlug(order, slug, delta) {
  const from = order.indexOf(slug);
  if (from === -1) return [...order];
  const to = Math.min(order.length - 1, Math.max(0, from + delta));
  if (to === from) return [...order];

  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, slug);
  return next;
}

/**
 * What to say when a feature moves, for the live region on the page.
 *
 * A move reorders real DOM rows with `container.appendChild`, which a screen reader has no reason
 * to announce on its own, so a reader moving a feature with the arrow keys (or a drag) would
 * otherwise get silence and no way to tell whether the move happened — including at either end,
 * where the answer is that it did not.
 *
 * @param {string[]} order
 * @param {string} slug
 * @param {string} name - the feature's own codename, as the page shows it.
 * @returns {string}
 */
export function announce(order, slug, name) {
  const at = order.indexOf(slug);
  if (at === -1) return '';
  return `${name} moved to position ${at + 1} of ${order.length}.`;
}

// --- hiding a feature, and bringing it back (#780, decision 49) ------------------------------------
//
// THE WHOLE RISK OF THIS CAPABILITY, stated where the code is: a page that silently omits a
// workstream is worse than one that shows too many. Every rule below is about the guarantee that
// nothing is ever lost — not about hiding, which is the easy half.
//
// So a hidden feature is recoverable WITHOUT THE READER KNOWING IT IS HIDDEN. The strip above the
// chart is always visible while anything is hidden, and it NAMES what is hidden rather than merely
// counting it, so bringing a feature back never requires remembering which ones were put away.

/**
 * Split the features into the ones that render and the ones that are hidden.
 *
 * Whatever storage holds, the two lists together are exactly the features the build rendered, each
 * exactly once — a feature cannot fall between them. Storage is a string a person can edit, a
 * value another version of the page wrote, or something a different site left behind; a stale slug
 * is ignored, a duplicate collapses, and anything that is not a list of strings hides nothing.
 *
 * Both lists keep the order the build rendered in, so the page never reshuffles itself as a side
 * effect of something being hidden.
 *
 * @param {string[]} generated - the slugs in the order the build rendered them.
 * @param {unknown} stored - whatever came out of storage. Anything at all.
 * @returns {{ visible: string[], hidden: string[] }}
 */
export function partitionHidden(generated, stored) {
  const asked = new Set(
    Array.isArray(stored) ? stored.filter((slug) => typeof slug === 'string') : [],
  );
  return {
    visible: generated.filter((slug) => !asked.has(slug)),
    hidden: generated.filter((slug) => asked.has(slug)),
  };
}

/**
 * Hide a feature, or bring it back. Never mutates the list it was given.
 *
 * Removal takes EVERY copy, because storage can hold a duplicate and half-removing one would leave
 * a feature hidden with no way to see why.
 *
 * @param {string[]} hidden
 * @param {string} slug
 * @returns {string[]} a new array.
 */
export function toggleHidden(hidden, slug) {
  const list = Array.isArray(hidden) ? hidden : [];
  return list.includes(slug) ? list.filter((entry) => entry !== slug) : [...list, slug];
}

/**
 * What to say when a feature is hidden.
 *
 * Hiding sets a `hidden` attribute on the row, which a screen reader has no reason to announce —
 * so a keyboard user would press a key, get silence, and have a row gone. It carries the way back,
 * because "recoverable without knowing it is hidden" has to hold for a reader who cannot see the
 * strip either.
 *
 * @param {string} name - the feature's own codename, as the page shows it.
 * @param {number} count - how many are hidden now.
 * @returns {string}
 */
export function announceHidden(name, count) {
  const many = count === 1 ? '1 feature is' : `${count} features are`;
  return `${name} hidden. ${many} now hidden; bring them back from the controls above the list.`;
}

/**
 * Read what is hidden. Never throws, whatever storage does.
 *
 * THE FAILURE THAT MATTERS MOST is the one this shares with `readOrder`: a private window, a
 * browser set to block site data and a quota error all surface as an exception from the accessor
 * itself. Treating that as "hide everything" would give a reader a blank chart and no way to tell
 * why, so it returns null and `partitionHidden` hides nothing.
 *
 * @param {Storage | null | undefined} storage
 * @returns {unknown} whatever was stored, parsed, or null.
 */
export function readHidden(storage) {
  try {
    const raw = storage?.getItem(HIDDEN_KEY);
    if (typeof raw !== 'string') return null;
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

/**
 * Remember what is hidden, or forget it all when given null. Never throws.
 *
 * @param {Storage | null | undefined} storage
 * @param {string[] | null} hidden
 * @returns {boolean} whether it was actually written.
 */
export function writeHidden(storage, hidden) {
  try {
    if (hidden === null || (Array.isArray(hidden) && hidden.length === 0)) storage?.removeItem(HIDDEN_KEY);
    else storage?.setItem(HIDDEN_KEY, JSON.stringify(hidden));
    return true;
  } catch (err) {
    // Nothing to persist to. The page still hides and restores for as long as it is open.
    return false;
  }
}

/**
 * Which index a row dragged by `dy` from position `from` should land at.
 *
 * @param {number} from - the row's current index.
 * @param {number} dy - how far it has been dragged, in pixels.
 * @param {number} rowHeight
 * @param {number} count
 * @returns {number}
 */
export function dropIndex(from, dy, rowHeight, count) {
  const moved = from + Math.round(dy / rowHeight);
  return Math.min(count - 1, Math.max(0, moved));
}

/**
 * Read the remembered order. Never throws, whatever storage does.
 *
 * A private window, a browser set to block site data, and a quota error all surface as an
 * exception from the accessor itself rather than as a null — so this is a try/catch and not a
 * null check, and the page renders in the generated order when it fires.
 *
 * @param {Storage | null | undefined} storage
 * @returns {unknown} whatever was stored, parsed, or null.
 */
export function readOrder(storage) {
  try {
    const raw = storage?.getItem(ORDER_KEY);
    if (typeof raw !== 'string') return null;
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

/**
 * Remember an order, or forget it when given null. Never throws.
 *
 * @param {Storage | null | undefined} storage
 * @param {string[] | null} order
 * @returns {boolean} whether it was actually written.
 */
export function writeOrder(storage, order) {
  try {
    if (order === null) storage?.removeItem(ORDER_KEY);
    else storage?.setItem(ORDER_KEY, JSON.stringify(order));
    return true;
  } catch (err) {
    // Nothing to persist to. The order still holds for as long as this page is open, which is a
    // better answer than refusing to reorder at all.
    return false;
  }
}

// --- the page ------------------------------------------------------------------------------------
//
// Everything below touches the DOM and runs only in a browser. Guarded, so importing this module
// in the test runner exercises the rules above without going near a document that is not there.

function wire(doc, storage) {
  const container = doc.querySelector('[data-feature-list]');
  if (!container) return;

  const rows = new Map();
  for (const node of container.querySelectorAll('[data-slug]')) {
    rows.set(node.getAttribute('data-slug'), node);
  }
  const generated = [...rows.keys()];
  // Expand/collapse (below) is every row's own affordance and has to be wired regardless of how
  // many rows there are — a project with exactly one workstream still has to open. Reordering,
  // dragging and hiding are meaningless for a single row, and stay gated behind this instead.
  const canReorder = generated.length >= 2;

  const said = doc.querySelector('[data-order-said]');
  const hiddenBar = doc.querySelector('[data-hidden-bar]');
  let order = orderSlugs(generated, readOrder(storage));
  let hidden = partitionHidden(order, readHidden(storage)).hidden;

  const nameOf = (slug) => rows.get(slug)?.querySelector('[data-row-handle]')?.getAttribute('data-name') || slug;

  function renderHiddenBar() {
    if (!hiddenBar) return;
    hiddenBar.textContent = '';
    if (hidden.length === 0) {
      hiddenBar.setAttribute('hidden', '');
      return;
    }
    hiddenBar.removeAttribute('hidden');

    const label = doc.createElement('span');
    label.className = 'hidden-bar-label';
    label.textContent = hidden.length === 1 ? '1 feature hidden:' : `${hidden.length} features hidden:`;
    hiddenBar.appendChild(label);

    for (const slug of hidden) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'hidden-restore';
      button.setAttribute('data-restore', slug);
      button.textContent = `Show ${nameOf(slug)}`;
      hiddenBar.appendChild(button);
    }
    if (hidden.length > 1) {
      const all = doc.createElement('button');
      all.type = 'button';
      all.className = 'hidden-restore';
      all.setAttribute('data-restore-all', '');
      all.textContent = 'Show all';
      hiddenBar.appendChild(all);
    }
  }

  function render() {
    const { visible } = partitionHidden(order, hidden);
    for (const [slug, node] of rows) {
      if (visible.includes(slug)) {
        node.removeAttribute('hidden');
      } else {
        node.setAttribute('hidden', '');
      }
    }
    // Reordering real DOM children IS the repaint — no transform, no pixel math for the settled
    // state. Only a live drag (see pointermove below) needs a visual nudge before it lands.
    for (const slug of order) container.appendChild(rows.get(slug));
    renderHiddenBar();
  }

  function commit(next) {
    order = next;
    writeOrder(storage, order);
    render();
  }

  function commitHidden(next, focusSlug) {
    hidden = partitionHidden(order, next).hidden;
    writeHidden(storage, hidden.length ? hidden : null);
    render();
    const landing = focusSlug
      ? hiddenBar?.querySelector(`[data-restore="${focusSlug}"]`) ||
        rows.get(focusSlug)?.querySelector('[data-row-handle]')
      : null;
    if (landing && typeof landing.focus === 'function') landing.focus();
  }

  function toggleExpand(handle) {
    const expanded = handle.getAttribute('aria-expanded') === 'true';
    const spine = doc.getElementById(handle.getAttribute('aria-controls'));
    handle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    if (spine) {
      if (expanded) spine.setAttribute('hidden', '');
      else spine.removeAttribute('hidden');
    }
  }

  render();

  for (const [slug, node] of rows) {
    const handle = node.querySelector('[data-row-handle]');
    if (!handle) continue;

    handle.addEventListener('keydown', (event) => {
      if (canReorder && (event.key === 'h' || event.key === 'H')) {
        event.preventDefault();
        commitHidden(toggleHidden(hidden, slug), slug);
        if (said) said.textContent = announceHidden(nameOf(slug), hidden.length);
        return;
      }
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        toggleExpand(handle);
        return;
      }
      if (!canReorder) return;
      // Vertical list: up/down move a row, matching arrow-key semantics to the actual layout
      // direction (the SVG version used left/right, because lanes sat side by side).
      const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
      if (delta === 0) return;
      event.preventDefault();
      commit(moveSlug(order, slug, delta));
      handle.focus();
      if (said) said.textContent = announce(order, slug, handle.getAttribute('data-name') || slug);
    });

    let startY = null;
    let startIndex = 0;
    let rowHeight = 1;

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      startY = event.clientY;
      startIndex = order.indexOf(slug);
      // Measured here, not once at setup: at load every `.feature-spine` is `hidden`, and a row
      // that later expands is far taller than its collapsed self. Reading the DRAGGED row's own
      // current height, right as the drag begins, is the only time both "visible" and "this
      // row's real height" are guaranteed true together.
      rowHeight = node.getBoundingClientRect().height || 1;
      node.classList.add('is-dragging');
      try {
        handle.setPointerCapture(event.pointerId);
      } catch (err) {
        // Not every pointer can be captured; move/up still fire on the handle.
      }
    });

    handle.addEventListener('pointermove', (event) => {
      if (startY === null) return;
      const dy = event.clientY - startY;
      // A live visual nudge only — the settled position always comes from `render()`'s DOM
      // reorder. No scale correction needed here: real pixels on the page, not a scaled SVG
      // viewBox.
      node.style.transform = `translateY(${dy}px)`;
    });

    function end(event) {
      if (startY === null) return;
      const dy = event.clientY - startY;
      startY = null;
      node.classList.remove('is-dragging');
      node.style.removeProperty('transform');

      if (!canReorder || Math.abs(dy) < CLICK_SLOP) {
        toggleExpand(handle);
        return;
      }

      const to = dropIndex(startIndex, dy, rowHeight, order.length);
      commit(moveSlug(order, slug, to - order.indexOf(slug)));
      // Parity with the keyboard path, which has always announced its move: a drag that commits
      // a reorder is otherwise silent to anyone not watching the pointer.
      if (said) said.textContent = announce(order, slug, handle.getAttribute('data-name') || slug);
    }

    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  if (hiddenBar) {
    hiddenBar.addEventListener('click', (event) => {
      const target = event.target?.closest?.('[data-restore], [data-restore-all]');
      if (!target) return;
      if (target.hasAttribute('data-restore-all')) {
        commitHidden([], hidden[0]);
        return;
      }
      const slug = target.getAttribute('data-restore');
      commitHidden(toggleHidden(hidden, slug), slug);
      if (said) said.textContent = `${nameOf(slug)} is back on the list.`;
    });
  }
}

function wireTaskLists(doc, storage) {
  for (const list of doc.querySelectorAll('[data-task-list]')) {
    const milestoneKey = list.getAttribute('data-milestone');
    if (!milestoneKey) continue;

    const items = [...list.querySelectorAll('[data-task]')];
    if (items.length < 2) continue;

    function readStored() {
      try {
        const raw = storage?.getItem(taskOrderKey(milestoneKey));
        return typeof raw === 'string' ? JSON.parse(raw) : null;
      } catch (err) {
        return null;
      }
    }
    function writeStored(order) {
      try {
        if (order === null) storage?.removeItem(taskOrderKey(milestoneKey));
        else storage?.setItem(taskOrderKey(milestoneKey), JSON.stringify(order));
      } catch (err) {
        // Nothing to persist to; the order still holds for this page view.
      }
    }

    let order = orderTaskIndices(items.length, readStored());

    function render() {
      for (const index of order) list.appendChild(items[index]);
    }
    function commit(next) {
      order = next;
      writeStored(order);
      render();
    }

    render();

    const said = doc.querySelector('[data-order-said]');

    // The task's own text, for the same kind of live announcement feature rows already get —
    // matching `announce()`'s pattern/wording rather than inventing a second one.
    function taskName(index) {
      return items[index]?.querySelector('.task-text')?.textContent || `task ${index + 1}`;
    }
    function announceTaskMove(originalIndex) {
      if (!said) return;
      const at = order.indexOf(originalIndex);
      if (at === -1) return;
      said.textContent = `${taskName(originalIndex)} moved to position ${at + 1} of ${order.length}.`;
    }

    items.forEach((item, originalIndex) => {
      item.setAttribute('tabindex', '0');
      let startY = null;
      let startPos = 0;
      let rowHeight = 1;

      item.addEventListener('pointerdown', (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        startY = event.clientY;
        startPos = order.indexOf(originalIndex);
        // Measured here, not once at setup: at load, every task list's `.feature-spine` ancestor
        // is `hidden`, so a height read at that point is always 0. The spine is guaranteed
        // visible by the time a drag can start at all.
        rowHeight = item.getBoundingClientRect().height || 1;
        item.classList.add('is-dragging');
        try {
          item.setPointerCapture(event.pointerId);
        } catch (err) {
          // Not every pointer can be captured.
        }
      });
      item.addEventListener('pointermove', (event) => {
        if (startY === null) return;
        item.style.transform = `translateY(${event.clientY - startY}px)`;
      });
      function end(event) {
        if (startY === null) return;
        const dy = event.clientY - startY;
        startY = null;
        item.classList.remove('is-dragging');
        item.style.removeProperty('transform');
        if (Math.abs(dy) < CLICK_SLOP) {
          render(); // snap back — a click on a task row does nothing else
          return;
        }
        const to = dropIndex(startPos, dy, rowHeight, order.length);
        commit(moveSlug(order.map(String), String(originalIndex), to - order.indexOf(originalIndex)).map(Number));
        announceTaskMove(originalIndex);
      }
      item.addEventListener('pointerup', end);
      item.addEventListener('pointercancel', end);

      item.addEventListener('keydown', (event) => {
        const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
        if (delta === 0) return;
        event.preventDefault();
        commit(moveSlug(order.map(String), String(originalIndex), delta).map(Number));
        item.focus();
        announceTaskMove(originalIndex);
      });
    });
  }
}

if (typeof document !== 'undefined') {
  let storage = null;
  try {
    storage = window.localStorage;
  } catch (err) {
    // Blocked site data. Everything below still works; it simply forgets between visits.
  }
  wire(document, storage);
  wireTaskLists(document, storage);
}
