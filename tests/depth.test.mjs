import test from 'node:test';
import assert from 'node:assert/strict';

import { computeLadder, assertLadderResolves } from '../src/depth.mjs';
import { loadConfig, resolveWorkstreams } from '../src/config.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// All fixture data below is invented for this test file only — the generator holds no project
// content of its own (decision 40).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, '..', 'fixture');

// computeLadder consumes exactly what resolveWorkstreams produces: an array of
// { slug, dir, manifestPath, manifest }. These helpers build that shape directly, without
// touching the filesystem, so each test can hand-pick a manifest for a single behaviour.

function milestone(overrides = {}) {
  return {
    id: overrides.id ?? 'M1',
    label: overrides.label ?? overrides.id ?? 'M1',
    depth: 1,
    title: 'A milestone invented for this test',
    status: 'next',
    plan: 'm1-plan.md',
    issue: null,
    pr: null,
    acceptance: { kind: 'demo-script', record: null },
    ...overrides,
  };
}

function manifest(overrides = {}) {
  return {
    codename: 'Nova',
    what: 'A workstream invented for this test',
    stage: 'planned',
    position: 'Designed, not approved',
    gate: 'Owner sign-off before build',
    label: 'workstream:nova',
    design: [{ name: 'nova/Overview v1', where: 'design-project' }],
    milestones: [],
    ...overrides,
  };
}

function entry(slug, manifestOverrides = {}) {
  return {
    slug,
    dir: `/fake/${slug}`,
    manifestPath: `/fake/${slug}/workstream.json`,
    manifest: manifest(manifestOverrides),
  };
}

function rowById(rows, id) {
  return rows.find((r) => r.id === id);
}

// --- decision 20: the ladder is the union of all workstreams' depths ------------------------

test('computeLadder: the ladder is the union of every workstream depth, not the deepest one\'s numbering', () => {
  const deep = entry('deep', {
    codename: 'Deep',
    stage: 'shipping',
    milestones: [1, 2, 3, 4, 5, 6].map((n) =>
      milestone({ id: `M${n}`, label: `M${n}`, depth: n, title: `Deep step ${n}`, status: 'unplanned' }),
    ),
  });
  const shallow = entry('shallow', {
    codename: 'Shallow',
    stage: 'shipping',
    milestones: [1, 2, 3].map((n) =>
      milestone({ id: `M${n}`, label: `M${n}`, depth: n, title: `Shallow step ${n}`, status: 'unplanned' }),
    ),
  });

  const { rows, columns } = computeLadder([deep, shallow]);

  const milestoneRows = rows.filter((r) => r.kind === 'milestone');
  assert.equal(milestoneRows.length, 6, 'the ladder must reach as deep as the deepest workstream');
  assert.deepEqual(
    milestoneRows.map((r) => r.depth),
    [1, 2, 3, 4, 5, 6],
  );

  // The row labels are the shared ladder's own generic numbering, never a workstream's titles.
  for (const row of milestoneRows) {
    assert.equal(row.label, String(row.depth));
    assert.ok(!row.label.includes('Deep') && !row.label.includes('Shallow'));
  }

  // Shallow's column must not force the ladder to invent Shallow-specific labels for rows 4-6,
  // and Shallow's own column data must never reach past its own depth of 3.
  const shallowCol = columns.find((c) => c.codename === 'Shallow');
  assert.equal(shallowCol.headAt, 'depth-1', 'Shallow has no business pointing past its own next milestone');
});

// --- decision 23: three pre-milestone stages sit above the first milestone ------------------

test('computeLadder: three pre-milestone stages sit above the first milestone, in order', () => {
  const { rows } = computeLadder([entry('nova', { stage: 'planned', milestones: [] })]);

  const stageRows = rows.filter((r) => r.kind === 'stage');
  assert.deepEqual(
    stageRows.map((r) => r.id),
    ['not-started', 'designing', 'planned'],
  );
  assert.deepEqual(
    stageRows.map((r) => r.label),
    ['Not started', 'Designing', 'Planned'],
  );

  // They come before every numbered depth row.
  const firstMilestoneIndex = rows.findIndex((r) => r.kind === 'milestone');
  const lastStageIndex = rows.map((r) => r.kind).lastIndexOf('stage');
  if (firstMilestoneIndex !== -1) {
    assert.ok(lastStageIndex < firstMilestoneIndex);
  }
});

// --- the one rule: the bar covers what's complete; the head points past it ------------------

test('computeLadder: a workstream whose last milestone is done puts the head beyond it, not on it', () => {
  const w = entry('finisher', {
    codename: 'Finisher',
    stage: 'shipping',
    milestones: [
      milestone({ id: 'M1', label: 'M1', depth: 1, status: 'done' }),
      milestone({ id: 'M2', label: 'M2', depth: 2, status: 'done' }),
    ],
  });

  const { rows, columns } = computeLadder([w]);
  const col = columns[0];

  // The bar must reach the last completed milestone's own row...
  assert.equal(col.barTo, 'depth-2');
  // ...and the head must NOT sit on that same row: it must be strictly deeper.
  assert.notEqual(col.headAt, col.barTo);
  const headDepth = Number(col.headAt.replace('depth-', ''));
  assert.ok(headDepth > 2, `expected the head beyond depth 2, got ${col.headAt}`);

  // The row the head lands on must actually exist on the ladder, so the arrow has somewhere to
  // be drawn.
  assert.ok(rowById(rows, col.headAt), 'the ladder must grow a row for the head to land on');

  // decision 20 at the level of a single string: the tip names Finisher's own next id, not the
  // ladder row's generic number. Pin the actual format, not just "differs from the row label" —
  // 'TBD', 'Milestone 3', 'm3', or a genuine off-by-one bug like `M${depth - 1}` would all pass
  // a bare inequality silently.
  const landedRow = rowById(rows, col.headAt);
  assert.notEqual(col.tipLabel, landedRow.label);
  assert.equal(col.tipLabel, 'M3');
});

test('computeLadder: a workstream whose final milestone is NOT done keeps the head on the very next milestone (control)', () => {
  const w = entry('inflight', {
    codename: 'Inflight',
    stage: 'shipping',
    milestones: [
      milestone({ id: 'M1', label: 'M1', depth: 1, status: 'done' }),
      milestone({ id: 'M2', label: 'M2', depth: 2, status: 'next' }),
    ],
  });
  const { columns } = computeLadder([w]);
  const col = columns[0];
  assert.equal(col.barTo, 'depth-1');
  assert.equal(col.headAt, 'depth-2');
  assert.equal(col.tipLabel, 'M2');
});

// --- pre-milestone bar shapes -----------------------------------------------------------------

test('computeLadder: designing with no milestones bars two stages and produces no milestone rows', () => {
  const { rows, columns } = computeLadder([entry('harbor', { codename: 'Harbor', stage: 'designing', milestones: [] })]);
  const col = columns[0];

  assert.equal(col.barTo, 'designing');
  assert.equal(col.headAt, 'planned');
  assert.equal(col.tipLabel, 'Planned');

  const milestoneRows = rows.filter((r) => r.kind === 'milestone');
  assert.equal(milestoneRows.length, 0, 'a bare designing-stage workstream must not invent milestone rows');
});

test('computeLadder: a workstream with nothing at all produces no bar', () => {
  const { columns } = computeLadder([entry('void', { codename: 'Void', stage: 'not-started', milestones: [] })]);
  const col = columns[0];

  assert.equal(col.barTo, null);
  // The head still exists — it points at what's next, which for nothing at all is the very
  // first row of the ladder.
  assert.equal(col.headAt, 'not-started');
  assert.equal(col.tipLabel, 'Not started');
});

// --- decision 25: every column carries a note --------------------------------------------------

test('computeLadder: every column carries the manifest\'s gate as its note', () => {
  const { columns } = computeLadder([
    entry('nova', { gate: 'Owner sign-off before the next step' }),
  ]);
  assert.equal(columns[0].note, 'Owner sign-off before the next step');
});

// --- tipLabel is the column's own id, never a ladder row label --------------------------------

test('computeLadder: tipLabel is the column\'s own milestone id, never the ladder row\'s shared label', () => {
  const beaconLike = entry('beacon', {
    codename: 'Beacon',
    stage: 'shipping',
    milestones: [1, 2, 3, 4].map((n) =>
      milestone({
        id: `M${n}`,
        label: `M${n}`,
        depth: n,
        title: `Beacon step ${n}`,
        status: n <= 3 ? 'done' : 'next',
      }),
    ),
  });
  const tideLike = entry('tide', {
    codename: 'Tide',
    stage: 'shipping',
    milestones: [1, 2].map((n) =>
      milestone({
        id: `M${n}`,
        label: `M${n}`,
        depth: n,
        title: `Tide step ${n}`,
        status: n <= 1 ? 'done' : 'next',
      }),
    ),
  });

  const { rows, columns } = computeLadder([beaconLike, tideLike]);
  const beaconCol = columns.find((c) => c.codename === 'Beacon');
  const tideCol = columns.find((c) => c.codename === 'Tide');

  // Both columns' heads land on a "depth-2" row at some point in their life, but here Beacon's
  // head is at depth-4 and Tide's is at depth-2 — same row id class, different own ids.
  assert.equal(beaconCol.tipLabel, 'M4');
  assert.equal(tideCol.tipLabel, 'M2');

  // Neither tip equals the shared row's own generic label.
  assert.notEqual(beaconCol.tipLabel, rowById(rows, beaconCol.headAt).label);
  assert.notEqual(tideCol.tipLabel, rowById(rows, tideCol.headAt).label);
});

// --- full fixture integration ------------------------------------------------------------------

test('computeLadder: the fixture project (6 / 3 / 0 / 4-done depths) produces the expected columns', () => {
  const config = loadConfig(FIXTURE_ROOT);
  const workstreams = resolveWorkstreams(config);
  const { rows, columns } = computeLadder(workstreams);

  assert.deepEqual(columns.map((c) => c.codename), ['Beacon', 'Tide', 'Harbor', 'Anchor']);

  const milestoneRows = rows.filter((r) => r.kind === 'milestone');
  assert.equal(milestoneRows.length, 6, 'the ladder must be as deep as Beacon, the deepest workstream');

  const beacon = columns.find((c) => c.codename === 'Beacon');
  assert.equal(beacon.barTo, 'depth-3');
  assert.equal(beacon.headAt, 'depth-4');
  assert.equal(beacon.tipLabel, 'M4');

  const tide = columns.find((c) => c.codename === 'Tide');
  assert.equal(tide.barTo, 'depth-1');
  assert.equal(tide.headAt, 'depth-2');
  assert.equal(tide.tipLabel, 'M2');

  const harbor = columns.find((c) => c.codename === 'Harbor');
  assert.equal(harbor.barTo, 'designing');
  assert.equal(harbor.headAt, 'planned');
  assert.equal(harbor.tipLabel, 'Planned');

  for (const col of columns) {
    assert.ok(typeof col.note === 'string' && col.note.length > 0, `${col.codename} must carry a note`);
  }
});

test('computeLadder: Anchor, the fixture\'s one fully-done workstream, puts the head past its last milestone', () => {
  const config = loadConfig(FIXTURE_ROOT);
  const workstreams = resolveWorkstreams(config);
  const { rows, columns } = computeLadder(workstreams);

  const anchor = columns.find((c) => c.codename === 'Anchor');
  // Anchor's manifest runs M1-M4, all `done` — the bar must reach depth-4, its own last
  // milestone, and the head must sit strictly past it rather than on it.
  assert.equal(anchor.barTo, 'depth-4');
  assert.notEqual(anchor.headAt, anchor.barTo);
  assert.equal(anchor.headAt, 'depth-5');
  assert.ok(rowById(rows, anchor.headAt), 'the ladder must have a real row for the head to land on');
  // No milestone is recorded at depth 5 for Anchor — the tip falls back to the M<n> convention,
  // never the shared row's bare number.
  assert.equal(anchor.tipLabel, 'M5');
  assert.notEqual(anchor.tipLabel, rowById(rows, anchor.headAt).label);
});

// --- decision 32: the ladder's own invariant, asserted where code can throw ----------------------

// `theme/depth.njk` resolves barTo and headAt to row indices by scanning ladder.rows. If either id
// were ever absent, the indices would stay -1 and the column would render with no bar and no head:
// a silently blank column rather than a failure. A template cannot throw, so the invariant is
// asserted here, in code that can, and the build calls it before it renders anything.
//
// Nothing a manifest can say produces an unresolvable ladder while computeLadder is correct — the
// row set is derived from the same depths the columns are. That is exactly why this is worth
// asserting: it is the check that catches computeLadder itself regressing.

test('assertLadderResolves: a ladder whose ids all name real rows passes through unchanged', () => {
  const ladder = computeLadder([
    entry('alpha', { codename: 'Alpha', milestones: [milestone({ status: 'done' })] }),
  ]);
  assert.equal(assertLadderResolves(ladder), ladder);
});

test('assertLadderResolves: a headAt naming no row fails loudly, naming the column and the id', () => {
  const ladder = computeLadder([
    entry('alpha', { codename: 'Alpha', milestones: [milestone({ status: 'done' })] }),
  ]);
  ladder.columns[0].headAt = 'depth-99';

  assert.throws(
    () => assertLadderResolves(ladder),
    (err) => {
      assert.match(err.message, /Alpha/, 'the failure never named the column');
      assert.match(err.message, /depth-99/, 'the failure never named the row id that does not exist');
      assert.match(err.message, /headAt/, 'the failure never said which end of the column was broken');
      return true;
    },
  );
});

test('assertLadderResolves: a barTo naming no row fails loudly too', () => {
  const ladder = computeLadder([
    entry('alpha', { codename: 'Alpha', milestones: [milestone({ status: 'done' })] }),
  ]);
  ladder.columns[0].barTo = 'not-a-row';

  assert.throws(
    () => assertLadderResolves(ladder),
    (err) => {
      assert.match(err.message, /Alpha/);
      assert.match(err.message, /barTo/);
      assert.match(err.message, /not-a-row/);
      return true;
    },
  );
});

test('assertLadderResolves: a null barTo is a column with nothing complete yet, not a broken one', () => {
  const ladder = computeLadder([entry('alpha', { codename: 'Alpha', stage: 'not-started', milestones: [] })]);
  assert.equal(ladder.columns[0].barTo, null);
  assert.doesNotThrow(() => assertLadderResolves(ladder));
});

// --- decision 24, once: completion is counted here and nowhere else --------------------------

test('computeLadder: a column carries its own completion, counted as the contiguous run the bar draws', () => {
  // The phone view and the depth chart used to answer "how much of this is complete?" separately,
  // and disagreed: the chart counts the contiguous run from depth 1 (a done M3 behind an un-done
  // M2 does not extend the bar past M1), the phone counted every `done` milestone anywhere. One
  // count now, on the column, so the two surfaces cannot drift again.
  const [column] = computeLadder([
    entry('gapped', {
      codename: 'Gapped',
      stage: 'shipping',
      milestones: [
        milestone({ id: 'M1', label: 'M1', depth: 1, status: 'next' }),
        milestone({ id: 'M2', label: 'M2', depth: 2, status: 'done' }),
        milestone({ id: 'M3', label: 'M3', depth: 3, status: 'parked' }),
      ],
    }),
  ]).columns;

  // The bar still covers the three pre-milestone stages a shipping workstream is past; what it
  // does NOT cover is any milestone, and that is what the phone view draws.
  assert.equal(column.barTo, 'planned', 'the bar stops at the last pre-milestone row');
  assert.equal(column.headAt, 'depth-1', 'the head points at M1, which is not done');
  assert.equal(column.completedCount, 0, 'a done M2 behind an un-done M1 completes nothing');
  assert.equal(column.milestoneCount, 3);
  assert.deepEqual(
    column.covered,
    [false, false, false],
    'no segment may be filled while the bar covers no milestone',
  );
});

test('computeLadder: completion covers the run from depth 1, in the order the manifest lists', () => {
  const [column] = computeLadder([
    entry('run', {
      codename: 'Run',
      stage: 'shipping',
      milestones: [
        // Deliberately out of depth order, because the manifest is allowed to be and the
        // segments are drawn in the order the manifest lists.
        milestone({ id: 'M3', label: 'M3', depth: 3, status: 'unplanned' }),
        milestone({ id: 'M1', label: 'M1', depth: 1, status: 'done' }),
        milestone({ id: 'M2', label: 'M2', depth: 2, status: 'done' }),
      ],
    }),
  ]).columns;

  assert.equal(column.completedCount, 2);
  assert.equal(column.milestoneCount, 3);
  assert.deepEqual(column.covered, [false, true, true]);
  assert.equal(column.headAt, 'depth-3', 'the head sits one past the completed run');
});

test('computeLadder: a workstream with no milestones completes nothing and has nothing to draw', () => {
  const [column] = computeLadder([entry('bare', { codename: 'Bare', stage: 'designing' })]).columns;
  assert.equal(column.completedCount, 0);
  assert.equal(column.milestoneCount, 0);
  assert.deepEqual(column.covered, []);
});
