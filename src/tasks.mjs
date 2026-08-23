// Parses the GitHub task-list checklist already inside a milestone's linked issue body into the
// flat, sequential task list the feature-planning spine renders (design doc: "Task lists: source
// and parsing"). This is the only new data source the rebuild introduces — the checklist already
// exists; Atlas previously rendered it as literal `- [x]` text instead of parsing it.
//
// Deliberately no hierarchy: an indented sub-item reads as an ordinary top-level line, because the
// owner has said sub-tasks, if they ever appear, "would all just get listed sequentially."

// A line may end with an owner tag: an em-dash or a plain hyphen, preceded by whitespace, followed
// by a name. Whitespace before the dash is what keeps this from misfiring on a hyphenated word
// inside the task text itself ("Write-back" has no space before its hyphen, so it never matches).
const OWNER_TAG = /\s+[—-]\s*(\S.*)$/;

// GitHub task-list syntax: "- [ ] text" or "- [x] text", any leading indentation, case-insensitive
// mark. Anything else on a line — prose, a heading, an ordinary bullet with no checkbox — is not a
// task and is ignored.
const TASK_LINE = /^-\s*\[([ xX])\]\s+(.+)$/;

/**
 * @param {string | null | undefined} issueBody
 * @returns {{ text: string, done: boolean, owner: string | null }[]}
 */
export function parseTasks(issueBody) {
  if (typeof issueBody !== 'string') return [];

  const tasks = [];
  for (const rawLine of issueBody.split('\n')) {
    const match = TASK_LINE.exec(rawLine.trim());
    if (!match) continue;

    const done = match[1].toLowerCase() === 'x';
    let text = match[2].trim();
    let owner = null;

    const ownerMatch = OWNER_TAG.exec(text);
    if (ownerMatch) {
      owner = ownerMatch[1].trim();
      text = text.slice(0, ownerMatch.index).trim();
    }
    if (text.length === 0) continue;

    tasks.push({ text, done, owner });
  }
  return tasks;
}
