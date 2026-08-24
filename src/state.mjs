// `state.json` — the one thing Atlas offers agents (decisions 4, 29).
//
// Decision 4 says Atlas is for the owner, not for agents, because a rendered page is a worse
// input than the Markdown it came from. Decision 29 is the single exception: a session's
// orientation read becomes one guaranteed-current file instead of six.
//
// The rule that makes it worth having is that it is not a second derivation. `buildState` is
// handed the very objects the pages were rendered from — the same manifests, the same ladder, the
// same triage call, the same issue buckets — and projects them. It reads nothing from disk, calls
// no other module, and computes nothing that a page computed separately. If the site and this file
// ever disagree, it is because something was recomputed here instead of passed in.
//
// Two rules about what goes in it:
//
//   * Every path is repository-relative and slash-separated. Decision 2 says Atlas is never the
//     record: an agent reads `state.json` to find out *which file to open*, and an absolute path
//     from a CI runner is no use to anyone. It also keeps a rebuild byte-identical across
//     machines.
//   * Nothing is dated. A build stamp would make every rebuild differ from the last, which would
//     destroy the only property that lets a reader trust the file is current.
//
// THREE NAMES IN HERE MEAN MORE THAN ONE THING, and an inheritor will meet all three. Recorded
// rather than renamed, because this is a v1 contract (`version: 1` below) and renaming a key after
// a consumer exists is the change this file's version number is for:
//
//   * `label` is three concepts. On a milestone it is decision 17's display form of `id` ("M1");
//     on a workstream it is the GitHub label issues are bucketed by ("workstream:beacon"); on a
//     ladder row it is the row's caption ("3", or "Designing").
//   * `depth` is two shapes. On a milestone it is an integer — decision 20's position on the
//     shared ladder. On a workstream it is an object: where its column's bar and head landed.
//   * `next` and `depth.note` are the SAME string, emitted twice under two names. `next` is the
//     manifest's own field; `note` is what the chart prints at the column's tip, and the chart
//     prints `next`. A consumer should read `next`.

// The shape of this document. Bumped only when a change would break a reader that understood the
// previous version — a new optional key does not.
export const STATE_VERSION = 1;

function issueRef(issue) {
  return { number: issue.number, title: issue.title, url: issue.html_url };
}

/**
 * Project the assembled site model into the agent-facing state document.
 *
 * @param {object} site - the model `src/build.mjs` rendered the pages from.
 * @returns {object} a plain, JSON-serialisable object.
 */
export function buildState(site) {
  // Object key order is insertion order, and this is the only place labels are inserted, so
  // sorting here is what makes the file diff to nothing between two identical builds.
  const byLabel = {};
  for (const label of [...site.issues.byLabel.keys()].sort()) {
    byLabel[label] = site.issues.byLabel.get(label).map(issueRef);
  }

  // Task 6 fix round 2: `computeLadder` (src/depth.mjs) destructures `stage` straight off the raw
  // manifest — deliberately, since that same value also drives its bar/head-position math, which
  // this projection must not disturb. `column.stage` therefore still carries the raw
  // `manifest.stage`, the same staleness `workstreams[].stage` had before the first fix round. Keyed
  // by codename (the field `ladder.columns[]` and `workstreams[]` both carry, and the one
  // `computeLadder`'s columns are built from) rather than slug, since `column` has no slug of its
  // own.
  const displayedStageByCodename = new Map(
    site.workstreams.map((stream) => [stream.manifest.codename, stream.displayedStage]),
  );

  return {
    // Decision 29 makes this a contract other tools consume, so it says which contract it is —
    // first key, before anything a reader would have to parse to find it. One line now; after a
    // consumer exists, an unversioned shape cannot be changed in a way anyone can detect.
    version: STATE_VERSION,
    project: site.project,
    repo: site.repo,

    // Decision 22: three purpose-built surfaces. Two of them are whole-project views; the third,
    // a record, is one page per document and is listed under `documents`.
    surfaces: [
      { id: 'depth', title: 'Feature planning', url: '/' },
      { id: 'triage', title: 'What needs you', url: '/mobile/' },
    ],

    workstreams: site.workstreams.map((stream) => ({
      slug: stream.slug,
      codename: stream.manifest.codename,
      what: stream.manifest.what,
      stage: stream.displayedStage,
      position: stream.manifest.position,
      next: stream.manifest.next,
      label: stream.manifest.label,
      // Decision 27's state, from the same call the phone view rendered from.
      triage: stream.triage,
      url: stream.url,
      dir: stream.relDir,
      manifestPath: stream.relManifestPath,
      // Decision 21: named, never linked. The name is all there is to give.
      design: stream.manifest.design.map((reference) => ({
        name: reference.name,
        where: reference.where,
      })),
      // Decision 24: both ends of this workstream's column, as the chart drew them, and how much
      // of it is complete — the same numbers the phone view drew its track from, taken from the
      // one `computeLadder` call this build made. `covered` itself is not projected: it is a
      // per-segment drawing detail of one surface, and `milestones[].status` beside it already
      // tells a reader which milestone is which.
      //
      // Not repeated under `ladder.columns` below, which is the shared ladder *as the chart drew
      // it*, and the chart draws no count. A workstream's own progress belongs to the workstream.
      depth: {
        barTo: stream.column.barTo,
        headAt: stream.column.headAt,
        tipLabel: stream.column.tipLabel,
        note: stream.column.note,
        completedCount: stream.column.completedCount,
        milestoneCount: stream.column.milestoneCount,
      },
      milestones: stream.milestones.map((entry) => ({
        // Decision 17: `id` is durable and unchanging, `label` is the display form. Both.
        id: entry.manifest.id,
        label: entry.manifest.label,
        depth: entry.manifest.depth,
        title: entry.manifest.title,
        status: entry.manifest.status,
        // M2.1, from #780. Stored facts, both: the day it began and the day it closed. Nothing
        // here is derived from today — a closed milestone carries both, one in flight carries a
        // start day alone, one not yet begun carries neither. `null` rather than absent, so a
        // reader never has to tell "no date recorded" from "key not emitted".
        //
        // ADDITIVE, which is why `version` above is still 1: a reader that understood the
        // previous shape finds every key it knew, unchanged.
        started: entry.manifest.started ?? null,
        completed: entry.manifest.completed ?? null,
        // `plan` verbatim as decision 14 fixes it — relative to the workstream's own directory —
        // and `planPath` as the file an agent actually opens.
        plan: entry.manifest.plan,
        planPath: entry.planPath,
        issue: entry.manifest.issue,
        pr: entry.manifest.pr,
        acceptance: {
          kind: entry.manifest.acceptance.kind,
          record: entry.manifest.acceptance.record,
        },
        url: entry.url,
      })),
      issues: stream.issues.map(issueRef),
    })),

    // Decision 27's order, as the phone view laid the cards out.
    triage: site.triaged.map((stream) => ({
      slug: stream.slug,
      codename: stream.manifest.codename,
      triage: stream.triage,
    })),

    // Decisions 20, 23, 24: the shared ladder, exactly as the chart drew it.
    ladder: {
      rows: site.ladder.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        label: row.label,
        depth: row.depth,
      })),
      columns: site.ladder.columns.map((column) => ({
        codename: column.codename,
        // The displayed (log-overridden) stage, not `computeLadder`'s raw `manifest.stage` — see
        // `displayedStageByCodename` above. Falls back to `column.stage` only if a codename ever
        // fails to match, which should not happen since both come from the same `resolved` array.
        stage: displayedStageByCodename.get(column.codename) ?? column.stage,
        barTo: column.barTo,
        headAt: column.headAt,
        tipLabel: column.tipLabel,
        note: column.note,
      })),
    },

    issues: {
      byLabel,
      unlabelled: site.issues.unlabelled.map(issueRef),
      prs: site.issues.prs.map(issueRef),
    },

    // Decision 15: Markdown is the authority for content. These are the records Atlas rendered,
    // and the path is where the record itself lives.
    documents: site.documents.map((doc) => ({ title: doc.title, path: doc.path, url: doc.url })),

    // Decision 10: copied byte-for-byte, never rendered. Listed separately for exactly that
    // reason — an agent must not mistake one for a page Atlas produced.
    // `isDocument` separates the standalone documents decision 10 is about — an `.html` file a
    // reader opens — from the files those documents load. Both are copied and served; only the
    // first is something to send a reader to.
    assets: site.assets.map((asset) => ({
      path: asset.path,
      url: asset.url,
      isDocument: asset.isDocument,
    })),
  };
}

/**
 * `state.json`'s bytes: two-space JSON with a trailing newline, and no key whose order was decided
 * by anything but this module.
 *
 * @param {object} state
 * @returns {string}
 */
export function serialiseState(state) {
  return `${JSON.stringify(state, null, 2)}\n`;
}
