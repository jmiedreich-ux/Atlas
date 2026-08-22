// The feature planning chart, drawn (#780).
//
// M1 built this page as an HTML table — features as columns, ladder rows as `<tr>`, every
// intersection a `<td>` — and every visual complaint in #780 followed from that. Cells want
// borders and labels and equal weight, so the arrow became a glyph in a box, finished work became
// a fill with the word "Passed" in it, and future work needed something in it because a cell looks
// broken empty. The owner's framing, and it sits above everything else on the list: it is not a
// chart and they are not grid cells.
//
// So this module computes the DRAWING: one ribbon per feature descending a shared ladder, as
// coordinates and path data. The template interpolates what is here and positions nothing of its
// own — which is the same rule `theme/_includes/depth.njk` already followed for the ladder, applied
// to the whole picture. A layout that computes a position is a layout no test without a browser
// can check.
//
// It is pure: manifests and a ladder in, numbers out. No file reading, no clock, no rendering.
// Every coordinate is an integer, so two builds of one input are byte-identical.
//
// THE CONSTRUCTION #780 SETTLED, because the geometry below is meaningless without it:
//
//   * One continuous ribbon per feature, from the top of the ladder through the stages and on
//     into the milestones. EVERY feature has one, including those with no milestones at all —
//     progress through the stages is progress, and it is drawn as such.
//   * A SOLID arrow covers what has begun: finished work in one colour, the milestone actually in
//     flight in another. Where records exist beyond it, a SECOND, FAINTER, slightly narrower
//     arrow covers the remainder. The two are one object drawn in two weights, and they tile the
//     ladder without overlapping.
//   * Each arrow ends in its own head, growing straight out of its own body. Nothing floats and
//     there is never a gap between body and head.
//   * The arrow's length is the last milestone that has a RECORD. Nothing beyond it — no expected
//     depth, no imagined milestones, nothing below the final arrowhead whatever its status.
//   * A skipped milestone is noted, not treated as a wall: the ribbon leaves its lane, curves
//     around a crossed marker in that milestone's row, and rejoins below it.
//
// LANE COORDINATES ARE RELATIVE. Everything inside a lane is drawn about that lane's own origin,
// and the lane is placed with a single `translate`. That is what lets the reordering in
// `theme/order.js` move a whole feature — ribbon, dots, dates, skip markers and balloon together —
// by rewriting one number, with no geometry on the client at all.

import { daysBetween, formatDay, formatDuration } from './dates.mjs';

// Every measurement the page is built from, in one place and in user units. Frozen because a
// caller adjusting one of these at runtime would move half a drawing and not the other half.
export const CHART = Object.freeze({
  rowHeight: 52,
  headerHeight: 62,
  ladderWidth: 104,
  columnPitch: 240,
  rightMargin: 16,

  // Within a lane, measured from the lane's own origin.
  ribbonCentre: 36,
  ribbonWidth: 36,
  faintWidth: 28,
  headLength: 30,
  faintHeadLength: 26,
  textX: 62,

  // A ribbon stops short of its row's boundary so the light rule beneath it stays visible either
  // side of the head, rather than being buried under a solid block.
  topInset: 8,
  bottomInset: 8,

  balloonInset: 12,
  balloonWidth: 208,
  balloonRadius: 14,
  balloonTailRise: 26,
  balloonLine: 15,
  balloonPad: 14,
  balloonChars: 28,
  balloonMaxLines: 5,

  dotRadius: 7,
  skipRadius: 12,
  detourReach: 28,
});

// --- small pure helpers --------------------------------------------------------------------------

function rowIndexOf(rows, id) {
  return rows.findIndex((row) => row.id === id);
}

function rowTop(index) {
  return CHART.headerHeight + index * CHART.rowHeight;
}

/**
 * Greedy word wrap to a character budget.
 *
 * Characters rather than measured text, because there is no browser here to measure in and a
 * measurement taken from one would not survive the reader's own font settings anyway. The budget
 * is set against the column, and #780 is explicit that a balloon grows DOWNWARD as the text needs
 * rather than sideways — that is what makes the page work at narrow widths at all.
 *
 * A word longer than the budget is left over-long rather than broken: a hyphen Atlas invented
 * inside a milestone title would be Atlas editing a record.
 */
export function wrapText(text, maxChars = CHART.balloonChars, maxLines = CHART.balloonMaxLines) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars || current === '') {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);

  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = `${kept[maxLines - 1].slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
  return kept;
}

/**
 * A vertical run of ribbon, split wherever the work went round a milestone.
 *
 * The detour rows are removed from the run rather than drawn over: a solid block with a curve
 * painted on top still reads as an unbroken bar, and #780 wants the ribbon to visibly leave its
 * lane and rejoin below.
 */
function splitAroundDetours(top, bottom, detourRows) {
  const gaps = detourRows
    .map((index) => ({ from: rowTop(index) + 6, to: rowTop(index) + CHART.rowHeight - 6 }))
    .filter((gap) => gap.to > top && gap.from < bottom)
    .sort((a, b) => a.from - b.from);

  const runs = [];
  let cursor = top;
  for (const gap of gaps) {
    if (gap.from > cursor) runs.push({ y: cursor, height: gap.from - cursor });
    cursor = Math.max(cursor, gap.to);
  }
  if (bottom > cursor) runs.push({ y: cursor, height: bottom - cursor });
  return runs.filter((run) => run.height > 0);
}

// An arrowhead as a path, growing straight out of the body that ends at `y`. The base is wider
// than the body it grows from — that flare is what makes it read as a head rather than as the
// bar simply stopping — and the two share an edge, so nothing floats.
function headPath(centre, width, y, length) {
  const flare = Math.round(width * 0.42);
  const left = centre - Math.round(width / 2) - flare;
  const right = centre + Math.round(width / 2) + flare;
  // Explicit `L x y` rather than the shorter `H x`: every command here takes a full coordinate
  // pair, so the path can be read back as points. A test with no browser can then assert that the
  // head's base and the body's end are the same line — which is the whole of #780's "nothing
  // floats" — instead of trusting the arithmetic that produced it.
  return `M ${left} ${y} L ${right} ${y} L ${centre} ${y + length} Z`;
}

// The ribbon curving out of its lane, round a marker, and back in. One cubic out and one back, so
// the two halves meet at the marker's own height with a continuous tangent.
function detourPath(centre, index) {
  const from = rowTop(index) + 6;
  const to = rowTop(index) + CHART.rowHeight - 6;
  const out = centre - CHART.detourReach;
  const middle = Math.round((from + to) / 2);
  return (
    `M ${centre} ${from} C ${out} ${from + 8} ${out} ${middle - 6} ${out} ${middle} ` +
    `C ${out} ${middle + 6} ${out} ${to - 8} ${centre} ${to}`
  );
}

// A crossed circular marker: the milestone the work went round.
function skipCross(centre, y, r) {
  const arm = Math.round(r * 0.58);
  return [
    `M ${centre - arm} ${y - arm} L ${centre + arm} ${y + arm}`,
    `M ${centre + arm} ${y - arm} L ${centre - arm} ${y + arm}`,
  ].join(' ');
}

/**
 * The balloon body and its tail as ONE path.
 *
 * #780: "a rounded rectangle with a triangle is the boring answer" — it should read as an actual
 * speech balloon. Drawing body and tail as one filled path is also what keeps them from ever
 * showing a seam where a separate triangle would meet the edge it is supposed to grow out of.
 */
function balloonPath(x, y, w, h, tailX) {
  const r = CHART.balloonRadius;
  const rise = CHART.balloonTailRise;
  return [
    `M ${x + r} ${y}`,
    `H ${tailX - 13}`,
    // Out and up in one sweep, then back down in a tighter one, so the tail is a curved horn
    // rather than a wedge.
    `C ${tailX - 11} ${y - 5} ${tailX - 7} ${y - 16} ${tailX} ${y - rise}`,
    `C ${tailX - 1} ${y - 13} ${tailX + 6} ${y - 3} ${tailX + 15} ${y}`,
    `H ${x + w - r}`,
    `A ${r} ${r} 0 0 1 ${x + w} ${y + r}`,
    `V ${y + h - r}`,
    `A ${r} ${r} 0 0 1 ${x + w - r} ${y + h}`,
    `H ${x + r}`,
    `A ${r} ${r} 0 0 1 ${x} ${y + h - r}`,
    `V ${y + r}`,
    `A ${r} ${r} 0 0 1 ${x + r} ${y}`,
    'Z',
  ].join(' ');
}

// The line from the dot on the ribbon to the tail's tip.
//
// #780, corrected twice: it leaves the dot sideways, steps into a lane just clear of its OWN
// ribbon, travels vertically WITHIN that column, and turns in. Nothing lateral, so it cannot
// reach a neighbouring feature at all — which is what the earlier gutter routing did.
function connectorPath(fromX, fromY, laneX, toY) {
  return `M ${fromX} ${fromY} L ${laneX - 8} ${fromY} Q ${laneX} ${fromY} ${laneX} ${fromY + 8} L ${laneX} ${toY}`;
}

// --- the dates beside a dot -----------------------------------------------------------------------

// #780: a CLOSED milestone shows its start and close days and how long it took — all three from
// stored facts. One in flight shows its start day only. A future one shows nothing, which is why
// this is only ever called for a milestone that is finished or under way.
function dateLines(milestone, live) {
  const { started, completed } = milestone;
  if (live) {
    return started
      ? [{ text: formatDay(started), strong: true }, { text: 'in progress' }]
      : [{ text: 'in progress' }];
  }
  if (started && completed) {
    return [
      { text: `${formatDay(started)} → ${formatDay(completed)}`, strong: true },
      { text: formatDuration(daysBetween(started, completed)) },
    ];
  }
  if (started) return [{ text: formatDay(started), strong: true }];
  // A project that has not filled the dates in yet still gets its dot; it simply says nothing.
  return [];
}

// --- one feature's lane ----------------------------------------------------------------------------

function buildLane(stream, rows) {
  const column = stream.column;
  const centre = CHART.ribbonCentre;
  const milestones = stream.manifest.milestones;

  const barIndex = column.barTo === null ? -1 : rowIndexOf(rows, column.barTo);
  const liveIndex = column.liveAt === null ? -1 : rowIndexOf(rows, column.liveAt);
  const headIndex = rowIndexOf(rows, column.headAt);
  const recordedIndex = column.recordedTo === null ? -1 : rowIndexOf(rows, column.recordedTo);

  // Where the SOLID arrow ends. The live row is part of it — work that has begun is drawn as
  // begun — so a feature whose current milestone is under way reads as further along than one
  // whose current milestone is merely next in line, without a third arrow to say so.
  //
  // A feature that has completed nothing still gets a ribbon: it covers the one row it has
  // reached. #780 is explicit that every feature has one.
  const solidEndIndex = Math.max(liveIndex, barIndex, 0);

  const top = rowTop(0) + CHART.topInset;
  const solidBottom = rowTop(solidEndIndex) + CHART.rowHeight - CHART.bottomInset;
  const solidHeadTop = solidBottom - CHART.headLength;

  const detourRows = column.skipped.map((skip) => rowIndexOf(rows, skip.rowId)).filter((i) => i >= 0);

  // The body's two tones. `live` starts where the live row does, so the boundary lands on a
  // ladder rule rather than at an invented height.
  const liveTop = liveIndex >= 0 ? rowTop(liveIndex) : solidHeadTop;
  const segments = [
    ...splitAroundDetours(top, Math.min(liveTop, solidHeadTop), detourRows).map((run) => ({
      ...run,
      tone: 'done',
    })),
    ...(liveIndex >= 0 && solidHeadTop > liveTop
      ? [{ y: liveTop, height: solidHeadTop - liveTop, tone: 'live' }]
      : []),
  ];

  const solidTone = liveIndex >= 0 ? 'live' : 'done';
  const solid = {
    segments,
    detours: detourRows.map((index) => detourPath(centre, index)),
    head: { d: headPath(centre, CHART.ribbonWidth, solidHeadTop, CHART.headLength), tone: solidTone },
    width: CHART.ribbonWidth,
  };

  // The faint reach: everything on record past where the work has got. Its own arrow, its own
  // head, slightly narrower, so the two read as related but distinct — and absent entirely when
  // there is nothing recorded beyond, because a feature with no records ahead has one arrow only.
  let faint = null;
  if (recordedIndex > solidEndIndex) {
    const faintTop = solidBottom + 10;
    const faintBottom = rowTop(recordedIndex) + CHART.rowHeight - CHART.bottomInset;
    const faintHeadTop = faintBottom - CHART.faintHeadLength;
    faint = {
      segments: [{ y: faintTop, height: faintHeadTop - faintTop, tone: 'ahead' }],
      head: { d: headPath(centre, CHART.faintWidth, faintHeadTop, CHART.faintHeadLength), tone: 'ahead' },
      width: CHART.faintWidth,
    };
  }

  const arrowBottom = faint
    ? rowTop(recordedIndex) + CHART.rowHeight - CHART.bottomInset
    : solidBottom;

  // A dot per milestone the ribbon actually covers, with its dates beside it. Nothing below the
  // arrowhead, whatever its status — the rule is positional (#780), so this is decided by where
  // the milestone sits, never by what it says.
  const skippedIds = new Set(column.skipped.map((skip) => skip.id));
  const dots = milestones
    .filter((m) => !skippedIds.has(m.id))
    .map((m) => ({ m, index: rowIndexOf(rows, `depth-${m.depth}`) }))
    .filter(({ m, index }) => index >= 0 && (m.status === 'done' || index === liveIndex))
    .sort((a, b) => a.index - b.index)
    .map(({ m, index }) => ({
      id: m.id,
      y: rowTop(index) + Math.round(CHART.rowHeight / 2),
      tone: index === liveIndex ? 'live' : 'done',
      hollow: index === liveIndex,
      lines: dateLines(m, index === liveIndex),
    }));

  const skips = column.skipped
    .map((skip) => ({ skip, index: rowIndexOf(rows, skip.rowId) }))
    .filter(({ index }) => index >= 0)
    .map(({ skip, index }) => {
      const y = rowTop(index) + Math.round(CHART.rowHeight / 2);
      return {
        id: skip.id,
        y,
        cross: skipCross(centre, y, CHART.skipRadius),
        label: `${skip.label} skipped`,
        reason: skip.issue ? `#${skip.issue} · ${skip.status}` : skip.status,
      };
    });

  return {
    slug: stream.slug,
    codename: column.codename,
    stage: column.stage,
    url: stream.url,
    centre,
    solid,
    faint,
    dots,
    skips,
    balloon: buildBalloon(stream, rows, { headIndex, liveIndex, arrowBottom, centre }),
    arrowBottom,
  };
}

// --- the balloon ------------------------------------------------------------------------------------

// #780, after three corrections: a balloon points at the STEP IT DESCRIBES rather than at the end
// of the arrow; if nothing is next there is no balloon at all, because one reading "nothing is
// next" is noise; and each is placed for its own feature rather than by one rule across the page,
// which produced worse results.
function buildBalloon(stream, rows, { headIndex, liveIndex, arrowBottom, centre }) {
  const column = stream.column;
  const headRow = rows[headIndex];
  if (!headRow) return null;

  let text;
  let kicker;
  if (headRow.kind === 'stage') {
    // Still in the stages: what is next is the thing the owner is holding, which is the gate.
    text = stream.manifest.gate;
    kicker = 'Next';
  } else {
    const milestone = stream.manifest.milestones.find((m) => m.depth === headRow.depth);
    // Nothing recorded at the head's own row: the feature has run past its records, and there is
    // genuinely nothing to say. No balloon.
    if (!milestone) return null;
    text = milestone.title;
    kicker = headIndex === liveIndex ? 'Happening now' : 'Next';
  }
  if (!text) return null;

  const lines = wrapText(text);
  if (lines.length === 0) return null;

  const x = CHART.balloonInset;
  const width = CHART.balloonWidth;
  const tailX = centre + 30;
  const headCentre = rowTop(headIndex) + Math.round(CHART.rowHeight / 2);

  // Below this feature's own arrow, clear of the head it points at. Per feature, by #780's own
  // ruling — there is deliberately no cross-column placement pass.
  const y = Math.max(arrowBottom + 34, headCentre + 74);
  const height = CHART.balloonPad * 2 + 14 + lines.length * CHART.balloonLine;

  return {
    kicker,
    tone: headIndex === liveIndex ? 'live' : 'next',
    x,
    y,
    width,
    height,
    path: balloonPath(x, y, width, height, tailX),
    connector: connectorPath(centre + Math.round(CHART.ribbonWidth / 2), headCentre, tailX, y - CHART.balloonTailRise),
    dot: { x: centre + Math.round(CHART.ribbonWidth / 2), y: headCentre },
    textX: x + CHART.balloonPad,
    kickerY: y + CHART.balloonPad + 8,
    lines: lines.map((line, i) => ({ text: line, y: y + CHART.balloonPad + 14 + (i + 1) * CHART.balloonLine - 4 })),
  };
}

// --- the whole drawing -------------------------------------------------------------------------------

/**
 * Turn the ladder and the features into the coordinates and paths the page draws.
 *
 * @param {{ rows: object[], columns: object[] }} ladder - exactly what `computeLadder` returned.
 * @param {object[]} workstreams - the features the build assembled, each carrying its own
 *   `column` (its entry from `computeLadder`), its `manifest`, its `slug` and its `url`.
 * @returns {object} a plain, JSON-serialisable drawing. Every number is an integer.
 */
export function computeChart(ladder, workstreams) {
  const rows = ladder.rows.map((row, index) => ({
    id: row.id,
    kind: row.kind,
    depth: row.depth,
    // Decision 20: the ladder's rows are numbered positions, and #780 puts the milestone
    // identifiers HERE and nowhere else — never inside a feature's own lane. Decision 19 spells
    // the M out, because a bare number in a column of them reads as a count.
    caption: row.kind === 'stage' ? row.label : `M${row.label}`,
    y: rowTop(index),
    height: CHART.rowHeight,
    centre: rowTop(index) + Math.round(CHART.rowHeight / 2),
  }));

  // The lanes are drawn in their own coordinate space, starting at zero, because the ladder
  // gutter is a separate drawing that stays put while the lanes scroll sideways under it. A lane's
  // `x` is therefore its position in the ORDER, not a position on the page — which is exactly what
  // `theme/order.js` rewrites when the reader puts the features in their own order.
  const lanes = workstreams.map((stream, index) => ({
    ...buildLane(stream, ladder.rows),
    x: index * CHART.columnPitch,
  }));

  const ladderBottom = rowTop(rows.length);
  const lanesWidth = lanes.length * CHART.columnPitch + CHART.rightMargin;
  const width = CHART.ladderWidth + lanesWidth;
  const height =
    Math.max(ladderBottom, ...lanes.map((lane) => (lane.balloon ? lane.balloon.y + lane.balloon.height : 0))) + 28;

  // The four bands (#780): they belong to the LADDER, not to any feature, so they run the full
  // width and the phase reads horizontally across every feature at once. The first three are one
  // row each and are already named in the ladder gutter; the fourth is everything from M1 down and
  // is by far the tallest, which is why its tint has to survive being stretched.
  const stageRows = rows.filter((row) => row.kind === 'stage');
  const bands = [
    ...stageRows.map((row) => ({ id: row.id, label: row.caption, y: row.y, height: CHART.rowHeight })),
    ...(rows.length > stageRows.length
      ? [
          {
            id: 'execution',
            label: 'Execution',
            y: rowTop(stageRows.length),
            height: ladderBottom - rowTop(stageRows.length),
          },
        ]
      : []),
  ];

  return {
    width,
    lanesWidth,
    height,
    ladderWidth: CHART.ladderWidth,
    ladderBottom,
    headerHeight: CHART.headerHeight,
    columnPitch: CHART.columnPitch,
    rows,
    bands,
    // A light rule at every ladder row, full width, drawn BENEATH the ribbons so a ribbon crosses
    // a rule rather than being cut by it (#780). Lines, not a grid: the moment these meet
    // verticals they are cells again.
    rules: rows.slice(1).map((row) => row.y),
    lanes,
  };
}
