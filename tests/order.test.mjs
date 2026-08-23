import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HIDDEN_KEY,
  ORDER_KEY,
  announce,
  announceHidden,
  dropIndex,
  layout,
  moveSlug,
  orderSlugs,
  partitionHidden,
  readHidden,
  readOrder,
  toggleHidden,
  writeHidden,
  writeOrder,
} from '../theme/order.js';

// The reordering the owner asked for, and the three ways a remembered order goes stale.
//
// Every slug below is invented for this test file. The generator holds no project content of its
// own (decision 40).
//
// KNOWN LIMIT, stated rather than hidden: there is no browser in this environment, so the event
// plumbing in `theme/order.js` — pointerdown, pointermove, keydown — is not exercised here. What
// IS exercised is every rule those handlers apply, because they are pure functions the module
// exports for exactly that reason. Importing this module also proves it does not touch `document`
// at import time, which is why the test runner can load it at all.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.resolve(__dirname, '..', 'theme', 'order.js'), 'utf8');

const GENERATED = ['keel', 'mast', 'rudder', 'tiller'];

// --- what to render ------------------------------------------------------------------------------

test('order: with nothing remembered, the generated order is what renders', () => {
  assert.deepEqual(orderSlugs(GENERATED, null), GENERATED);
  assert.deepEqual(orderSlugs(GENERATED, undefined), GENERATED);
});

test('order: a remembered order is honoured', () => {
  assert.deepEqual(orderSlugs(GENERATED, ['tiller', 'keel', 'rudder', 'mast']), [
    'tiller',
    'keel',
    'rudder',
    'mast',
  ]);
});

test('order: a feature the stored order has never heard of goes to the end, in the config’s order', () => {
  // The case that matters: a workstream added to atlas.config.json months after the reader last
  // dragged anything. It must appear, and it must not displace the order they chose.
  assert.deepEqual(orderSlugs(GENERATED, ['rudder', 'keel']), ['rudder', 'keel', 'mast', 'tiller']);
});

test('order: a stored slug that no longer exists is ignored, and leaves no hole', () => {
  assert.deepEqual(orderSlugs(GENERATED, ['ghost', 'tiller', 'kraken', 'keel']), [
    'tiller',
    'keel',
    'mast',
    'rudder',
  ]);
});

test('order: no stored value, however wrong, loses a feature or renders one twice', () => {
  // Storage is a string a person can edit, a value another version of the page wrote, or something
  // a different site left behind. None of these may throw, and none may lose a feature.
  const nonsense = [
    null,
    undefined,
    42,
    'tiller',
    {},
    { order: ['keel'] },
    [],
    [null, undefined, 7, {}],
    ['keel', 'keel', 'keel'],
    ['ghost'],
    [...GENERATED, ...GENERATED],
  ];

  for (const stored of nonsense) {
    const result = orderSlugs(GENERATED, stored);
    assert.deepEqual(
      [...result].sort(),
      [...GENERATED].sort(),
      `${JSON.stringify(stored)} produced ${JSON.stringify(result)} — every feature, exactly once`,
    );
  }
});

// --- moving one ------------------------------------------------------------------------------------

test('order: moving a feature shifts it by one and shifts nothing else out of the list', () => {
  assert.deepEqual(moveSlug(GENERATED, 'rudder', -1), ['keel', 'rudder', 'mast', 'tiller']);
  assert.deepEqual(moveSlug(GENERATED, 'keel', 1), ['mast', 'keel', 'rudder', 'tiller']);
  assert.deepEqual(moveSlug(GENERATED, 'keel', 3), ['mast', 'rudder', 'tiller', 'keel']);
});

test('order: moving past either end is a no-op, not an error and not a wrap-around', () => {
  assert.deepEqual(moveSlug(GENERATED, 'keel', -1), GENERATED);
  assert.deepEqual(moveSlug(GENERATED, 'tiller', 1), GENERATED);
  assert.deepEqual(moveSlug(GENERATED, 'nobody', 1), GENERATED);
});

test('order: moving never mutates the order it was given', () => {
  const before = [...GENERATED];
  moveSlug(GENERATED, 'keel', 2);
  assert.deepEqual(GENERATED, before);
});

// --- where a lane lands ----------------------------------------------------------------------------

test('order: a lane sits at its own place times the pitch, and nowhere else', () => {
  assert.deepEqual([...layout(['b', 'a', 'c'], 240)], [
    ['b', 0],
    ['a', 240],
    ['c', 480],
  ]);
});

test('order: a drag lands on the nearest column, and cannot leave the row', () => {
  assert.equal(dropIndex(1, 0, 240, 4), 1, 'a drag that went nowhere must change nothing');
  assert.equal(dropIndex(1, 119, 240, 4), 1, 'less than half a column is not a move');
  assert.equal(dropIndex(1, 121, 240, 4), 2);
  assert.equal(dropIndex(1, -260, 240, 4), 0);
  assert.equal(dropIndex(1, -9000, 240, 4), 0, 'dragged off the left, it stops at the left');
  assert.equal(dropIndex(1, 9000, 240, 4), 3, 'dragged off the right, it stops at the right');
});

test('dropIndex: a downward drag past half the row height moves to the next row', () => {
  assert.equal(dropIndex(0, 30, 52, 4), 1); // 30 > 52/2, rounds up to index 1
});

test('dropIndex: a small drag within half a row height snaps back to the same row', () => {
  assert.equal(dropIndex(0, 10, 52, 4), 0);
});

// --- saying it out loud ------------------------------------------------------------------------------

test('order: a keyboard move is said out loud, because moving a lane is silent otherwise', () => {
  // A move rewrites a `transform` on an SVG group, which a screen reader has no reason to
  // announce. Without this a reader pressing an arrow key gets silence and cannot tell whether
  // the key did anything.
  assert.equal(announce(GENERATED, 'mast', 'Mast'), 'Mast moved to position 2 of 4.');
  assert.equal(announce(GENERATED, 'keel', 'Keel'), 'Keel moved to position 1 of 4.');
  assert.equal(announce(GENERATED, 'tiller', 'Tiller'), 'Tiller moved to position 4 of 4.');
  // Its own name, not its slug: the reader is looking at the codename on the header.
  assert.ok(!announce(GENERATED, 'mast', 'Mast').includes('mast'));
  assert.equal(announce(GENERATED, 'nobody', 'Nobody'), '');
});

// --- storage, which is allowed to fail --------------------------------------------------------------

function fakeStorage(initial) {
  const values = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    values,
  };
}

const throwingStorage = {
  getItem() {
    throw new DOMException('The operation is insecure.');
  },
  setItem() {
    throw new DOMException('The quota has been exceeded.');
  },
  removeItem() {
    throw new DOMException('The operation is insecure.');
  },
};

test('order: it is remembered under one key, as a list of slugs', () => {
  const storage = fakeStorage();
  assert.equal(writeOrder(storage, ['tiller', 'keel']), true);
  assert.equal(storage.values.get(ORDER_KEY), '["tiller","keel"]');
  assert.deepEqual(readOrder(storage), ['tiller', 'keel']);
});

test('order: forgetting it removes the key rather than storing an empty one', () => {
  const storage = fakeStorage({ [ORDER_KEY]: '["tiller"]' });
  writeOrder(storage, null);
  assert.equal(storage.values.has(ORDER_KEY), false);
  assert.equal(readOrder(storage), null);
});

test('order: storage that throws is an answer, not a crash — a private window does this', () => {
  // Both accessors throw in a browser set to block site data, and `setItem` throws on quota. The
  // page must render in the generated order and go on working for as long as it is open.
  assert.equal(readOrder(throwingStorage), null);
  assert.equal(writeOrder(throwingStorage, ['keel']), false);
  assert.equal(writeOrder(throwingStorage, null), false);
  assert.deepEqual(orderSlugs(GENERATED, readOrder(throwingStorage)), GENERATED);
});

test('order: storage that is missing entirely is an answer too', () => {
  assert.equal(readOrder(null), null);
  assert.equal(readOrder(undefined), null);
  assert.equal(writeOrder(null, ['keel']), true);
});

test('order: a stored value that is not JSON is discarded rather than thrown over', () => {
  assert.equal(readOrder(fakeStorage({ [ORDER_KEY]: 'not json at all' })), null);
  assert.equal(readOrder(fakeStorage({ [ORDER_KEY]: '' })), null);
  assert.deepEqual(orderSlugs(GENERATED, readOrder(fakeStorage({ [ORDER_KEY]: '{' }))), GENERATED);
});

// --- the promises the module makes about itself ------------------------------------------------------

test('order: every touch of storage is wrapped, so none of them can reach the page', () => {
  // Counted rather than trusted: each accessor must appear, and each must sit inside a try block.
  for (const accessor of ['getItem', 'setItem', 'removeItem', 'window.localStorage']) {
    assert.ok(SOURCE.includes(accessor), `the module never calls ${accessor}`);
  }
  const tryBlocks = SOURCE.split('try {').slice(1);
  for (const accessor of ['getItem', 'setItem', 'removeItem', 'window.localStorage']) {
    const inside = tryBlocks.some((block) => block.slice(0, block.indexOf('} catch')).includes(accessor));
    assert.ok(inside, `${accessor} is called outside a try/catch`);
  }
});

test('order: no drag library — decision 9 fixes the runtime dependencies at two', () => {
  assert.ok(!/^\s*import\s/m.test(SOURCE), 'the ordering module imports something');
  assert.match(SOURCE, /pointerdown/, 'the drag is not built on pointer events');
  assert.ok(!/\brequire\(/.test(SOURCE), 'the ordering module requires something');
});

// --- hiding a feature, and bringing it back (#780, decision 49) --------------------------------
//
// The whole risk of this capability is stated in the milestone plan and worth repeating where the
// tests live: "a page that silently omits a workstream is worse than one that shows too many."
// So the rules below are not about hiding. They are about the guarantee that nothing is ever lost.

test('hide: every feature is either shown or named as hidden — never neither, never both', () => {
  // The invariant the whole capability rests on. Whatever is in storage, the two lists together
  // are exactly the features the build rendered, each once: a feature cannot fall between them.
  const nonsense = [
    null,
    undefined,
    42,
    'tiller',
    {},
    { hidden: ['keel'] },
    [],
    [null, undefined, 7, {}],
    ['keel', 'keel', 'keel'],
    ['ghost'],
    ['keel', 'ghost', 'mast'],
    [...GENERATED, ...GENERATED],
    Array.from({ length: 10000 }, (_, i) => (i % 2 ? 'keel' : `ghost-${i}`)),
  ];

  for (const stored of nonsense) {
    const { visible, hidden } = partitionHidden(GENERATED, stored);
    assert.deepEqual(
      [...visible, ...hidden].sort(),
      [...GENERATED].sort(),
      `${String(JSON.stringify(stored)).slice(0, 60)} lost or duplicated a feature`,
    );
    // And each list keeps the order the build rendered in, so the page never reshuffles itself
    // as a side effect of something being hidden.
    assert.deepEqual(visible, GENERATED.filter((slug) => visible.includes(slug)));
    assert.deepEqual(hidden, GENERATED.filter((slug) => hidden.includes(slug)));
  }
});

test('hide: with nothing remembered, nothing is hidden', () => {
  assert.deepEqual(partitionHidden(GENERATED, null), { visible: GENERATED, hidden: [] });
});

test('hide: a remembered hidden feature is hidden, and named', () => {
  const { visible, hidden } = partitionHidden(GENERATED, ['mast', 'tiller']);
  assert.deepEqual(visible, ['keel', 'rudder']);
  assert.deepEqual(hidden, ['mast', 'tiller'], 'the hidden ones must be nameable, not merely counted');
});

test('hide: hiding every feature is allowed, because it is recoverable', () => {
  // Not guarded against. A reader who hides everything gets an empty chart and a strip naming all
  // four, which is recoverable; refusing the last one would be a rule they cannot see the reason
  // for. The guarantee is recoverability, not a minimum.
  const { visible, hidden } = partitionHidden(GENERATED, GENERATED);
  assert.deepEqual(visible, []);
  assert.deepEqual(hidden, GENERATED);
});

test('hide: toggling adds and removes one feature, and touches nothing else', () => {
  assert.deepEqual(toggleHidden([], 'mast'), ['mast']);
  assert.deepEqual(toggleHidden(['mast'], 'mast'), []);
  assert.deepEqual(toggleHidden(['mast'], 'keel'), ['mast', 'keel']);
  // Already hidden twice, which storage can contain: toggling clears both rather than one.
  assert.deepEqual(toggleHidden(['mast', 'mast'], 'mast'), []);

  const before = ['mast'];
  toggleHidden(before, 'keel');
  assert.deepEqual(before, ['mast'], 'toggling mutated the list it was given');
});

test('hide: hiding is remembered under its OWN key, never the order’s', () => {
  // Two separate concerns with two separate lifetimes: "back to the generated order" must not
  // un-hide anything, and bringing a feature back must not reshuffle the page.
  assert.notEqual(HIDDEN_KEY, ORDER_KEY);

  const storage = fakeStorage();
  writeOrder(storage, ['tiller', 'keel']);
  writeHidden(storage, ['mast']);
  assert.deepEqual(readOrder(storage), ['tiller', 'keel']);
  assert.deepEqual(readHidden(storage), ['mast']);

  writeOrder(storage, null);
  assert.deepEqual(readHidden(storage), ['mast'], 'resetting the order forgot what was hidden');
});

test('hide: storage that throws leaves every feature on the page', () => {
  // The failure that matters most. If reading storage throws and the code treats that as "hide
  // everything", the reader gets a blank chart in a private window with no way to tell why.
  assert.equal(readHidden(throwingStorage), null);
  assert.equal(writeHidden(throwingStorage, ['keel']), false);
  assert.equal(writeHidden(throwingStorage, null), false);
  assert.deepEqual(partitionHidden(GENERATED, readHidden(throwingStorage)).visible, GENERATED);
  assert.deepEqual(partitionHidden(GENERATED, readHidden(throwingStorage)).hidden, []);

  assert.equal(readHidden(null), null);
  assert.equal(readHidden(fakeStorage({ [HIDDEN_KEY]: 'not json at all' })), null);
  assert.deepEqual(partitionHidden(GENERATED, readHidden(fakeStorage({ [HIDDEN_KEY]: '{' }))).visible, GENERATED);
});

test('hide: hiding is said out loud, and says how to undo it', () => {
  // Hiding a feature sets a style on an SVG group, which a screen reader has no reason to
  // announce — so a keyboard user would press a key and get silence, with a column gone. The
  // announcement carries the way back, because "recoverable without knowing it is hidden" has to
  // hold for a reader who cannot see the strip.
  const said = announceHidden('Mast', 2);
  assert.match(said, /Mast/, 'the announcement does not name the feature that went');
  assert.match(said, /hidden/i);
  assert.match(said, /\b2\b/, 'the announcement does not say how many are now hidden');
  assert.match(said, /bring|back|restore|show/i, 'the announcement does not say there is a way back');
});
