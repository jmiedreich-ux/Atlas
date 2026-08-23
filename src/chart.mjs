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
//   * ONE OBJECT, SEEN TWICE. A FAINT arrow spans the whole recorded length of the feature, from
//     the top of the ladder to the last milestone that has a record. The SOLID arrow is laid OVER
//     it, from the same top, as far as the work has actually reached: finished work in one colour,
//     the milestone actually in flight in another. They OVERLAY; they do not tile.
//
//     M2.1 built them tiled — the solid one stopping and the faint one starting below it — and
//     #780 corrected it on sight: "you cannot have the first arrow without the second ... they are
//     one object seen twice, not two objects in sequence." A feature with nothing recorded beyond
//     where it stands has the solid arrow alone, because there is nothing for it to be a portion of.
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

import { daysBetween, formatDay, formatDayRange, formatDuration } from './dates.mjs';

// An arrowhead's base is WIDER than the body it grows from — that flare is what makes it read as a
// head rather than as the bar simply stopping, and #780 calls the head "the one cell on the chart
// that answers the question the page exists for". So the flare stays.
//
// What that costs, and what M2.1 got wrong, is that a head is therefore wider than its ribbon and
// the date column beside it must clear the HEAD, not the body. Both the drawing and the constants
// below go through this one function, so the two can never disagree — which is the whole of the
// defect #780 found on first render.
const HEAD_FLARE = 0.42;

function flareOf(width) {
  return Math.round(width * HEAD_FLARE);
}

/** How far an arrowhead of this body width reaches either side of its own centre line. */
export function headHalfWidth(width) {
  return Math.round(width / 2) + flareOf(width);
}

// The lane's own geometry, derived rather than written down twice.
//
// `ribbonCentre` is the lane's spine: #780 requires the feature's NAME BOX and its ribbon to share
// a centre line, so the name box is placed about this value rather than given the whole column.
// The box is therefore narrower than the column, and the space to its right is where the dates go —
// which is the only arrangement that fits at this column pitch. The alternative, a full-width name
// box with the ribbon centred under it, pushes the date column past the pitch and needs the whole
// chart about 45% wider; at 1600px that puts two of six features off-screen.
const RIBBON_CENTRE = 62;
const RIBBON_WIDTH = 36;
const HEAD_MARGIN = 4;

// Every measurement the page is built from, in one place and in user units. Frozen because a
// caller adjusting one of these at runtime would move half a drawing and not the other half.
export const CHART = Object.freeze({
  rowHeight: 52,
  headerHeight: 62,
  ladderWidth: 104,
  columnPitch: 240,
  rightMargin: 16,

  // Within a lane, measured from the lane's own origin.
  ribbonCentre: RIBBON_CENTRE,
  ribbonWidth: RIBBON_WIDTH,
  faintWidth: 28,
  headLength: 30,
  faintHeadLength: 26,
  ribbonRadius: 6,
  faintRadius: 5,

  // The column of text beside every ribbon: the dates, and a skipped milestone's reason.
  //
  // DERIVED, not written down. M2.1 set this to a fixed offset from the ribbon's centre, which is
  // right for the ribbon and wrong for the head that grows out of it — so the head's flare covered
  // the dates on three of the fixture's six features and several hundred tests passed anyway.
  // Deriving it from `headHalfWidth` is what makes the relation survive the next change to either.
  textX: RIBBON_CENTRE + headHalfWidth(RIBBON_WIDTH) + 6,
  textLine: 13,

  // How wide a character of that text is, as a BUDGET rather than a measurement — the same kind of
  // declared approximation `balloonChars` is, and for the same reason: a measurement taken in one
  // browser would not survive the reader's own font settings.
  //
  // It exists so that one thing this module genuinely cannot see can still be asserted. The date
  // column is the only run of free text laid beside the drawing, and the widest line in it must
  // not reach the NEXT feature's balloon, which is painted after it and is opaque. That collision
  // was invisible to every coordinate test in the suite and visible the moment the page was
  // rendered. `tests/chart.test.mjs` holds the constraint.
  textCharWidth: 6.4,

  // A ribbon stops short of its row's boundary so the light rule beneath it stays visible either
  // side of the head, rather than being buried under a solid block.
  topInset: 8,
  bottomInset: 8,

  // The balloon sits far enough into its own column that the PREVIOUS feature's date column
  // cannot reach it. That is the collision the rendered page revealed: a span across a year
  // boundary is the widest line the chart can print, and at an inset of 12 it landed under the
  // neighbour. Its width shrinks by the same amount, so the balloon still ends where it did.
  balloonInset: 24,
  balloonWidth: 196,
  balloonRadius: 14,
  balloonTailRise: 26,
  balloonLine: 15,
  balloonPad: 14,
  balloonChars: 28,
  balloonMaxLines: 5,
  // The step a balloon leads with gets two lines at most; the gate under it gets the budget
  // above. A milestone title that needs more than two lines is a title, not a paragraph.
  balloonStepLines: 2,

  dotRadius: 7,
  skipRadius: 12,
  detourReach: 28,
  balloonPinRadius: 4,

  // A feature's NAME BOX: the drag handle, its accent spine, and the two lines inside it.
  //
  // #780: "centre the arrow on its feature's name box ... they should share a centre line." M2.1
  // gave the box the whole column width, which put the ribbon at the far left of it. The box is
  // now a plate centred on the lane's spine, so its width is fixed by where that spine sits:
  // twice the margin's distance from it. The rest of the column is the date column, which is what
  // the plate used to sit over.
  headMargin: HEAD_MARGIN,
  headWidth: 2 * (RIBBON_CENTRE - HEAD_MARGIN),
  headTop: 6,
  headHeight: 44,
  headRadius: 8,
  headAccentWidth: 5,
  headAccentRadius: 2,
  headTextX: 16,
  headTitleY: 26,
  headChipY: 32,

  // The ladder gutter: the rotated band name down its left edge, and the row captions down its
  // right.
  ladderBandX: 18,
  ladderCaptionInset: 14,
  ladderCaptionRise: 4,
});

// EVERY measurement the page draws comes from the object above, through the drawing this module
// returns. The template interpolates and computes nothing — see the note at the head of
// `theme/_includes/depth.njk`, and `tests/theme.test.mjs`, which reads the rendered attributes
// back and compares them against this drawing. That test exists because the first draft of the
// template DID compute: it hard-coded `centre - 18` for a ribbon whose width it then read from
// here, so raising `ribbonWidth` moved the head and left the body four pixels off-centre with the
// whole suite still green.

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
 * Characters rather than measured text: a measurement taken in one browser would not survive the
 * reader's own font settings anyway, so the budget is deliberately approximate. The budget
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
//
// The half-width comes from `headHalfWidth`, the same function the date column's own `textX` is
// derived through. That is deliberate: M2.1 computed the flare here and the text offset up there,
// and the two drifted apart the moment either moved.
function headPath(centre, width, y, length) {
  const half = headHalfWidth(width);
  const left = centre - half;
  const right = centre + half;
  // Explicit `L x y` rather than the shorter `H x`: every command here takes a full coordinate
  // pair, so the path can be read back as points. A unit test can then assert that the
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
      { text: formatDayRange(started, completed), strong: true },
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
    // The left edge, not just the width: the template must never halve a width of its own, or a
    // change to `ribbonWidth` moves the head and leaves the body off-centre behind it.
    x: centre - Math.round(CHART.ribbonWidth / 2),
    width: CHART.ribbonWidth,
    radius: CHART.ribbonRadius,
  };

  // The faint reach. M2.1 drew this as a SECOND arrow beginning below the solid one, the two
  // tiling the ladder end to end. #780 corrected that after seeing it rendered:
  //
  //   "The faint arrow runs the whole recorded span, and the solid arrow overlays it as far as the
  //    work has actually reached ... they are one object seen twice, not two objects in sequence."
  //
  // So the faint arrow starts where the solid one starts — the top of the ladder — and runs to the
  // end of the records. The solid one is then laid over it, and because the solid body and its
  // head's flare are both wider than the faint body, what shows of the faint arrow is exactly the
  // part the work has not reached. That is the whole construction, and it is why an "expected
  // depth" field was never needed: the faint arrow is the object, and the solid one is how much of
  // it has happened.
  //
  // The two are one object, so the detour round a skipped milestone belongs to both: the object
  // went round that milestone once. Without this the faint band runs straight through the gap the
  // solid ribbon's detour leaves, and the crossed marker sits on a bar instead of beside a break.
  //
  // Still absent entirely when nothing is recorded beyond where the work has got — a feature with
  // no records ahead has one arrow only, and #780 has not changed that.
  //
  // DRAW ORDER IS LOAD-BEARING and this module cannot express it: SVG paints in document order, so
  // `theme/_includes/depth.njk` must emit this arrow BEFORE the solid one. `tests/theme.test.mjs`
  // pins that, because getting it backwards draws a pale bar over the work.
  let faint = null;
  if (recordedIndex > solidEndIndex) {
    const faintBottom = rowTop(recordedIndex) + CHART.rowHeight - CHART.bottomInset;
    const faintHeadTop = faintBottom - CHART.faintHeadLength;
    faint = {
      segments: splitAroundDetours(top, faintHeadTop, detourRows).map((run) => ({ ...run, tone: 'ahead' })),
      detours: detourRows.map((index) => detourPath(centre, index)),
      head: { d: headPath(centre, CHART.faintWidth, faintHeadTop, CHART.faintHeadLength), tone: 'ahead' },
      x: centre - Math.round(CHART.faintWidth / 2),
      width: CHART.faintWidth,
      radius: CHART.faintRadius,
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
    .map(({ m, index }) => {
      const y = rowTop(index) + Math.round(CHART.rowHeight / 2);
      return {
        id: m.id,
        y,
        r: CHART.dotRadius,
        tone: index === liveIndex ? 'live' : 'done',
        hollow: index === liveIndex,
        // Each line carries its own baseline, exactly as the balloon's do. The template stacks
        // nothing.
        lines: dateLines(m, index === liveIndex).map((line, i) => ({
          ...line,
          y: y - 3 + i * CHART.textLine,
        })),
      };
    });

  const skips = column.skipped
    .map((skip) => ({ skip, index: rowIndexOf(rows, skip.rowId) }))
    .filter(({ index }) => index >= 0)
    .map(({ skip, index }) => {
      const y = rowTop(index) + Math.round(CHART.rowHeight / 2);
      return {
        id: skip.id,
        y,
        r: CHART.skipRadius,
        cross: skipCross(centre, y, CHART.skipRadius),
        // No milestone identifier: #780 puts those in the ladder column and nowhere else, and the
        // marker already sits on that milestone's own row, so naming it here says it twice.
        label: 'Skipped',
        reason: skip.issue ? `#${skip.issue} · ${skip.status}` : skip.status,
        labelY: y - 3,
        reasonY: y + 10,
      };
    });

  return {
    slug: stream.slug,
    codename: column.codename,
    stage: column.stage,
    url: stream.url,
    centre,
    // The column of text beside this feature's ribbon.
    textX: CHART.textX,
    solid,
    faint,
    dots,
    skips,
    balloon: buildBalloon(stream, rows, { headIndex, liveIndex, arrowBottom, centre, solidTipY: solidBottom }),
    arrowBottom,
  };
}

// --- the balloon ------------------------------------------------------------------------------------

/**
 * The balloon: the one place on this page that speaks in sentences.
 *
 * WHERE IT ATTACHES. #780 says two things that read as incompatible — an earlier comment pins
 * one feature's balloon at its first milestone, "where its arrowhead is"; a later one says balloons
 * "attach at the end of the arrow, not the middle and not somewhere else on the ribbon" — and the
 * owner settled it as owner:
 *
 *   "A balloon attaches to the end of the arrow whose subject it is speaking about. A balloon
 *    describing what is happening now attaches to the end of the solid arrow. A balloon describing
 *    what is next attaches to the head that points at it."
 *
 * So the two were never in conflict about placement, only about which arrow. A NOW balloon attaches
 * at the tip of the solid arrow's head — where the work has actually reached, which is what it is
 * about. A NEXT balloon attaches at the row that head POINTS AT — which, for a feature whose
 * solid arrow ends in the stages and whose records run on past it, is its first milestone: exactly
 * where the earlier comment already drew it. M2.1 put every balloon at the head row's centre
 * whatever it said, which is right for one of the two cases by accident.
 *
 * WHAT IT SAYS, which #780 asked to be worked as a design decision rather than picked from the
 * manifest's field list: A BALLOON SAYS WHAT THE DRAWING CANNOT.
 *
 *   * At a milestone, the drawing says "M4" and nothing about what M4 IS. So the balloon leads with
 *     the milestone's title, emphasised — and then carries the GATE, because "what is holding it"
 *     is the question this page exists to answer, and the phone view already ends every card on it.
 *   * In the stages, the drawing already names the row the head points at — Designing, Planned — so
 *     repeating it would be the balloon saying what the reader can already see. It carries the gate
 *     alone.
 *
 * M2.1's mapping was the title at a milestone and the gate in the stages, and the asymmetry was the
 * defect: the features actually moving got a two-word fragment while the ones that had not started
 * got an actionable sentence. Both now end on the same gate the phone view ends on, so the two
 * surfaces speak the same sentence about the same feature.
 *
 * AND THE RULES M2.1 ESTABLISHED, WHICH ALL STILL HOLD. No next step, no balloon — one reading
 * "nothing is next" is noise. Fixed width tied to the column, growing downward, never into a
 * neighbour. The connector stays inside its own column. Placement is per feature, not one global
 * pass, which is #780's own ruling after a global pass produced worse results.
 */
function buildBalloon(stream, rows, { headIndex, liveIndex, arrowBottom, centre, solidTipY }) {
  const headRow = rows[headIndex];
  if (!headRow) return null;

  const live = headIndex === liveIndex;
  const gate = stream.manifest.gate;

  // `step` is the emphasised line — what this step IS. Null in the stages, where the ladder already
  // names it. `holding` is the quieter one under it — what has to happen before it moves.
  // Nothing on record at the head's own row: the feature has run past its records, and there is
  // genuinely nothing to say. No balloon.
  //
  // Read from the LADDER's own `tipLabel` rather than re-derived from the manifest here. That is
  // the whole of #780's second defect: this module decided "no balloon" from the manifest while
  // the phone view decided "Next: M5" from the ladder, and the two surfaces disagreed in front of
  // the reader. One field, read by both.
  if (stream.column.tipLabel === null) return null;

  let step = null;
  let kicker;
  if (headRow.kind === 'stage') {
    kicker = 'Next';
  } else {
    const milestone = stream.manifest.milestones.find((m) => m.depth === headRow.depth);
    if (!milestone) return null;
    step = milestone.title;
    kicker = live ? 'Happening now' : 'Next';
  }

  // A gate that merely restates the step would be the balloon saying one thing twice.
  const holding = gate && gate !== step ? gate : null;

  const lines = [
    ...wrapText(step ?? '', CHART.balloonChars, CHART.balloonStepLines).map((text) => ({ text, strong: true })),
    ...wrapText(holding ?? '', CHART.balloonChars, CHART.balloonMaxLines).map((text) => ({ text, strong: false })),
  ];
  if (lines.length === 0) return null;

  const x = CHART.balloonInset;
  const width = CHART.balloonWidth;
  const tailX = centre + 30;

  // The attachment point, per the ruling above. Both sit on the lane's own spine, so a balloon
  // reads as a mark ON its arrow rather than as something parked beside it.
  const attachY = live ? solidTipY : rowTop(headIndex) + Math.round(CHART.rowHeight / 2);

  // Below this feature's own arrow, clear of what it attaches to. Per feature, by #780's own
  // ruling — there is deliberately no cross-column placement pass.
  const y = Math.max(arrowBottom + 34, attachY + 74);
  const height = CHART.balloonPad * 2 + 14 + lines.length * CHART.balloonLine;

  return {
    kicker,
    tone: live ? 'live' : 'next',
    x,
    y,
    width,
    height,
    path: balloonPath(x, y, width, height, tailX),
    connector: connectorPath(centre, attachY, tailX, y - CHART.balloonTailRise),
    dot: { x: centre, y: attachY, r: CHART.balloonPinRadius },
    textX: x + CHART.balloonPad,
    kickerY: y + CHART.balloonPad + 8,
    // Each line carries its own baseline and whether it is the step or the gate. The template
    // stacks nothing and classifies nothing.
    lines: lines.map((line, i) => ({
      ...line,
      y: y + CHART.balloonPad + 14 + (i + 1) * CHART.balloonLine - 4,
    })),
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
    // The caption's own baseline, so the gutter stacks nothing of its own.
    captionY: rowTop(index) + Math.round(CHART.rowHeight / 2) + CHART.ladderCaptionRise,
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
  const band = (id, label, y, height) => ({
    id,
    label,
    y,
    height,
    // Where the rotated name in the ladder gutter turns about.
    labelX: CHART.ladderBandX,
    labelY: y + Math.round(height / 2),
  });
  const bands = [
    ...stageRows.map((row) => band(row.id, row.caption, row.y, CHART.rowHeight)),
    ...(rows.length > stageRows.length
      ? [band('execution', 'Execution', rowTop(stageRows.length), ladderBottom - rowTop(stageRows.length))]
      : []),
  ];

  return {
    width,
    lanesWidth,
    height,
    ladderWidth: CHART.ladderWidth,
    ladderBottom,
    // Where the gutter's right-aligned row captions sit.
    ladderCaptionX: CHART.ladderWidth - CHART.ladderCaptionInset,
    // A feature's name box. Identical for every lane, because a lane is drawn about its own
    // origin — and CENTRED ON THE RIBBON below it (#780), which is what fixes its width: the
    // margin decides where it starts, and the spine decides where its centre is, so the two
    // together decide how wide it can be.
    head: {
      x: CHART.headMargin,
      y: CHART.headTop,
      width: CHART.headWidth,
      height: CHART.headHeight,
      radius: CHART.headRadius,
      accentWidth: CHART.headAccentWidth,
      accentRadius: CHART.headAccentRadius,
      textX: CHART.headTextX,
      titleY: CHART.headTitleY,
      chipY: CHART.headChipY,
    },
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
