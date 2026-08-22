import test from 'node:test';
import assert from 'node:assert/strict';

import { TRIAGE_ORDER, classifyTriage, orderByTriage } from '../src/triage.mjs';
import { MILESTONE_STATUSES, WORKSTREAM_STAGES, validateWorkstream } from '../src/schema.mjs';

// Decision 27's mapping used to live inside `theme/mobile.njk`. It moved here so the phone view
// and `state.json` are fed by one function rather than two derivations that can drift — the
// failure decisions 1 and 29 exist to prevent.
//
// The owner has deliberately not ruled on this mapping's semantics yet. These tests therefore pin
// TODAY'S behaviour, fallback included, so that when the ruling comes the change is one function
// and one table and the diff shows exactly which cells moved. A test here failing after a
// deliberate semantic change is the point; a test here failing by accident is a regression.

// Every manifest this file builds goes through the real schema before a test uses it. Four test
// files carried their own manifest builder and not one ran through `validateWorkstream`, so a
// field the schema requires could be renamed, or a vocabulary tightened, and these doubles would
// go on testing a shape the generator no longer accepts.
function validated(candidate) {
  const result = validateWorkstream(candidate);
  assert.ok(
    result.ok,
    `this test's own manifest is not one the generator would accept: ${JSON.stringify(result.errors)}`,
  );
  return result.value;
}

function manifest(shape) {
  return validated(unvalidatedManifest(shape));
}

// The one caller that must NOT go through the schema: the fallback test below feeds a stage the
// closed vocabulary rejects on purpose, to pin what `classifyTriage` does with one. Separated
// rather than made a flag, so it is impossible to reach by accident.
function unvalidatedManifest({ stage, statuses = [] }) {
  return {
    codename: 'Invented',
    what: 'A workstream invented for this test',
    stage,
    position: 'Invented for this test',
    gate: 'Invented for this test',
    label: 'workstream:invented',
    design: [],
    milestones: statuses.map((status, i) => ({
      id: `M${i + 1}`,
      label: `M${i + 1}`,
      depth: i + 1,
      title: `Milestone ${i + 1}`,
      status,
      plan: `m${i + 1}-plan.md`,
      issue: null,
      pr: null,
      acceptance: { kind: 'demo-script', record: null },
    })),
  };
}

// --- the vocabulary and its order ---------------------------------------------------------------

test('triage: the five states of decision 27, in the order that decision fixes', () => {
  assert.deepEqual(TRIAGE_ORDER, [
    'awaiting-decision',
    'moving',
    'blocked',
    'designing',
    'not-started',
  ]);
});

// --- the table: every stage against every status ------------------------------------------------

// One row per (stage, status) pair, written out as literal expected values rather than derived,
// so this table is a record of the behaviour rather than a second copy of the implementation.
// `null` in the status column means a workstream carrying no milestones at all.
const TABLE = [
  // stage          status        expected
  ['not-started', null, 'not-started'],
  ['not-started', 'done', 'not-started'],
  ['not-started', 'next', 'not-started'],
  ['not-started', 'blocked', 'not-started'],
  ['not-started', 'parked', 'not-started'],
  ['not-started', 'unplanned', 'not-started'],

  ['designing', null, 'designing'],
  ['designing', 'done', 'designing'],
  ['designing', 'next', 'designing'],
  ['designing', 'blocked', 'designing'],
  ['designing', 'parked', 'designing'],
  ['designing', 'unplanned', 'designing'],

  // Designed, not approved: the approval is the owner's to give, whatever the milestones say.
  ['planned', null, 'awaiting-decision'],
  ['planned', 'done', 'awaiting-decision'],
  ['planned', 'next', 'awaiting-decision'],
  ['planned', 'blocked', 'awaiting-decision'],
  ['planned', 'parked', 'awaiting-decision'],
  ['planned', 'unplanned', 'awaiting-decision'],

  // Only a shipping workstream is read through its milestones at all.
  ['shipping', null, 'awaiting-decision'],
  ['shipping', 'done', 'awaiting-decision'],
  ['shipping', 'next', 'moving'],
  ['shipping', 'blocked', 'awaiting-decision'],
  ['shipping', 'parked', 'blocked'],
  ['shipping', 'unplanned', 'awaiting-decision'],
];

test('triage: every stage against every milestone status lands where it lands today', () => {
  for (const [stage, status, expected] of TABLE) {
    const statuses = status === null ? [] : [status];
    assert.equal(
      classifyTriage(manifest({ stage, statuses })),
      expected,
      `stage "${stage}" with ${status === null ? 'no milestones' : `a "${status}" milestone`} must be "${expected}"`,
    );
  }
});

test('triage: the table covers the whole closed vocabulary, so a new value cannot slip in unpinned', () => {
  const stagesInTable = new Set(TABLE.map(([stage]) => stage));
  const statusesInTable = new Set(TABLE.map(([, status]) => status).filter((s) => s !== null));

  assert.deepEqual([...stagesInTable].sort(), [...WORKSTREAM_STAGES].sort());
  assert.deepEqual([...statusesInTable].sort(), [...MILESTONE_STATUSES].sort());
  assert.equal(TABLE.length, WORKSTREAM_STAGES.length * (MILESTONE_STATUSES.length + 1));
});

test('triage: "next" beats "parked" — a workstream moving somewhere is not blocked', () => {
  assert.equal(classifyTriage(manifest({ stage: 'shipping', statuses: ['parked', 'next'] })), 'moving');
  assert.equal(classifyTriage(manifest({ stage: 'shipping', statuses: ['next', 'parked'] })), 'moving');
  assert.equal(classifyTriage(manifest({ stage: 'shipping', statuses: ['done', 'parked'] })), 'blocked');
});

test('triage: a workstream that has run out of milestones is waiting on the owner', () => {
  // Anchor's case in the fixture: four milestones, all done, nothing left on record to do. The
  // fallback puts it first on the phone, which is why it is a fallback rather than an error.
  assert.equal(
    classifyTriage(manifest({ stage: 'shipping', statuses: ['done', 'done', 'done', 'done'] })),
    'awaiting-decision',
  );
});

test('triage: an unrecognised stage falls through to the same fallback, and never throws', () => {
  // The manifest schema closes the stage vocabulary, so this cannot arrive from a validated
  // manifest — which is why it is the one test here that builds an unvalidated one. The mapping's
  // own fallback is pinned anyway, because the owner has deferred ruling on it and a silent change
  // to it is exactly what must not happen.
  assert.equal(
    validateWorkstream(unvalidatedManifest({ stage: 'brand-new-stage' })).ok,
    false,
    'the schema must still reject this stage, or this test is about nothing',
  );

  const odd = (statuses) => unvalidatedManifest({ stage: 'brand-new-stage', statuses });
  assert.equal(classifyTriage(odd([])), 'awaiting-decision');
  assert.equal(classifyTriage(odd(['next'])), 'moving');
  assert.equal(classifyTriage(odd(['parked'])), 'blocked');
});

// --- ordering -----------------------------------------------------------------------------------

function entry(slug, stage, statuses) {
  return { slug, dir: `/fake/${slug}`, manifestPath: `/fake/${slug}/workstream.json`, manifest: manifest({ stage, statuses }) };
}

test('orderByTriage: cards come out in decision 27\'s order, not the config\'s and not alphabetically', () => {
  const entries = [
    entry('alpha', 'not-started', []),
    entry('bravo', 'shipping', ['done']),
    entry('charlie', 'shipping', ['parked']),
    entry('delta', 'shipping', ['next']),
    entry('echo', 'designing', []),
  ];

  assert.deepEqual(
    orderByTriage(entries).map((e) => e.slug),
    ['bravo', 'delta', 'charlie', 'echo', 'alpha'],
  );
});

test('orderByTriage: ties keep the order the config declared, so two cards never swap between builds', () => {
  const entries = [
    entry('third', 'shipping', ['next']),
    entry('first', 'shipping', ['next']),
    entry('second', 'shipping', ['next']),
  ];

  assert.deepEqual(orderByTriage(entries).map((e) => e.slug), ['third', 'first', 'second']);
});

test('orderByTriage: every workstream comes out exactly once, carrying its own state', () => {
  const entries = [
    entry('alpha', 'not-started', []),
    entry('bravo', 'shipping', ['done']),
    entry('charlie', 'shipping', ['parked']),
    entry('delta', 'shipping', ['next']),
    entry('echo', 'designing', []),
    entry('foxtrot', 'planned', []),
  ];

  const ordered = orderByTriage(entries);
  assert.equal(ordered.length, entries.length);
  assert.deepEqual([...ordered.map((e) => e.slug)].sort(), [...entries.map((e) => e.slug)].sort());

  for (const item of ordered) {
    assert.equal(item.triage, classifyTriage(item.manifest), `${item.slug} carries the wrong state`);
    assert.ok(TRIAGE_ORDER.includes(item.triage), `${item.slug} carries a state outside the vocabulary`);
  }

  // The states themselves come out in blocks, in TRIAGE_ORDER — never interleaved.
  const positions = ordered.map((e) => TRIAGE_ORDER.indexOf(e.triage));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

test('orderByTriage: the entries it returns keep every field they arrived with', () => {
  const entries = [{ ...entry('alpha', 'shipping', ['next']), column: { tipLabel: 'M1' } }];
  const [ordered] = orderByTriage(entries);

  assert.equal(ordered.slug, 'alpha');
  assert.equal(ordered.dir, '/fake/alpha');
  assert.equal(ordered.manifestPath, '/fake/alpha/workstream.json');
  assert.deepEqual(ordered.column, { tipLabel: 'M1' });
  assert.equal(ordered.manifest.codename, 'Invented');
});

test('orderByTriage: the input array and its manifests are left untouched', () => {
  const entries = [entry('alpha', 'shipping', ['next']), entry('bravo', 'not-started', [])];
  const before = JSON.parse(JSON.stringify(entries));

  orderByTriage(entries);

  assert.deepEqual(entries, before, 'orderByTriage mutated what it was given');
});
