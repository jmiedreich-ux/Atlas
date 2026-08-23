import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHART, computeChart, wrapText } from '../src/chart.mjs';
import { computeLadder } from '../src/depth.mjs';
import { validateWorkstream } from '../src/schema.mjs';
import { loadConfig, resolveWorkstreams } from '../src/config.mjs';

// All data below is invented for this test file, or comes from the fixture's own invented
// nautical vocabulary. The generator holds no project content of its own (decision 40).
//
// There is no browser here, so nothing below is a visual check. What it checks is the CONSTRUCTION
// #780 settled: which arrows exist, where each one ends, that a head grows out of its own body
// with no gap, that nothing is drawn below the last head, and that a lane stays inside its column.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, '..', 'fixture');

function milestone(overrides = {}) {
  return {
    id: 'M1',
    label: 'M1',
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

function validated(candidate) {
  const result = validateWorkstream(candidate);
  assert.ok(
    result.ok,
    `this test's own manifest is not one the generator would accept: ${JSON.stringify(result.errors)}`,
  );
  return result.value;
}

function entry(codename, overrides = {}) {
  const slug = codename.toLowerCase();
  return {
    slug,
    dir: `/fake/${slug}`,
    manifestPath: `/fake/${slug}/workstream.json`,
    url: `/workstream/${slug}/`,
    manifest: validated({
      codename,
      what: `${codename}, a workstream invented for this test`,
      stage: 'shipping',
      position: 'Invented for this test',
      gate: `Nothing gates ${codename} but this test`,
      label: `workstream:${slug}`,
      design: [],
      milestones: [],
      ...overrides,
    }),
  };
}

// The shape src/build.mjs hands the page: each feature carrying its own ladder column.
function draw(entries) {
  const ladder = computeLadder(entries);
  const withColumns = entries.map((stream, i) => ({ ...stream, column: ladder.columns[i] }));
  return { ladder, chart: computeChart(ladder, withColumns) };
}

function laneOf(chart, codename) {
  const lane = chart.lanes.find((l) => l.codename === codename);
  assert.ok(lane, `no lane drawn for ${codename}`);
  return lane;
}

// The y a run of ribbon ends at, and the y its head ends at. Read off the drawing rather than
// recomputed, so these helpers cannot agree with a bug by making it twice.
function bottomOf(arrow) {
  const last = arrow.segments[arrow.segments.length - 1];
  return last.y + last.height;
}

function headTipY(head) {
  const numbers = head.d.match(/-?\d+(\.\d+)?/g).map(Number);
  return Math.max(...numbers.filter((_, i) => i % 2 === 1));
}

function headBaseY(head) {
  const numbers = head.d.match(/-?\d+(\.\d+)?/g).map(Number);
  return Math.min(...numbers.filter((_, i) => i % 2 === 1));
}

// --- every feature is drawn, and the ladder is not a grid --------------------------------------

test('chart: one lane per feature, at one column pitch apart, each drawn about its own origin', () => {
  const { chart } = draw([entry('Alpha'), entry('Bravo'), entry('Charlie')]);

  assert.deepEqual(chart.lanes.map((l) => l.codename), ['Alpha', 'Bravo', 'Charlie']);
  // Zero-based, because the lanes are their own drawing: the ladder gutter stays put while they
  // scroll sideways under it, and a lane's x is its position in the ORDER, not on the page.
  assert.deepEqual(
    chart.lanes.map((l) => l.x),
    [0, 1, 2].map((i) => i * CHART.columnPitch),
  );

  // Every lane's own geometry is identical, because it is relative to the lane. That is what lets
  // the reordering move a whole feature by rewriting one translate.
  const centres = new Set(chart.lanes.map((l) => l.centre));
  assert.equal(centres.size, 1, 'a lane that positions itself absolutely cannot be reordered');
});

test('chart: a feature’s name box and its ribbon share one centre line', () => {
  // #780: "centre the arrow on its feature's name box. The ribbon is currently offset from the
  // header above it; they should share a centre line." M2.1 gave the header the whole column and
  // left the ribbon at the far left of it.
  //
  // Asserted rather than eyeballed, and asserted as ONE COMPUTED VALUE: a test that recomputed the
  // centre from the same constants the drawing used would agree with any bug that lived in those
  // constants. Both sides here are read off the drawing.
  const { chart } = draw([entry('Alpha'), entry('Bravo'), entry('Charlie')]);

  const boxCentre = chart.head.x + chart.head.width / 2;
  for (const lane of chart.lanes) {
    assert.equal(boxCentre, lane.centre, `${lane.codename}: the name box and the ribbon are off-centre`);
  }
  // Both are drawn about the lane's own origin, so this holds at every viewport width — the SVG is
  // in user units and the page scales nothing. It is the same markup at 1600px and at 390px.
  assert.ok(chart.head.x >= 0, 'the name box hangs off the left of its own column');
  assert.ok(chart.head.x + chart.head.width <= CHART.columnPitch, 'the name box runs into the next column');
});

test('chart: the date column clears the ARROWHEAD, not just the ribbon it grows out of', () => {
  // The first of the two defects #780 found on first render: "an arrowhead is wider than its
  // ribbon, and it eats into the date column beside it ... the text column starts at a fixed
  // offset from the ribbon's CENTRE, which is right for the ribbon and wrong for the head."
  //
  // The three cases named there — Beacon M4's `23 Mar 2026`, Tide M2's `6 Apr 2026` clipped to
  // `6 Apr`, and Reef M5's `11 Jun 2026 → 30 Jun 2026` clipped at the left — are all one bug: a
  // head's flare reaching past `textX`.
  //
  // This pins the RELATION rather than the number, reading both sides off the drawing, so a later
  // change to the head's width or its flare cannot silently re-break it: every arrowhead actually
  // emitted has to end left of the text column its own lane draws in.
  const { chart } = draw([
    entry('Beacon', {
      stage: 'shipping',
      milestones: [
        milestone({ id: 'M1', label: 'M1', depth: 1, status: 'done', started: '2026-03-02', completed: '2026-03-05' }),
        milestone({ id: 'M2', label: 'M2', depth: 2, status: 'next', plan: 'm2-plan.md', started: '2026-03-23' }),
        milestone({ id: 'M3', label: 'M3', depth: 3, status: 'blocked', plan: 'm3-plan.md' }),
      ],
    }),
    entry('Harbor', { stage: 'designing', milestones: [] }),
  ]);

  const rightEdgeOf = (head) => {
    const numbers = head.d.match(/-?\d+(\.\d+)?/g).map(Number);
    return Math.max(...numbers.filter((_, i) => i % 2 === 0));
  };

  let headsChecked = 0;
  for (const lane of chart.lanes) {
    for (const arrow of [lane.solid, lane.faint].filter(Boolean)) {
      headsChecked += 1;
      assert.ok(
        rightEdgeOf(arrow.head) < lane.textX,
        `${lane.codename}: an arrowhead reaches x=${rightEdgeOf(arrow.head)}, into a text column that starts at ${lane.textX}`,
      );
    }
  }
  assert.ok(headsChecked >= 3, 'this test stopped exercising both arrows');

  // And the text still has to sit beside the ribbon rather than halfway across the column: the fix
  // is to clear the head, not to push the dates out of reach of the thing they date.
  assert.ok(
    chart.lanes[0].textX - chart.lanes[0].centre < CHART.columnPitch / 3,
    'the date column was pushed away from the ribbon rather than past the head',
  );
});

test('chart: the ladder is horizontal rules, one per row, and never a vertical grid', () => {
  const { ladder, chart } = draw([entry('Alpha', { stage: 'shipping', milestones: [milestone({ status: 'done' })] })]);

  assert.equal(chart.rows.length, ladder.rows.length, 'a row per ladder row');
  // A rule at every row boundary below the first: the timeline's scale.
  assert.deepEqual(chart.rules, chart.rows.slice(1).map((r) => r.y));
  assert.ok(chart.rules.length > 0, 'no rules at all — the page has no vertical scale');
});

test('chart: milestone identifiers appear in the ladder column, spelled with their M', () => {
  // #780: "the milestone ids belong in the ladder column only." Decision 19: M always means
  // Milestone, and a bare number in a column of them reads as a count.
  const { chart } = draw([
    entry('Alpha', {
      stage: 'shipping',
      milestones: [1, 2].map((depth) => milestone({ id: `M${depth}`, label: `M${depth}`, depth, status: 'done' })),
    }),
  ]);

  assert.deepEqual(
    chart.rows.map((r) => r.caption),
    ['Not started', 'Designing', 'Planned', 'M1', 'M2', 'M3'],
  );
});

test('chart: the four bands run the full width, and execution is by far the tallest', () => {
  const { chart } = draw([
    entry('Alpha', {
      stage: 'shipping',
      milestones: [1, 2, 3, 4].map((depth) =>
        milestone({ id: `M${depth}`, label: `M${depth}`, depth, status: 'done', plan: `m${depth}-plan.md` }),
      ),
    }),
  ]);

  assert.deepEqual(chart.bands.map((b) => b.id), ['not-started', 'designing', 'planned', 'execution']);

  const execution = chart.bands.find((b) => b.id === 'execution');
  const shortest = Math.min(...chart.bands.filter((b) => b.id !== 'execution').map((b) => b.height));
  assert.ok(execution.height > shortest * 3, 'the execution band must cover every milestone row');
  assert.equal(execution.y + execution.height, chart.ladderBottom, 'it must reach the foot of the ladder');
});

// --- the arrows, which are the drawing ------------------------------------------------------------

test('chart: every feature gets a ribbon, including one with no milestones at all', () => {
  // #780, correcting itself: "every workstream gets an arrow, including the ones with no
  // milestones. Progress through the stages is progress, and it is drawn as such."
  const { chart } = draw([
    entry('Designer', { stage: 'designing', milestones: [] }),
    entry('Fresh', { stage: 'not-started', milestones: [] }),
  ]);

  for (const lane of chart.lanes) {
    assert.ok(lane.solid.segments.length > 0, `${lane.codename} has no ribbon body`);
    assert.ok(lane.solid.head.d, `${lane.codename} has no arrowhead`);
    assert.ok(bottomOf(lane.solid) > CHART.headerHeight, `${lane.codename}'s ribbon has no length`);
  }

  // And they end at different rows, because they have reached different rows.
  const [designing, fresh] = chart.lanes;
  assert.ok(
    headTipY(designing.solid.head) > headTipY(fresh.solid.head),
    'a feature in design must reach further down the ladder than one that has not started',
  );
});

test('chart: an arrowhead grows straight out of its own body, with no gap between them', () => {
  // #780: "an arrowhead always grows straight out of the ribbon it belongs to. Nothing floats and
  // there is never a gap between body and head." The failure this rules out is the M1 page's, where
  // the head was a glyph in a neighbouring cell.
  const { chart } = draw([
    entry('Keystone', {
      stage: 'planned',
      milestones: [1, 2, 3].map((depth) =>
        milestone({ id: `M${depth}`, label: `M${depth}`, depth, status: 'blocked', plan: `m${depth}-plan.md` }),
      ),
    }),
    entry('Tide', {
      stage: 'shipping',
      milestones: [
        milestone({ id: 'M1', label: 'M1', depth: 1, status: 'done' }),
        milestone({ id: 'M2', label: 'M2', depth: 2, status: 'next', plan: 'm2-plan.md' }),
      ],
    }),
  ]);

  for (const lane of chart.lanes) {
    for (const arrow of [lane.solid, lane.faint].filter(Boolean)) {
      assert.equal(
        headBaseY(arrow.head),
        bottomOf(arrow),
        `${lane.codename}: the head's base and the body's end must be the same line`,
      );
      assert.ok(headTipY(arrow.head) > headBaseY(arrow.head), `${lane.codename}: the head points nowhere`);
    }
  }
});

test('chart: the faint arrow spans the whole recorded length and the solid one is laid OVER it', () => {
  // INVERTED FROM M2.1, deliberately rather than deleted, so the correction is visible in the
  // suite. That version was called "where records remain, a second fainter and narrower arrow
  // covers the rest" and asserted the two arrows TILED — the solid one stopping and the faint one
  // beginning below it, with `assert.ok(faint.segments[0].y > headTipY(solid.head), 'the two
  // arrows overlap')` as its guard.
  //
  // #780 corrects that outright: "the faint arrow runs the whole recorded span, and the solid
  // arrow overlays it as far as the work has actually reached ... they are one object seen twice,
  // not two objects in sequence." So the guard that used to forbid an overlap now REQUIRES one.
  //
  // The reference case is the one #780 names: Keystone, six recorded milestones and nothing
  // started — a faint arrow the full six with the solid one over the stages on top of it.
  const { ladder, chart } = draw([
    entry('Keystone', {
      stage: 'planned',
      milestones: [1, 2, 3, 4, 5, 6].map((depth) =>
        milestone({ id: `M${depth}`, label: `M${depth}`, depth, status: 'blocked', plan: `m${depth}-plan.md` }),
      ),
    }),
  ]);

  const lane = laneOf(chart, 'Keystone');
  const rowY = (id) => chart.rows.find((r) => r.id === id).y;

  assert.ok(lane.faint, 'six milestones are on record past the bar, and no second arrow was drawn');
  assert.ok(lane.faint.width < lane.solid.width, 'the faint arrow must be the narrower of the two');

  // The solid one ends inside the Planned row.
  const planned = chart.rows.find((r) => r.id === 'planned');
  assert.ok(headTipY(lane.solid.head) > planned.y, 'the solid arrow stops short of Planned');
  assert.ok(headTipY(lane.solid.head) <= planned.y + planned.height, 'the solid arrow runs past Planned');

  // THE CORRECTION. The faint arrow begins at the very top of the ladder, exactly where the solid
  // one begins — not below it — and runs to the end of the records. The solid arrow is therefore
  // laid entirely over it.
  assert.equal(
    lane.faint.segments[0].y,
    lane.solid.segments[0].y,
    'the faint arrow does not start where the solid one does — they are tiled, not overlaid',
  );
  assert.ok(
    headTipY(lane.faint.head) > headTipY(lane.solid.head),
    'the faint arrow must reach past the solid one, which is the whole of it being seen twice',
  );
  // And the solid one has to cover the faint body where the two coincide, or the overlay reads as
  // a faint stripe running down the middle of a solid arrow. Width alone is not enough: the head
  // flares wider than its body, so the SOLID head's flare must clear the FAINT body's edge too.
  assert.ok(lane.faint.width < lane.solid.width, 'the faint arrow must be the narrower of the two');
  const halfWidthOf = (head) => {
    const numbers = head.d.match(/-?\d+(\.\d+)?/g).map(Number);
    const xs = numbers.filter((_, i) => i % 2 === 0);
    return (Math.max(...xs) - Math.min(...xs)) / 2;
  };
  assert.ok(
    halfWidthOf(lane.solid.head) >= lane.faint.width / 2,
    'the solid head is narrower than the faint body behind it, so the faint one shows either side',
  );

  const sixth = chart.rows.find((r) => r.id === 'depth-6');
  assert.ok(headTipY(lane.faint.head) > sixth.y, 'the faint reach stops short of the sixth milestone');
  assert.ok(headTipY(lane.faint.head) <= sixth.y + sixth.height, 'the faint reach runs past the records');
  assert.equal(ladder.columns[0].recordedTo, 'depth-6');
  assert.ok(rowY('depth-1') > planned.y, 'the ladder is out of order');
});

test('chart: one object, so the faint arrow leaves its lane at the same milestones the solid one does', () => {
  // The faint arrow is not a second mark that happens to sit behind the first; #780 says the two
  // are ONE OBJECT seen twice. Where the work went round a milestone, the object went round it —
  // once. Without this, a straight faint band shows through the gap the solid ribbon's detour
  // leaves, and the crossed marker sits on top of a bar rather than beside a break.
  const { chart } = draw([
    entry('Reef', {
      stage: 'shipping',
      milestones: [
        milestone({ id: 'M1', label: 'M1', depth: 1, status: 'done' }),
        milestone({ id: 'M2', label: 'M2', depth: 2, status: 'parked', issue: 709, plan: 'm2-plan.md' }),
        milestone({ id: 'M3', label: 'M3', depth: 3, status: 'done', plan: 'm3-plan.md' }),
        milestone({ id: 'M4', label: 'M4', depth: 4, status: 'blocked', plan: 'm4-plan.md' }),
        milestone({ id: 'M5', label: 'M5', depth: 5, status: 'blocked', plan: 'm5-plan.md' }),
      ],
    }),
  ]);

  const lane = laneOf(chart, 'Reef');
  assert.ok(lane.faint, 'M4 and M5 are on record past the work, and no faint reach was drawn');
  assert.equal(lane.skips.length, 1, 'the fixture for this test no longer exercises a detour');

  const skipRow = chart.rows.find((r) => r.id === 'depth-2');
  const covers = (arrow, y) => arrow.segments.some((s) => y > s.y && y < s.y + s.height);
  const midSkip = skipRow.y + Math.round(skipRow.height / 2);
  assert.ok(!covers(lane.solid, midSkip), 'the solid ribbon runs straight through the milestone it went round');
  assert.ok(!covers(lane.faint, midSkip), 'the faint arrow runs straight through the detour the solid one takes');
});

test('chart: a feature with nothing recorded beyond its position has one arrow only', () => {
  const { chart } = draw([
    entry('Anchor', {
      stage: 'shipping',
      milestones: [1, 2].map((depth) =>
        milestone({ id: `M${depth}`, label: `M${depth}`, depth, status: 'done', plan: `m${depth}-plan.md` }),
      ),
    }),
  ]);

  assert.equal(laneOf(chart, 'Anchor').faint, null, 'a second arrow was drawn over nothing');
});

test('chart: nothing is drawn below the last arrowhead, whatever the statuses down there say', () => {
  // #780, correcting itself against a real case: "the rule is positional, not status-based."
  // Six blocked milestones are ONE faint reach, not six marks.
  const { chart } = draw([
    entry('Keystone', {
      stage: 'planned',
      milestones: [1, 2, 3, 4, 5, 6].map((depth) =>
        milestone({ id: `M${depth}`, label: `M${depth}`, depth, status: 'blocked', plan: `m${depth}-plan.md` }),
      ),
    }),
  ]);

  const lane = laneOf(chart, 'Keystone');
  assert.deepEqual(lane.dots, [], 'a blocked milestone below the head put a mark in the feature’s own lane');
  assert.deepEqual(lane.skips, [], 'nothing was skipped here — nothing has started');
});

// --- the skipped milestone -------------------------------------------------------------------------

test('chart: the ribbon leaves its lane round a skipped milestone and rejoins below it', () => {
  const { chart } = draw([
    entry('Reef', {
      stage: 'shipping',
      milestones: [
        milestone({ id: 'M1', label: 'M1', depth: 1, status: 'done' }),
        milestone({ id: 'M2', label: 'M2', depth: 2, status: 'parked', issue: 709, plan: 'm2-plan.md' }),
        milestone({ id: 'M3', label: 'M3', depth: 3, status: 'done', plan: 'm3-plan.md' }),
      ],
    }),
  ]);

  const lane = laneOf(chart, 'Reef');
  const skipRow = chart.rows.find((r) => r.id === 'depth-2');

  assert.equal(lane.skips.length, 1, 'the milestone the work went round was not marked');
  assert.equal(lane.skips[0].id, 'M2');
  // The caption does NOT name the milestone: the marker sits on that milestone's own row, and
  // #780 puts the identifiers in the ladder column and nowhere else. The id stays on the object,
  // for the drawing to place the marker by.
  assert.equal(lane.skips[0].label, 'Skipped');
  assert.match(lane.skips[0].reason, /#709/, 'the marker must carry the issue the reason is recorded at');
  assert.match(lane.skips[0].reason, /parked/);

  // The bar carries on to the real edge of finished work, past the marker.
  assert.ok(headTipY(lane.solid.head) > skipRow.y + skipRow.height, 'the bar stopped at the skip');

  // And it leaves the lane rather than being painted over: the body has a hole at that row, and a
  // curve bridges it.
  assert.equal(lane.solid.detours.length, 1, 'no detour was drawn around the marker');
  const coversSkip = lane.solid.segments.some(
    (s) => s.y < skipRow.centre && s.y + s.height > skipRow.centre,
  );
  assert.equal(coversSkip, false, 'the solid body runs straight through the marker instead of round it');
});

test('chart: the detour stays inside its own column, so it cannot reach a neighbour', () => {
  const { chart } = draw([
    entry('Reef', {
      stage: 'shipping',
      milestones: [
        milestone({ id: 'M1', label: 'M1', depth: 1, status: 'done' }),
        milestone({ id: 'M2', label: 'M2', depth: 2, status: 'parked', plan: 'm2-plan.md' }),
        milestone({ id: 'M3', label: 'M3', depth: 3, status: 'done', plan: 'm3-plan.md' }),
      ],
    }),
  ]);

  const lane = laneOf(chart, 'Reef');
  const xs = lane.solid.detours[0]
    .match(/-?\d+(\.\d+)?/g)
    .map(Number)
    .filter((_, i) => i % 2 === 0);

  assert.ok(Math.min(...xs) >= 0, 'the detour left the column on the left');
  assert.ok(Math.max(...xs) <= CHART.columnPitch, 'the detour left the column on the right');
});

// --- the dots and the dates --------------------------------------------------------------------------

test('chart: a closed milestone shows both stored days and how long it took', () => {
  const { chart } = draw([
    entry('Tide', {
      stage: 'shipping',
      milestones: [
        milestone({
          id: 'M1',
          label: 'M1',
          depth: 1,
          status: 'done',
          started: '2026-03-02',
          completed: '2026-03-05',
        }),
      ],
    }),
  ]);

  const [dot] = laneOf(chart, 'Tide').dots;
  const text = dot.lines.map((l) => l.text).join(' | ');
  // Both ends are stated; the YEAR is stated once, because both fall in it. See
  // `formatDayRange` — the span is what has to be actionable, and it is.
  assert.match(text, /2 Mar\b/, 'the start day is missing');
  assert.match(text, /5 Mar 2026/, 'the close day is missing');
  assert.match(text, /\b2026\b/, 'the span carries no year at all');
  assert.match(text, /3 days/, 'how long it took is missing');
});

test('chart: the milestone in flight shows its start day and no duration', () => {
  // #780 settled this precisely, and the reason is the byte-identical guarantee: a days-open
  // figure would be derived from today, and every rebuild would then differ from the last.
  const { chart } = draw([
    entry('Tide', {
      stage: 'shipping',
      milestones: [
        milestone({ id: 'M1', label: 'M1', depth: 1, status: 'done', started: '2026-03-02', completed: '2026-03-05' }),
        milestone({ id: 'M2', label: 'M2', depth: 2, status: 'next', started: '2026-03-06', plan: 'm2-plan.md' }),
      ],
    }),
  ]);

  const live = laneOf(chart, 'Tide').dots.find((d) => d.tone === 'live');
  assert.ok(live, 'the milestone in flight has no dot to attach anything to');
  const text = live.lines.map((l) => l.text).join(' | ');
  assert.match(text, /6 Mar 2026/);
  assert.ok(!/day/.test(text), 'a duration was shown for a milestone that has not closed');
});

test('chart: a future milestone shows nothing at all, and a project with no dates still draws', () => {
  const { chart } = draw([
    entry('Anchor', {
      stage: 'shipping',
      milestones: [
        milestone({ id: 'M1', label: 'M1', depth: 1, status: 'done' }),
        milestone({ id: 'M2', label: 'M2', depth: 2, status: 'blocked', plan: 'm2-plan.md' }),
      ],
    }),
  ]);

  const lane = laneOf(chart, 'Anchor');
  assert.deepEqual(lane.dots.map((d) => d.id), ['M1'], 'a milestone below the head was given a dot');
  assert.deepEqual(lane.dots[0].lines, [], 'dates were invented for a milestone that records none');
});

// --- the balloons ---------------------------------------------------------------------------------

test('chart: a balloon points at the step it describes, not at the end of the arrow', () => {
  // #780's second correction: Keystone's belongs beside M1, where its arrowhead is — not at the
  // bottom of the faint reach.
  const { chart } = draw([
    entry('Keystone', {
      stage: 'planned',
      milestones: [1, 2, 3, 4, 5, 6].map((depth) =>
        milestone({
          id: `M${depth}`,
          label: `M${depth}`,
          depth,
          status: 'blocked',
          title: depth === 1 ? 'TenantContext contract and library' : `Milestone ${depth}`,
          plan: `m${depth}-plan.md`,
        }),
      ),
    }),
  ]);

  const lane = laneOf(chart, 'Keystone');
  assert.ok(lane.balloon, 'the feature has a next step and no balloon was drawn');

  // It attaches to a dot on the ribbon at the row it describes — the head's row, not the arrow's
  // end, and the balloon itself drops clear of the whole six-milestone reach before speaking.
  const headRow = chart.rows.find((r) => r.id === 'depth-1');
  assert.equal(lane.balloon.dot.y, headRow.centre, 'the balloon attaches at the wrong row');
  assert.ok(lane.balloon.y > lane.arrowBottom, 'the balloon overlaps the arrow it belongs to');
});

test('chart: no next step, no balloon', () => {
  // #780's first correction: "a balloon reading 'nothing is next' is noise."
  const { chart } = draw([
    entry('Anchor', {
      stage: 'shipping',
      milestones: [1, 2].map((depth) =>
        milestone({ id: `M${depth}`, label: `M${depth}`, depth, status: 'done', plan: `m${depth}-plan.md` }),
      ),
    }),
  ]);

  assert.equal(laneOf(chart, 'Anchor').balloon, null, 'a balloon was drawn with nothing to say');
});

test('chart: a feature still in the stages speaks its gate; one in flight says so', () => {
  const { chart } = draw([
    entry('Harbor', { stage: 'designing', milestones: [] }),
    entry('Tide', {
      stage: 'shipping',
      milestones: [
        milestone({ id: 'M1', label: 'M1', depth: 1, status: 'done' }),
        milestone({ id: 'M2', label: 'M2', depth: 2, status: 'next', title: 'Buoy telemetry', plan: 'm2-plan.md' }),
      ],
    }),
  ]);

  const harbor = laneOf(chart, 'Harbor');
  assert.equal(harbor.balloon.kicker, 'Next');
  assert.match(harbor.balloon.lines.map((l) => l.text).join(' '), /Nothing gates Harbor/);

  const tide = laneOf(chart, 'Tide');
  assert.equal(tide.balloon.kicker, 'Happening now', 'a milestone under way must not read as merely next');
  assert.match(tide.balloon.lines.map((l) => l.text).join(' '), /Buoy telemetry/);
});

test('chart: the widest date a lane can print stays clear of the next feature’s balloon', () => {
  // Moving the ribbon onto its name box's centre line (#780) moved the date column right by the
  // same amount, and the widest thing on the chart — a closed milestone's span — then ran out of
  // its own column and under the NEXT feature's balloon, which is painted after it and opaque.
  // Found by looking at the rendered page; no coordinate assertion could have seen it, because the
  // text's width is a font measurement this pure module does not hold.
  //
  // So it is modelled: `textCharWidth` is a declared per-character budget, exactly as
  // `balloonChars` is a declared wrap budget, and the constraint is asserted against it. The
  // balloon in the next column starts at that column's `balloonInset`, which is the real edge the
  // text must not reach.
  const { chart } = draw([
    entry('Reef', {
      stage: 'shipping',
      milestones: [
        milestone({ id: 'M1', label: 'M1', depth: 1, status: 'done', started: '2026-06-11', completed: '2026-06-30' }),
        // A span across a year boundary, which is the widest a date line can honestly get.
        milestone({
          id: 'M2',
          label: 'M2',
          depth: 2,
          status: 'done',
          plan: 'm2-plan.md',
          started: '2026-12-30',
          completed: '2027-01-04',
        }),
      ],
    }),
  ]);

  const lane = laneOf(chart, 'Reef');
  const lines = [
    ...lane.dots.flatMap((dot) => dot.lines.map((line) => line.text)),
    ...lane.skips.flatMap((skip) => [skip.label, skip.reason]),
  ];
  assert.ok(lines.length > 0, 'this test stopped drawing any dates at all');

  const widest = Math.max(...lines.map((text) => text.length)) * CHART.textCharWidth;
  const reaches = lane.textX + widest;
  const nextBalloonStartsAt = CHART.columnPitch + CHART.balloonInset;
  assert.ok(
    reaches <= nextBalloonStartsAt,
    `a date line reaches x=${Math.round(reaches)}, past the next feature's balloon at ${nextBalloonStartsAt}`,
  );
});

test('chart: a balloon never expands into a neighbouring column — it grows downward', () => {
  // #780, from reading it on a phone: "fixed width, tied to the column, growing downward as the
  // text needs. This is what makes the page work at narrow widths at all."
  const short = draw([entry('Short', { stage: 'designing', gate: 'Owner sign-off', milestones: [] })]);
  const long = draw([
    entry('Long', {
      stage: 'designing',
      gate:
        'Owner approval of the authority, then a tier-and-cost decision before anything is deployed, ' +
        'and a second look at the register once that has happened',
      milestones: [],
    }),
  ]);

  const a = laneOf(short.chart, 'Short').balloon;
  const b = laneOf(long.chart, 'Long').balloon;

  assert.equal(a.width, b.width, 'a longer gate made the balloon wider instead of taller');
  assert.ok(b.height > a.height, 'a longer gate did not make the balloon taller');
  assert.ok(b.lines.length > a.lines.length);

  // And the whole thing, tail included, stays inside one column pitch.
  for (const balloon of [a, b]) {
    assert.ok(balloon.x >= 0, 'the balloon starts left of its own column');
    assert.ok(balloon.x + balloon.width <= CHART.columnPitch, 'the balloon runs into the next column');
    const connectorXs = balloon.connector
      .match(/-?\d+(\.\d+)?/g)
      .map(Number)
      .filter((_, i) => i % 2 === 0);
    assert.ok(Math.min(...connectorXs) >= 0 && Math.max(...connectorXs) <= CHART.columnPitch,
      'the connector leaves its own column, so it can cross a neighbour');
  }
});

test('chart: the drawing is tall enough to hold the deepest balloon on it', () => {
  const { chart } = draw([
    entry('Keystone', {
      stage: 'planned',
      milestones: [1, 2, 3, 4, 5, 6].map((depth) =>
        milestone({ id: `M${depth}`, label: `M${depth}`, depth, status: 'blocked', plan: `m${depth}-plan.md` }),
      ),
    }),
  ]);

  for (const lane of chart.lanes) {
    if (!lane.balloon) continue;
    assert.ok(
      lane.balloon.y + lane.balloon.height <= chart.height,
      `${lane.codename}'s balloon is cut off by the foot of the drawing`,
    );
  }
  assert.ok(chart.width >= CHART.ladderWidth + chart.lanes.length * CHART.columnPitch);
});

// --- wrapping, and determinism ------------------------------------------------------------------

test('chart: text wraps to whole words at a fixed budget, and never invents a hyphen', () => {
  assert.deepEqual(wrapText('one two three', 9), ['one two', 'three']);
  assert.deepEqual(wrapText('', 9), []);
  assert.deepEqual(wrapText('   ', 9), []);
  // A word longer than the budget is left over-long: a break Atlas invented inside a milestone
  // title would be Atlas editing a record.
  assert.deepEqual(wrapText('antidisestablishmentarianism', 9), ['antidisestablishmentarianism']);
  assert.ok(wrapText('a '.repeat(400), 10, 3).length === 3, 'the line budget is not enforced');
  assert.match(wrapText('a '.repeat(400), 10, 3)[2], /…$/, 'a truncated balloon does not say so');
});

test('chart: every coordinate is an integer, so two builds cannot differ in a decimal', () => {
  const config = loadConfig(FIXTURE_ROOT);
  const workstreams = resolveWorkstreams(config);
  const ladder = computeLadder(workstreams);
  const chart = computeChart(
    ladder,
    workstreams.map((stream, i) => ({ ...stream, url: `/workstream/${stream.slug}/`, column: ladder.columns[i] })),
  );

  const numbers = [];
  const walk = (value) => {
    if (typeof value === 'number') numbers.push(value);
    else if (typeof value === 'string') {
      for (const match of value.match(/-?\d+\.\d+/g) ?? []) numbers.push(Number(match));
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(chart);

  assert.ok(numbers.length > 100, `expected to walk the whole drawing, saw ${numbers.length} numbers`);
  const fractional = numbers.filter((n) => !Number.isInteger(n));
  assert.deepEqual(fractional, [], 'a fractional coordinate reached the drawing');
});

test('chart: the same input drawn twice produces the identical drawing', () => {
  const config = loadConfig(FIXTURE_ROOT);
  const once = () => {
    const workstreams = resolveWorkstreams(config);
    const ladder = computeLadder(workstreams);
    return computeChart(
      ladder,
      workstreams.map((s, i) => ({ ...s, url: `/workstream/${s.slug}/`, column: ladder.columns[i] })),
    );
  };
  assert.equal(JSON.stringify(once()), JSON.stringify(once()));
});

// --- the fixture, drawn end to end -------------------------------------------------------------

test('chart: the fixture draws every shape the page has to handle', () => {
  const config = loadConfig(FIXTURE_ROOT);
  const workstreams = resolveWorkstreams(config);
  const ladder = computeLadder(workstreams);
  const chart = computeChart(
    ladder,
    workstreams.map((s, i) => ({ ...s, url: `/workstream/${s.slug}/`, column: ladder.columns[i] })),
  );

  const lane = (codename) => laneOf(chart, codename);

  // Records ahead of the work: two arrows.
  assert.ok(lane('Beacon').faint, 'Beacon has M5 and M6 on record and drew no faint reach');
  // The work went round one: a marker, and the bar past it.
  assert.deepEqual(lane('Reef').skips.map((s) => s.id), ['M3']);
  assert.equal(lane('Reef').faint, null, 'nothing is recorded past Reef M5');
  // Nothing next: no balloon.
  assert.equal(lane('Anchor').balloon, null);
  // No milestones at all, and not started at all: still a ribbon each.
  assert.ok(lane('Harbor').solid.segments.length > 0);
  assert.ok(lane('Shoal').solid.segments.length > 0);
  assert.deepEqual(lane('Shoal').dots, []);

  assert.equal(chart.lanes.length, workstreams.length, 'a lane per feature, and no more');
});
