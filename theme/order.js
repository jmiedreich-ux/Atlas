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
  let order = orderSlugs(generated, readOrder(storage));

  function render() {
    const places = layout(order, pitch);
    for (const [slug, node] of lanes) {
      node.setAttribute('transform', `translate(${places.get(slug)},0)`);
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
  }

  function commit(next) {
    order = next;
    writeOrder(storage, order);
    render();
  }

  render();

  if (reset) {
    reset.addEventListener('click', () => {
      writeOrder(storage, null);
      order = [...generated];
      render();
    });
  }

  for (const [slug, node] of lanes) {
    const handle = node.querySelector('[data-lane-head]');
    if (!handle) continue;

    handle.addEventListener('keydown', (event) => {
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
