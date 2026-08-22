import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ORDER_KEY,
  announce,
  dropIndex,
  layout,
  moveSlug,
  orderSlugs,
  readOrder,
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
