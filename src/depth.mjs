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
// one. `shipping` means milestones are the point of interest, so all three are behind it.
function preMilestoneCoveredCount(stage) {
  if (stage === 'not-started') return 0;
  const idx = PRE_MILESTONE_STAGES.indexOf(stage);
  if (idx !== -1) return idx + 1; // designing -> 2, planned -> 3
  return 3; // shipping
}

// The longest contiguous run of `done` milestones starting at depth 1. "The bar covers every
// stage completed" (decision 24) means completion in order, not merely "some milestone somewhere
// is done" — a done M3 behind an un-done M2 does not extend the bar past M1.
function doneCompletedPrefix(milestones) {
  const statusByDepth = new Map(milestones.map((m) => [m.depth, m.status]));
  let depth = 1;
  while (statusByDepth.get(depth) === 'done') depth += 1;
  return depth - 1;
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
 *     tipLabel: string, note: string, completedCount: number, milestoneCount: number,
 *     covered: boolean[] }[],
 * }}
 */
export function computeLadder(workstreams) {
  const columns = workstreams.map(({ manifest }) => {
    const { codename, stage, gate, milestones } = manifest;

    // Decision 24: both ends come from the manifest. The bar's length is what's already
    // complete; the head sits one position past it — the one rule this task exists to get
    // right.
    const completedDepth = doneCompletedPrefix(milestones);
    const barRows = preMilestoneCoveredCount(stage) + completedDepth;
    const headPosition = barRows + 1;

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
      // Decision 20 at the level of a single string: never the ladder row's generic number.
      // When no milestone is recorded yet at this depth — the workstream is `planned` with
      // nothing written down yet, or every recorded milestone is already done and the head has
      // moved past the last one on record — fall back to the `M<n>` convention decision 18
      // fixes for a milestone not yet on the record, rather than the row's bare depth number.
      tipLabel = milestone ? milestone.label : `M${depth}`;
    }

    // Decision 24's completion, counted ONCE, here. The phone view (theme/_includes/mobile.njk)
    // draws the same workstream as a track of segments and needs to know which of them are
    // complete; it used to count every `done` milestone anywhere and fill that many segments from
    // the left, which disagreed with this module in both directions — a done M2 behind an un-done
    // M1 filled M1 and left M2 empty, while the bar here correctly drew nothing. The chart and the
    // phone now read the same three fields, so neither surface classifies anything of its own.
    //
    //   completedCount — how many of this workstream's milestones the bar covers
    //   milestoneCount — how many are on record at all
    //   covered        — one flag per milestone, in the order the manifest lists them, because
    //                    the manifest's order is what a track of segments is drawn in and it is
    //                    not required to match depth order
    const covered = milestones.map((m) => m.depth >= 1 && m.depth <= completedDepth);

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
 * @returns {ReturnType<typeof computeLadder>} the same ladder, so this can wrap a call.
 * @throws {Error} naming the column, the end, and the id that resolves to nothing.
 */
export function assertLadderResolves(ladder) {
  const rowIds = new Set(ladder.rows.map((row) => row.id));

  for (const column of ladder.columns) {
    // A null barTo is a column with nothing complete yet — the pre-milestone case, not a break.
    if (column.barTo !== null && !rowIds.has(column.barTo)) {
      throw new Error(
        `the depth chart is broken: column "${column.codename}" has barTo "${column.barTo}", ` +
          `which names no row on the ladder (rows: ${[...rowIds].join(', ')})`,
      );
    }
    if (!rowIds.has(column.headAt)) {
      throw new Error(
        `the depth chart is broken: column "${column.codename}" has headAt "${column.headAt}", ` +
          `which names no row on the ladder (rows: ${[...rowIds].join(', ')})`,
      );
    }
  }

  return ladder;
}
