import test from 'node:test';
import assert from 'node:assert/strict';

import { computeLadder, assertLadderResolves, spineDetail } from '../src/depth.mjs';
import { validateWorkstream } from '../src/schema.mjs';
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

function manifest(overrides = {}) {
  return validated({
    codename: 'Nova',
    what: 'A workstream invented for this test',
    stage: 'planned',
    position: 'Designed, not approved',
    gate: 'Owner sign-off before build',
    label: 'workstream:nova',
    design: [{ name: 'nova/Overview v1', where: 'design-project' }],
    milestones: [],
    ...overrides,
  });
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
    stage: 'development',
    milestones: [1, 2, 3, 4, 5, 6].map((n) =>
      milestone({ id: `M${n}`, label: `M${n}`, depth: n, title: `Deep step ${n}`, status: 'unplanned' }),
    ),
  });
  const shallow = entry('shallow', {
    codename: 'Shallow',
    stage: 'development',
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
    stage: 'development',
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

  // INVERTED FROM M2.1, which asserted `tipLabel === 'M3'` here on the grounds that "the tip names
  // Finisher's own next id, not the ladder row's generic number". Both halves of that were true
  // and the conclusion was still wrong: Finisher has no M3. Nothing is recorded past M2, so there
  // is no next milestone to name and the tip names none — see #780's second defect on first render
  // and the fixture's Anchor, where this string reached the phone view as "Next: M5".
  //
  // Decision 20 is unaffected: when a milestone IS recorded where the head lands, the tip is that
  // milestone's own id and never the ladder row's shared number. The control test below is the
  // case that checks it.
  assert.equal(col.tipLabel, null, 'the tip names a milestone Finisher has no record of');
  assert.ok(rowById(rows, col.headAt).label, 'the ladder row still has its own number, which is a different thing');
});

test('computeLadder: a workstream whose final milestone is NOT done keeps the head on the very next milestone (control)', () => {
  const w = entry('inflight', {
    codename: 'Inflight',
    stage: 'development',
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
    stage: 'development',
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
    stage: 'development',
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

test('computeLadder: the fixture project (6 / 3 / 5-with-a-gap / 0 / 4-done / nothing) produces the expected columns', () => {
  const config = loadConfig(FIXTURE_ROOT);
  const workstreams = resolveWorkstreams(config);
  const { rows, columns } = computeLadder(workstreams);

  assert.deepEqual(
    columns.map((c) => c.codename),
    ['Beacon', 'Tide', 'Reef', 'Harbor', 'Anchor', 'Shoal'],
  );

  const milestoneRows = rows.filter((r) => r.kind === 'milestone');
  assert.equal(milestoneRows.length, 6, 'the ladder must be as deep as Beacon, the deepest workstream');

  const beacon = columns.find((c) => c.codename === 'Beacon');
  assert.equal(beacon.barTo, 'depth-3');
  assert.equal(beacon.headAt, 'depth-4');
  assert.equal(beacon.tipLabel, 'M4');
  assert.equal(beacon.liveAt, 'depth-4', 'Beacon M4 is `next`, so that row is where work is under way');
  assert.equal(beacon.recordedTo, 'depth-6', 'M5 and M6 are on record past the bar');

  const tide = columns.find((c) => c.codename === 'Tide');
  assert.equal(tide.barTo, 'depth-1');
  assert.equal(tide.headAt, 'depth-2');
  assert.equal(tide.tipLabel, 'M2');

  // The case the M1 rule got wrong (#780): M3 is parked and M4 and M5 shipped after it, so the
  // bar reaches M5 and M3 is noted rather than stopping the column at M2.
  const reef = columns.find((c) => c.codename === 'Reef');
  assert.equal(reef.barTo, 'depth-5', 'the bar must reach the real edge of finished work');
  assert.equal(reef.headAt, 'depth-6');
  assert.equal(reef.completedCount, 4);
  assert.equal(reef.milestoneCount, 5);
  assert.deepEqual(reef.skipped.map((s) => s.id), ['M3']);
  assert.equal(reef.skipped[0].status, 'parked');
  assert.equal(reef.skipped[0].issue, 703, 'the marker carries the issue number to read the reason at');
  assert.equal(reef.recordedTo, null, 'nothing is recorded past Reef M5, so it has no faint reach');

  const harbor = columns.find((c) => c.codename === 'Harbor');
  assert.equal(harbor.barTo, 'designing');
  assert.equal(harbor.headAt, 'planned');
  assert.equal(harbor.tipLabel, 'Planned');

  // The one column that has completed nothing at all. Its ribbon still has to be drawn — #780:
  // "every feature has one, including those with no milestones" — but the DATA says null.
  const shoal = columns.find((c) => c.codename === 'Shoal');
  assert.equal(shoal.barTo, null);
  assert.equal(shoal.headAt, 'not-started');
  assert.equal(shoal.recordedTo, null);
  assert.equal(shoal.liveAt, null);

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

  // INVERTED FROM M2.1, deliberately rather than deleted. That version asserted
  // `tipLabel === 'M5'` and called it "the M<n> convention for a milestone not yet on the record".
  // #780 saw it rendered: the chart correctly draws NO balloon for this feature, because nothing is
  // recorded past its last milestone, while the phone view read this field and announced
  // "Next: M5" — two surfaces disagreeing in front of the reader about a milestone that does not
  // exist and that no record supports.
  //
  // NOTHING IS NEXT, SO NOTHING IS NAMED. The fallback was inventing the one thing this generator
  // exists never to invent.
  assert.equal(
    anchor.tipLabel,
    null,
    'the tip names a milestone with no record behind it, which is what the phone view then announced',
  );
});

test('computeLadder: the tip is null exactly when no milestone is on record for the head to point at', () => {
  // The general form of the defect above, and the reason it is one field rather than two rules:
  // #780's finding was not that the LABEL was wrong, it was that the chart and the phone view were
  // computed from different readings of the same field. So the field itself says whether there is
  // anything to name, and both surfaces read it.
  const stream = (codename, stage, statuses) => ({
    slug: codename.toLowerCase(),
    manifest: {
      codename,
      stage,
      gate: `Nothing gates ${codename} but this test`,
      milestones: statuses.map((status, i) => ({
        id: `M${i + 1}`,
        label: `M${i + 1}`,
        depth: i + 1,
        status,
      })),
    },
  });

  const { columns } = computeLadder([
    // Every milestone done: the head is past the last record, and nothing is next.
    stream('Anchor', 'development', ['done', 'done']),
    // Approved but nothing written down yet: the head points at a first milestone that has no
    // record either. Same case, and it used to invent "M1".
    stream('Fresh', 'planned', []),
    // A milestone IS recorded where the head lands, so it is named — from the milestone's own id,
    // never the ladder row's shared number.
    stream('Tide', 'development', ['done', 'next']),
    // Still in the stages: the tip is the stage the feature is entering, which is a real state
    // rather than an invented milestone.
    stream('Harbor', 'designing', []),
  ]);

  const tip = (codename) => columns.find((c) => c.codename === codename).tipLabel;
  assert.equal(tip('Anchor'), null, 'a feature past its last record still names a milestone');
  assert.equal(tip('Fresh'), null, 'a feature with no milestones at all still names one');
  assert.equal(tip('Tide'), 'M2', 'a recorded next milestone lost its name');
  assert.equal(tip('Harbor'), 'Planned', 'a feature in the stages lost the stage it is entering');
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
//
// M2.1 INVERTS the rule these tests used to assert. M1 counted the contiguous run from depth 1,
// so the first milestone that was not `done` stopped the bar — the comment in src/depth.mjs said
// as much. #780 rules that wrong for how the work actually goes: a milestone the work went round
// is noted, not treated as a wall, and the bar carries on to the real edge of what is finished.

test('computeLadder: a skipped milestone is noted, and the bar carries on past it', () => {
  // The M1 rule stopped this column dead at the stages, reporting nothing complete while two
  // milestones were finished. The bar now reaches the deepest `done` milestone, and the one the
  // work went round is carried on the column as a skip rather than swallowing everything after it.
  const [column] = computeLadder([
    entry('gapped', {
      codename: 'Gapped',
      stage: 'development',
      milestones: [
        milestone({ id: 'M1', label: 'M1', depth: 1, status: 'done' }),
        milestone({ id: 'M2', label: 'M2', depth: 2, status: 'parked', issue: 709 }),
        milestone({ id: 'M3', label: 'M3', depth: 3, status: 'done' }),
      ],
    }),
  ]).columns;

  assert.equal(column.barTo, 'depth-3', 'the bar must reach the real edge of finished work');
  assert.equal(column.headAt, 'depth-4', 'the head still sits one row past the bar');
  assert.equal(column.completedCount, 2, 'the parked milestone is not finished, so it is not counted');
  assert.equal(column.milestoneCount, 3);
  assert.deepEqual(column.covered, [true, false, true]);

  assert.deepEqual(
    column.skipped,
    [{ id: 'M2', label: 'M2', depth: 2, rowId: 'depth-2', status: 'parked', issue: 709 }],
    'the milestone the work went round must be noted, with its reason and its issue number',
  );
});

test('computeLadder: nothing behind the bar is skipped unless the work really did go round it', () => {
  // The control for the test above. A column with no gap has no skips at all — the marker must
  // not appear merely because a column has milestones.
  const [column] = computeLadder([
    entry('solid', {
      codename: 'Solid',
      stage: 'development',
      milestones: [
        milestone({ id: 'M1', label: 'M1', depth: 1, status: 'done' }),
        milestone({ id: 'M2', label: 'M2', depth: 2, status: 'done' }),
        milestone({ id: 'M3', label: 'M3', depth: 3, status: 'blocked' }),
      ],
    }),
  ]).columns;

  assert.equal(column.barTo, 'depth-2');
  assert.deepEqual(column.skipped, [], 'a milestone BELOW the bar is not skipped, it is simply ahead');
});

test('computeLadder: completion is every finished milestone, in the order the manifest lists', () => {
  const [column] = computeLadder([
    entry('run', {
      codename: 'Run',
      stage: 'development',
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
  assert.equal(column.headAt, 'depth-3', 'the head sits one past the deepest finished milestone');
});

test('computeLadder: a workstream with no milestones completes nothing and has nothing to draw', () => {
  const [column] = computeLadder([entry('bare', { codename: 'Bare', stage: 'designing' })]).columns;
  assert.equal(column.completedCount, 0);
  assert.equal(column.milestoneCount, 0);
  assert.deepEqual(column.covered, []);
  assert.deepEqual(column.skipped, []);
  assert.equal(column.recordedTo, null, 'no milestone is on record, so nothing is recorded ahead');
  assert.equal(column.liveAt, null);
});

// --- #780: the arrow's length is the last milestone that has a record --------------------------

test('computeLadder: recordedTo is the deepest milestone on record, whatever its status', () => {
  // The faint reach's end. Not an expected depth, not a guess — the deepest milestone the manifest
  // actually carries, which is the one number the records already supply.
  const [column] = computeLadder([
    entry('keystone', {
      codename: 'Keystone',
      stage: 'planned',
      milestones: [1, 2, 3, 4, 5, 6].map((depth) =>
        milestone({ id: `M${depth}`, label: `M${depth}`, depth, status: 'blocked', plan: `m${depth}-plan.md` }),
      ),
    }),
  ]).columns;

  assert.equal(column.barTo, 'planned', 'nothing is finished, so the solid arrow ends at the stage it reached');
  assert.equal(column.recordedTo, 'depth-6', 'six milestones are on record, so the faint reach covers six');
  assert.equal(column.liveAt, null, 'nothing is in flight — every milestone is blocked');
});

test('computeLadder: recordedTo is null when nothing is recorded past the bar', () => {
  // A feature with no records beyond its current position has one arrow only (#780).
  const [column] = computeLadder([
    entry('anchor', {
      codename: 'Anchor',
      stage: 'development',
      milestones: [1, 2].map((depth) =>
        milestone({ id: `M${depth}`, label: `M${depth}`, depth, status: 'done', plan: `m${depth}-plan.md` }),
      ),
    }),
  ]).columns;

  assert.equal(column.barTo, 'depth-2');
  assert.equal(column.recordedTo, null, 'the records stop where the finished work does, so there is no faint reach');
});

test('computeLadder: liveAt names the row where work is actually in flight, and only there', () => {
  const inFlight = computeLadder([
    entry('tide', {
      codename: 'Tide',
      stage: 'development',
      milestones: [
        milestone({ id: 'M1', label: 'M1', depth: 1, status: 'done' }),
        milestone({ id: 'M2', label: 'M2', depth: 2, status: 'next', plan: 'm2-plan.md' }),
        milestone({ id: 'M3', label: 'M3', depth: 3, status: 'unplanned', plan: 'm3-plan.md' }),
      ],
    }),
  ]).columns[0];

  assert.equal(inFlight.barTo, 'depth-1');
  assert.equal(inFlight.headAt, 'depth-2');
  assert.equal(inFlight.liveAt, 'depth-2', 'the milestone at the head is `next`, so that row is in flight');

  // The control: the same shape with the head landing on a milestone that is NOT under way.
  const stalled = computeLadder([
    entry('stalled', {
      codename: 'Stalled',
      stage: 'development',
      milestones: [
        milestone({ id: 'M1', label: 'M1', depth: 1, status: 'done' }),
        milestone({ id: 'M2', label: 'M2', depth: 2, status: 'blocked', plan: 'm2-plan.md' }),
      ],
    }),
  ]).columns[0];

  assert.equal(stalled.headAt, 'depth-2');
  assert.equal(stalled.liveAt, null, 'a blocked milestone is not in flight, whatever row it sits on');
});

test('spineDetail: the current (next) milestone is full, everything before it is none if done', () => {
  const milestones = [
    { status: 'done' },
    { status: 'done' },
    { status: 'next' },
  ];
  assert.deepEqual(spineDetail(milestones), ['none', 'none', 'full']);
});

test('spineDetail: the milestone immediately after current, if unplanned, is full-muted', () => {
  const milestones = [
    { status: 'done' },
    { status: 'next' },
    { status: 'unplanned' },
  ];
  assert.deepEqual(spineDetail(milestones), ['none', 'full', 'full-muted']);
});

test('spineDetail: anything further out than the muted one is count', () => {
  const milestones = [
    { status: 'next' },
    { status: 'unplanned' },
    { status: 'unplanned' },
  ];
  assert.deepEqual(spineDetail(milestones), ['full', 'full-muted', 'count']);
});

test('spineDetail: a parked milestone is none, even if it would otherwise be the muted preview', () => {
  const milestones = [
    { status: 'next' },
    { status: 'parked' },
  ];
  assert.deepEqual(spineDetail(milestones), ['full', 'none']);
});

test('spineDetail: a blocked milestone right after current is count, not full-muted (only unplanned earns the preview)', () => {
  const milestones = [
    { status: 'next' },
    { status: 'blocked' },
    { status: 'unplanned' },
  ];
  assert.deepEqual(spineDetail(milestones), ['full', 'count', 'full-muted']);
});

test('spineDetail: no current milestone at all — every milestone is done, parked or count', () => {
  const milestones = [
    { status: 'done' },
    { status: 'done' },
  ];
  assert.deepEqual(spineDetail(milestones), ['none', 'none']);
});

test('spineDetail: no current milestone and nothing done either — everything not done/parked is count', () => {
  const milestones = [{ status: 'unplanned' }, { status: 'blocked' }];
  assert.deepEqual(spineDetail(milestones), ['count', 'count']);
});

test('spineDetail: an empty milestone list returns an empty array', () => {
  assert.deepEqual(spineDetail([]), []);
});
