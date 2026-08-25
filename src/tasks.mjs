// Parses the GitHub task-list checklist already inside a milestone's linked issue body into the
// flat, sequential task list the feature-planning spine renders (design doc: "Task lists: source
// and parsing"). This is the only new data source the rebuild introduces — the checklist already
// exists; Atlas previously rendered it as literal `- [x]` text instead of parsing it.
//
// Deliberately no hierarchy: an indented sub-item reads as an ordinary top-level line, because the
// owner has said sub-tasks, if they ever appear, "would all just get listed sequentially."

// An optional leading task id — `T3 · Move dialog to…` — decision 62 (draft): the same id shape
// `headingId` (api/lib/records.mjs) uses for a register question's heading (letters then digits,
// `/^[A-Za-z]{1,8}[-.]?\d+[a-z]?$/`), mirrored here rather than imported — `api/` and `src/` are
// separate concerns in this codebase, and the two ids need to match the same shape exactly, not
// merely resemble it, so a future comparison between a register id and a task id never has to
// wonder if they were ever the same rule. Unlike a register heading, a task line has no natural
// first-token boundary a plain id could lean on, so the id here needs an unambiguous separator of
// its own — the middle dot, never plain whitespace. That is what keeps this from misfiring on a
// task that merely starts with an id-shaped word: "T3 create the menu" has no `·`, so it stays
// ordinary text, `id: null`, exactly as every task parsed before this existed.
const TASK_ID_TAG = /^([A-Za-z]{1,8}[-.]?\d+[a-z]?)\s*·\s*(.+)$/;

// A line may end with an owner tag: an em-dash, an en-dash, or a plain hyphen, preceded by
// whitespace, followed by a name. Whitespace before the dash is what keeps this from misfiring on
// a hyphenated word inside the task text itself ("Write-back" has no space before its hyphen, so
// it never matches).
//
// The owner tag is defined as "optional, trailing" — the LAST dash-delimited segment, never the
// first. `.exec()` finds the leftmost position a pattern can match, and a naive `(\S.*)$` is
// greedy: from the first qualifying dash it swallows everything after, including any later dash,
// which misreads a task whose own text happens to contain a dash-separated aside ("Deploy -
// staging and prod — Claude" used to read as owner "staging and prod — Claude"). The fix is the
// capture group itself: it excludes every dash character, so it can only ever match a run of text
// with NO dash in it at all. A run reaching all the way to `$` with zero dashes is only possible
// starting from the LAST dash in the string — trying any earlier dash hits a later one before `$`
// and fails to match, so the engine's normal leftmost-first search lands on the last dash for us,
// with no lookahead or backtracking trick required.
const OWNER_TAG = /\s+[—–-]\s*([^\s—–-][^—–-]*)$/;

// GitHub task-list syntax: "- [ ] text" or "- [x] text", any leading indentation, case-insensitive
// mark. Anything else on a line — prose, a heading, an ordinary bullet with no checkbox — is not a
// task and is ignored.
const TASK_LINE = /^-\s*\[([ xX])\]\s+(.+)$/;

/**
 * @param {string | null | undefined} issueBody
 * @returns {{ id: string | null, text: string, done: boolean, owner: string | null }[]}
 */
export function parseTasks(issueBody) {
  if (typeof issueBody !== 'string') return [];

  const tasks = [];
  for (const rawLine of issueBody.split('\n')) {
    const match = TASK_LINE.exec(rawLine.trim());
    if (!match) continue;

    const done = match[1].toLowerCase() === 'x';
    let text = match[2].trim();
    let id = null;

    // Read before the owner tag, not after: the id is a LEADING marker and the owner a TRAILING
    // one, and neither pattern can ever match inside the other's own capture, so order between
    // them only matters for readability here, not correctness.
    const idMatch = TASK_ID_TAG.exec(text);
    if (idMatch) {
      id = idMatch[1];
      text = idMatch[2].trim();
    }

    let owner = null;
    const ownerMatch = OWNER_TAG.exec(text);
    if (ownerMatch) {
      owner = ownerMatch[1].trim();
      text = text.slice(0, ownerMatch.index).trim();
    }
    if (text.length === 0) continue;

    tasks.push({ id, text, done, owner });
  }
  return tasks;
}
