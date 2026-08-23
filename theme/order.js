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
// NO GEOMETRY HERE EITHER. `src/chart.mjs` draws every lane about its own origin and places it
// with a single `transform`, so reordering is arithmetic on one number per lane. Nothing on this
// page is measured, and nothing is redrawn.
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
 * A move rewrites a `transform` on an SVG group, which a screen reader has no reason to announce,
 * so a reader moving a feature with the arrow keys would otherwise get silence and no way to tell
 * whether the key did anything — including at either end, where the answer is that it did not.
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
 * Hiding sets a style on an SVG group, which a screen reader has no reason to announce — so a
 * keyboard user would press a key, get silence, and have a column gone. It carries the way back,
 * because "recoverable without knowing it is hidden" has to hold for a reader who cannot see the
 * strip either.
 *
 * @param {string} name - the feature's own codename, as the page shows it.
 * @param {number} count - how many are hidden now.
 * @returns {string}
 */
export function announceHidden(name, count) {
  const many = count === 1 ? '1 feature is' : `${count} features are`;
  return `${name} hidden. ${many} now hidden; bring them back from the controls above the chart.`;
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
 * Where each lane sits, given an order and the column pitch the drawing was built at.
 *
 * @param {string[]} order
 * @param {number} pitch
 * @returns {Map<string, number>} slug to x offset.
 */
export function layout(order, pitch) {
  return new Map(order.map((slug, index) => [slug, index * pitch]));
}

/**
 * Which index a lane dragged by `dx` from position `from` should land at.
 *
 * @param {number} from - the lane's current index.
 * @param {number} dx - how far it has been dragged, in user units.
 * @param {number} pitch
 * @param {number} count
 * @returns {number}
 */
export function dropIndex(from, dx, pitch, count) {
  const moved = from + Math.round(dx / pitch);
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
  const chart = doc.querySelector('[data-planning-chart]');
  const container = doc.querySelector('[data-lanes]');
  if (!chart || !container) return;

  const pitch = Number(chart.getAttribute('data-column-pitch')) || 0;
  if (!pitch) return;

  const lanes = new Map();
  for (const node of container.querySelectorAll('[data-slug]')) {
    lanes.set(node.getAttribute('data-slug'), node);
  }
  const generated = [...lanes.keys()];
  if (generated.length < 2) return;

  const reset = doc.querySelector('[data-order-reset]');
  const said = doc.querySelector('[data-order-said]');
  const hiddenBar = doc.querySelector('[data-hidden-bar]');
  let order = orderSlugs(generated, readOrder(storage));
  let hidden = partitionHidden(order, readHidden(storage)).hidden;

  const nameOf = (slug) => {
    const handle = lanes.get(slug)?.querySelector('[data-lane-head]');
    return handle?.getAttribute('data-name') || slug;
  };

  // The strip that makes hiding recoverable. It NAMES what is hidden rather than counting it, so
  // bringing a feature back never needs the reader to remember which ones they put away — and it
  // is rebuilt from the live list every render, so it cannot go stale against the chart.
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
    // Only what is on the page takes a place, so the remaining features close up rather than
    // leaving a gap where a hidden one used to be.
    const places = layout(visible, pitch);
    for (const [slug, node] of lanes) {
      const place = places.get(slug);
      if (place === undefined) {
        // `display: none` rather than the `hidden` attribute: SVG elements do not honour `hidden`
        // in every browser, and this also takes the header out of the tab order, which the
        // attribute alone would not.
        node.style.display = 'none';
        node.setAttribute('aria-hidden', 'true');
      } else {
        node.style.removeProperty('display');
        node.removeAttribute('aria-hidden');
        node.setAttribute('transform', `translate(${place},0)`);
      }
    }
    // Follow the visual order in the DOM too, so tabbing through the features and reading them
    // with assistive technology both go left to right rather than in the order the build happened
    // to render.
    for (const slug of order) container.appendChild(lanes.get(slug));

    if (reset) {
      const changed = order.some((slug, i) => slug !== generated[i]);
      if (changed) reset.removeAttribute('hidden');
      else reset.setAttribute('hidden', '');
    }

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
    // Focus follows the feature. Hiding one moves it to its own restore button, so a keyboard
    // reader is never left focused on something that is no longer on the page — and lands on the
    // way back rather than having to go looking for it.
    const landing = focusSlug
      ? hiddenBar?.querySelector(`[data-restore="${focusSlug}"]`) ||
        lanes.get(focusSlug)?.querySelector('[data-lane-head]')
      : null;
    if (landing && typeof landing.focus === 'function') landing.focus();
  }

  render();

  if (reset) {
    reset.addEventListener('click', () => {
      writeOrder(storage, null);
      order = [...generated];
      render();
    });
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
      if (said) said.textContent = `${nameOf(slug)} is back on the chart.`;
    });
  }

  for (const [slug, node] of lanes) {
    const handle = node.querySelector('[data-lane-head]');
    if (!handle) continue;

    handle.addEventListener('keydown', (event) => {
      // Hiding, from the keyboard. Drag and click alone are not enough, and the instruction every
      // header points at with `aria-describedby` names this key.
      if (event.key === 'h' || event.key === 'H') {
        event.preventDefault();
        const next = toggleHidden(hidden, slug);
        commitHidden(next, slug);
        if (said) said.textContent = announceHidden(nameOf(slug), hidden.length);
        return;
      }

      const delta = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
      if (delta === 0) return;
      event.preventDefault();
      commit(moveSlug(order, slug, delta));
      handle.focus();
      // Said whether or not the position changed: at either end the useful answer is that the key
      // worked and the feature is already first or last.
      if (said) said.textContent = announce(order, slug, handle.getAttribute('data-name') || slug);
    });

    let startX = null;
    let startIndex = 0;

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      startX = event.clientX;
      startIndex = order.indexOf(slug);
      node.classList.add('is-dragging');
      try {
        handle.setPointerCapture(event.pointerId);
      } catch (err) {
        // Not every pointer can be captured; the move and up handlers still fire on the handle.
      }
    });

    handle.addEventListener('pointermove', (event) => {
      if (startX === null) return;
      // Screen pixels to user units. The drawing is rendered at its natural size unless the
      // viewport is narrower, in which case the browser scales it; measuring the rendered width
      // against the drawn width is what keeps a drag tracking the pointer either way.
      const scale = chart.getBoundingClientRect().width / (Number(chart.getAttribute('width')) || 1);
      const dx = (event.clientX - startX) / (scale || 1);
      node.setAttribute('transform', `translate(${startIndex * pitch + dx},0)`);
    });

    function end(event) {
      if (startX === null) return;
      const scale = chart.getBoundingClientRect().width / (Number(chart.getAttribute('width')) || 1);
      const dx = (event.clientX - startX) / (scale || 1);
      startX = null;
      node.classList.remove('is-dragging');
      const to = dropIndex(startIndex, dx, pitch, order.length);
      commit(moveSlug(order, slug, to - order.indexOf(slug)));
    }

    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
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
}
