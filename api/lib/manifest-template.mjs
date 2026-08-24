// The starter `workstream.json` and first milestone plan a newly-approved design gets — one
// definition, two callers: `src/scaffold.mjs` (the local CLI, M7) writes these to disk, and
// `handleApprove` (`api/lib/handlers.mjs`, M9) writes them as git blobs in the same commit that
// moves the design from `docs/design/proposed/<slug>/` into `docs/features/<slug>/`, where it now
// lands directly (no intermediate `docs/design/approved/<slug>/` — retired 2026-08-24, a consuming
// project's own policy call, not Atlas's). Decision 1 applied to Atlas's own output: a template
// written twice is a template that drifts the first time one caller is fixed and the other is not.
//
// Lives under `api/` rather than `src/` so the Function can import it too — `api/lib/contract.mjs`'s
// header explains why the direction only goes this way: Static Web Apps packages `api/` alone, so a
// Function importing `../src/*` runs in CI and 404s in production. `src/scaffold.mjs` importing
// `api/lib/manifest-template.mjs` is fine; the reverse is not, and nothing here imports from `src/`.

const PLACEHOLDER = (hint) => `<< replace this — ${hint} >>`;

function titleize(slug) {
  return slug
    .split('-')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * The starter manifest for a newly-approved, unscaffolded design.
 *
 * @param {string} slug
 * @returns {object} a `workstream.json`-shaped object, not yet serialised.
 */
export function buildManifest(slug) {
  const codename = titleize(slug);
  return {
    codename,
    what: PLACEHOLDER(`what is ${codename}, in one sentence — see docs/features/${slug}/`),
    stage: 'designing',
    position: PLACEHOLDER('where this stands right now'),
    next: PLACEHOLDER('what is actually blocking work from starting, in one sentence'),
    label: `workstream:${slug}`,
    design: [{ name: `${slug}/approved design`, where: `docs/features/${slug}/` }],
    milestones: [
      {
        id: 'M1',
        label: 'M1',
        depth: 1,
        title: PLACEHOLDER(`M1's real title — see docs/features/${slug}/`),
        status: 'unplanned',
        plan: 'm1-plan.md',
        issue: null,
        pr: null,
        acceptance: { kind: 'demo-script', record: null },
      },
    ],
  };
}

/** The manifest, serialised the way every manifest in this repository is: 2-space JSON, trailing newline. */
export function buildManifestText(slug) {
  return JSON.stringify(buildManifest(slug), null, 2) + '\n';
}

/**
 * The starter first-milestone plan text for a newly-approved, unscaffolded design.
 *
 * @param {string} slug
 * @returns {string}
 */
export function buildPlanText(slug) {
  const codename = titleize(slug);
  return `# ${codename} Milestone 1 — ${PLACEHOLDER("this milestone's title")}

> This is a scaffold, not a plan. Every section below names what to fill in and from where.

## Goal

${PLACEHOLDER('one sentence — what does this milestone actually deliver')}

## Where it will land

${PLACEHOLDER('which repository, which files')}

## Spec

docs/features/${slug}/ — read it before writing anything else in this file.
`;
}
