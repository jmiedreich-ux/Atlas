// The depth chart's whole logic (decisions 20, 23, 24, 25): turns validated workstream manifests
// into the ladder, the bars and the arrowheads the desktop planning view draws.
//
// This module is pure — it takes the array `resolveWorkstreams` produces and returns data. No
// file reading, no rendering.

// Decision 23: three pre-milestone stages sit above the first milestone, in this order, because
// that is where most workstreams live.
const PRE_MILESTONE_STAGES = ['not-started', 'designing', 'planned'];
const STAGE_LABELS = {
  'not-started': 'Not started',
  designing: 'Designing',
  planned: 'Planned',
};

// How many of the three pre-milestone rows a workstream's own `stage` has already passed
// through. `not-started` has passed through none of them — it *is* row zero, not a completed
// one. Any of `development`/`staging`/`release` means milestones are the point of interest, so
// all three are behind it.
function preMilestoneCoveredCount(stage) {
  if (stage === 'not-started') return 0;
  const idx = PRE_MILESTONE_STAGES.indexOf(stage);
  if (idx !== -1) return idx + 1; // designing -> 2, planned -> 3
  return 3; // development, staging, or release
}

// The real edge of finished work: the deepest milestone that is `done`, whatever sits above it.
//
// M2.1 INVERTED this (#780). M1 counted the longest CONTIGUOUS run from depth 1, so the first
// milestone that was not `done` stopped the bar dead — the rule was stated here as "a done M3
// behind an un-done M2 does not extend the bar past M1". The owner ruled that wrong for how the
// work actually goes: a milestone that is parked while later ones ship is one the work went
// round, and a column that reports nothing complete while nine milestones are finished is lying
// about the record it exists to render. A skipped milestone is now NOTED — see `skippedBehind` —
// rather than treated as a wall.
function finishedDepth(milestones) {
  return milestones.reduce((deepest, m) => (m.status === 'done' && m.depth > deepest ? m.depth : deepest), 0);
}

// The mirror of `finishedDepth`: the shallowest depth among milestones that are neither `done`
// nor `parked` — the earliest thing genuinely still open. `null` when nothing is open (everything
// on record is finished or was worked around), which is the existing, correct case this function
// does not change.
function earliestOpenDepth(milestones) {
  const open = milestones.filter((m) => m.status !== 'done' && m.status !== 'parked');
  if (open.length === 0) return null;
  return open.reduce((shallowest, m) => (m.depth < shallowest ? m.depth : shallowest), Infinity);
}

// The milestones the work went round: on record, behind the edge of finished work, and not
// finished themselves. Positional, like every other rule on this page — the status is carried as
// the REASON to print beside the marker, never as the test for whether to draw one.
//
// Depth order, not manifest order, because these are drawn at ladder rows.
function skippedBehind(milestones, edge) {
  return milestones
    .filter((m) => m.depth < edge && m.status !== 'done')
    .sort((a, b) => a.depth - b.depth)
    .map((m) => ({
      id: m.id,
      label: m.label,
      depth: m.depth,
      rowId: `depth-${m.depth}`,
      status: m.status,
      issue: m.issue,
    }));
}

// The deepest milestone on record at all. #780: "the arrow runs from the top of the ladder to the
// last milestone that has a record" — no expected-depth field, no owner judgement to state, no
// imagined milestones. A workstream's length is simply how many milestones it has records for.
function deepestRecordedDepth(milestones) {
  return milestones.reduce((deepest, m) => (m.depth > deepest ? m.depth : deepest), 0);
}

function milestoneAtDepth(milestones, depth) {
  return milestones.find((m) => m.depth === depth) ?? null;
}

// Converts a 1-based position in the full row sequence (1-3 are the pre-milestone stages, 4+ are
// numbered depth positions) into that row's id.
function rowIdForSequencePosition(position) {
  if (position <= 3) return PRE_MILESTONE_STAGES[position - 1];
  return `depth-${position - 3}`;
}

function depthOfDepthRowId(rowId) {
  const match = /^depth-(\d+)$/.exec(rowId ?? '');
  return match ? Number(match[1]) : 0;
}

/**
 * Compute the depth chart's ladder, bars and arrowheads (decisions 20, 23, 24, 25).
 *
 * @param {{ slug: string, dir: string, manifestPath: string, manifest: object }[]} workstreams -
 *   the array `resolveWorkstreams` produces.
 * @returns {{
 *   rows: { id: string, kind: 'stage' | 'milestone', label: string, depth: number | null }[],
 *   columns: { codename: string, stage: string, barTo: string | null, headAt: string,
 *     tipLabel: string | null, note: string, completedCount: number, milestoneCount: number,
 *     covered: boolean[], skipped: object[], recordedTo: string | null,
 *     liveAt: string | null }[],
 * }}
 */
export function computeLadder(workstreams) {
  const columns = workstreams.map(({ manifest }) => {
    const { codename, stage, gate, milestones } = manifest;

    // Decision 24: both ends come from the manifest. The bar's length is what's already
    // complete; the head sits one position past it — the one rule this task exists to get
    // right.
    const completedDepth = finishedDepth(milestones);
    const barRows = preMilestoneCoveredCount(stage) + completedDepth;

    // A gap: something shallower than the deepest DONE milestone is neither done nor parked — it
    // was leapfrogged, not worked around (SOP 2b's own case). The head points there instead of
    // one past the deepest done milestone, because that open milestone — not an imagined "next"
    // depth with nothing recorded — is the honest answer to "what's actually next."
    const openDepth = earliestOpenDepth(milestones);
    const gapped = openDepth !== null && openDepth <= completedDepth;

    const headPosition = gapped ? openDepth + preMilestoneCoveredCount(stage) : barRows + 1;

    const barTo = barRows === 0 ? null : rowIdForSequencePosition(barRows);
    const headAt = rowIdForSequencePosition(headPosition);

    let tipLabel;
    if (headPosition <= 3) {
      // Pointing at a pre-milestone stage: that stage's display name genuinely *is* this
      // column's own next state, not a borrowed ladder label — the shared vocabulary and the
      // workstream's own next step coincide here.
      tipLabel = STAGE_LABELS[PRE_MILESTONE_STAGES[headPosition - 1]];
    } else {
      const depth = headPosition - 3;
      const milestone = milestoneAtDepth(milestones, depth);
      // Decision 20 at the level of a single string: the column's own milestone id, never the
      // ladder row's shared number.
      //
      // NULL WHEN NOTHING IS RECORDED THERE, which is #780's second defect on first render. M2.1
      // fell back to `M${depth}` — "the M<n> convention for a milestone not yet on the record" —
      // and that string is an invention: no plan file, no manifest entry, nothing behind it. It
      // reached the phone view, which announced "Next: M5" for a feature with four milestones all
      // done, while the chart correctly drew no balloon for it at all. Two surfaces disagreeing in
      // front of the reader about a milestone that does not exist.
      //
      // The defect was never the label. It was that the two surfaces read this field differently,
      // so the field now says whether there is anything to name, and both read it — the chart to
      // decide whether a balloon exists, the phone view to decide whether to speak. That covers
      // both ways of getting here: a workstream past the last milestone on record, and one
      // approved with nothing written down yet.
      tipLabel = milestone ? milestone.label : null;
    }

    // Decision 24's completion, counted ONCE, here. The phone view (theme/_includes/mobile.njk)
    // draws the same workstream as a track of segments and needs to know which of them are
    // complete; it used to count every `done` milestone anywhere and fill that many segments from
    // the left, which disagreed with this module in both directions. The chart, the phone and
    // state.json now read the same fields, so no surface classifies anything of its own.
    //
    //   completedCount — how many of this workstream's milestones are finished
    //   milestoneCount — how many are on record at all
    //   covered        — one flag per milestone, in the order the manifest lists them, because
    //                    the manifest's order is what a track of segments is drawn in and it is
    //                    not required to match depth order
    //
    // A milestone the bar has passed but which is not itself finished — a parked one the work
    // went round — is NOT covered and is NOT counted: "9 of 10" is the honest reading of nine
    // finished milestones with a tenth parked, and it is what `skipped` below is for.
    const covered = milestones.map((m) => m.status === 'done');

    const recordedDepth = deepestRecordedDepth(milestones);
    const headMilestone = headPosition > 3 ? milestoneAtDepth(milestones, headPosition - 3) : null;

    return {
      codename,
      stage,
      barTo,
      headAt,
      tipLabel,
      note: gate,
      completedCount: covered.filter(Boolean).length,
      milestoneCount: milestones.length,
      covered,

      // --- M2.1, from #780 -----------------------------------------------------------------
      //
      // The milestones the work went round, each carrying the reason and the issue number the
      // page prints beside its marker. Empty for every column with no gap in it.
      skipped: skippedBehind(milestones, completedDepth).filter((s) => !(gapped && s.depth === openDepth)),

      // Where the faint reach ends: the deepest milestone on record, when that is past the bar.
      // `null` means there is nothing recorded beyond where the work has got, and #780 says such
      // a feature has one arrow only. This is the only thing that decides the second arrow's
      // existence — there is no expected-depth field and no guess.
      recordedTo: recordedDepth > completedDepth ? `depth-${recordedDepth}` : null,

      // Where work is actually under way, as against merely next in line. Tied to the head so
      // the solid arrow can never jump a gap: the row is live only when the milestone the head
      // lands on says `next` itself.
      liveAt: headMilestone?.status === 'next' ? headAt : null,
    };
  });

  // Decision 20: the ladder is the union of every workstream's depth, so a six-milestone stream
  // and an eleven-milestone stream coexist and neither imposes its numbering on the other. This
  // is every milestone depth actually on record, PLUS however deep any column's own bar or head
  // needed to reach — the off-by-one rule can require a row past the deepest milestone anyone
  // has recorded, for the head to land beyond a workstream whose last milestone is done.
  const recordedDepths = workstreams.flatMap(({ manifest }) => manifest.milestones.map((m) => m.depth));
  const columnDepths = columns.flatMap((c) => [depthOfDepthRowId(c.barTo), depthOfDepthRowId(c.headAt)]);
  const ladderMaxDepth = Math.max(0, ...recordedDepths, ...columnDepths);

  const rows = [
    ...PRE_MILESTONE_STAGES.map((id) => ({ id, kind: 'stage', label: STAGE_LABELS[id], depth: null })),
    ...Array.from({ length: ladderMaxDepth }, (_, i) => {
      const depth = i + 1;
      return { id: `depth-${depth}`, kind: 'milestone', label: String(depth), depth };
    }),
  ];

  return { rows, columns };
}

/**
 * How much of each milestone's task list the spine (surface 1, expanded — design doc "Surface 1,
 * expanded: the milestone spine") shows.
 *
 *   'none'       — done or parked: a closed milestone's task history is not re-litigated here.
 *   'full'       — the current milestone (status 'next'; at most one per feature).
 *   'full-muted' — the first 'unplanned' milestone AFTER the current one, if any: the "what's
 *                  coming" preview, shown but visually dimmed.
 *   'count'      — anything else with tasks on record: collapses to a task count, not a list.
 *
 * @param {{ status: string }[]} milestones - a manifest's milestones, in depth order.
 * @returns {('full'|'full-muted'|'count'|'none')[]} one entry per milestone, same order.
 */
export function spineDetail(milestones) {
  const currentIndex = milestones.findIndex((m) => m.status === 'next');
  const previewIndex =
    currentIndex === -1
      ? -1
      : milestones.findIndex((m, i) => i > currentIndex && m.status === 'unplanned');

  return milestones.map((m, index) => {
    if (m.status === 'done' || m.status === 'parked') return 'none';
    if (index === currentIndex) return 'full';
    if (index === previewIndex) return 'full-muted';
    return 'count';
  });
}

/**
 * Assert that every column's `barTo` and `headAt` names a row that is actually on the ladder,
 * and fail loudly if one does not (decision 32).
 *
 * `theme/depth.njk` finds each end of a column by scanning `ladder.rows` for the id `computeLadder`
 * named. If an id were ever absent the scan would leave the index at -1, and the column would
 * render with no bar and no arrowhead — a blank column that looks like a workstream that has not
 * started, rather than a build that broke. A template cannot throw, so the invariant is checked
 * here, before anything renders.
 *
 * Nothing a manifest can say reaches this: the ladder's rows are derived from the very depths its
 * columns point at. That is the point — this is the check that catches `computeLadder` itself
 * regressing, in the one place a regression would otherwise be silent.
 *
 * @param {ReturnType<typeof computeLadder>} ladder
 * @param {string[]} [manifestPaths] - the repository-relative path of each column's manifest, in
 *   the same order as `ladder.columns`. Every failure in this generator names the file at fault
 *   repository-relative, and a codename on its own is not a file. Optional, because this module is
 *   pure and a caller that has no paths to give should still be able to check the invariant.
 * @returns {ReturnType<typeof computeLadder>} the same ladder, so this can wrap a call.
 * @throws {Error} naming the manifest, the column, the end, and the id that resolves to nothing.
 */
export function assertLadderResolves(ladder, manifestPaths = []) {
  const rowIds = new Set(ladder.rows.map((row) => row.id));

  const broken = (index, column, end, id) => {
    const where = manifestPaths[index] ? `${manifestPaths[index]}: ` : '';
    return new Error(
      `${where}the depth chart is broken: column "${column.codename}" has ${end} "${id}", ` +
        `which names no row on the ladder (rows: ${[...rowIds].join(', ')})`,
    );
  };

  ladder.columns.forEach((column, index) => {
    // A null barTo is a column with nothing complete yet — the pre-milestone case, not a break.
    if (column.barTo !== null && !rowIds.has(column.barTo)) {
      throw broken(index, column, 'barTo', column.barTo);
    }
    if (!rowIds.has(column.headAt)) {
      throw broken(index, column, 'headAt', column.headAt);
    }
  });

  return ladder;
}
