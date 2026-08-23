// Decision 27's triage mapping: which of five states a workstream is in on the phone, and the
// order those states are shown in.
//
// This lived inside `theme/mobile.njk` until Task 7. It moved here because `state.json`
// (decision 29) must be fed by the same function the phone view renders from: two derivations of
// "what needs the owner" is precisely the drift decisions 1 and 29 exist to prevent, and a
// template cannot be unit-tested against a table or reused by the state emitter.
//
// **The mapping's semantics are deliberately unruled.** The owner has deferred that until the
// product is further along. What is here is a faithful relocation of what the template did —
// including the fallback that sends anything it does not recognise to `awaiting-decision`. When
// the ruling comes, `classifyTriage` is the one function to change and `tests/triage.test.mjs`
// is the one table to update.

// Decision 27, in order: "one card for the decision waiting on them, then moving, blocked,
// designing, not started."
export const TRIAGE_ORDER = Object.freeze([
  'awaiting-decision',
  'moving',
  'blocked',
  'designing',
  'not-started',
]);

/**
 * Which of decision 27's five states a workstream is in.
 *
 * Stage is read first, because a workstream that has not started designing yet cannot be moving
 * whatever its milestone list says. Only once a workstream is past `planned` do its milestones
 * decide anything.
 *
 * @param {object} manifest - a validated workstream manifest (decision 14).
 * @returns {'awaiting-decision' | 'moving' | 'blocked' | 'designing' | 'not-started'}
 */
export function classifyTriage(manifest) {
  const milestones = manifest?.milestones ?? [];

  if (manifest?.stage === 'not-started') return 'not-started';
  if (manifest?.stage === 'designing') return 'designing';
  // Designed, not approved: the approval is the owner's to give.
  if (manifest?.stage === 'planned') return 'awaiting-decision';

  if (milestones.some((m) => m.status === 'next')) return 'moving';
  if (milestones.some((m) => m.status === 'parked')) return 'blocked';

  // Everything else is waiting on the owner: a shipping workstream with nothing left on record to
  // do (the fixture's Anchor), and any stage this mapping does not recognise. Unruled, and
  // deliberately preserved rather than corrected — see the module comment.
  return 'awaiting-decision';
}

/**
 * The workstreams, ordered by what needs the owner (decision 27) rather than by name, each
 * carrying the state it was classified into.
 *
 * Ties keep the order the config declared, so two cards in the same state never swap places
 * between builds — one of the several things that make a rebuild byte-identical.
 *
 * @param {{ slug: string, manifest: object }[]} workstreams - the array `resolveWorkstreams`
 *   produced, optionally with further fields attached; every field survives.
 * @returns {({ slug: string, manifest: object } & { triage: string })[]} a new array of new
 *   objects. Neither the input array nor the manifests inside it are touched.
 */
export function orderByTriage(workstreams) {
  const classified = workstreams.map((entry) => ({ ...entry, triage: classifyTriage(entry.manifest) }));
  return TRIAGE_ORDER.flatMap((state) => classified.filter((entry) => entry.triage === state));
}
