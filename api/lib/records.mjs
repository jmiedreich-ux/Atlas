// Editing the text of a record, minimally.
//
// Decision 37: a write lands as a commit to the record, and the page is then rebuilt from it. The
// record is therefore the only home the answer has, and what goes into it has to be something a
// person reading the repository on GitHub would have written by hand — decision 11's corpus,
// rendered the way GitHub renders it.
//
// Two properties hold above everything else here:
//
//   * **Nothing outside Atlas's own block changes.** Not a heading, not a blank line. A generator
//     that reformats the record it is answering makes every future diff unreadable.
//   * **Answering twice replaces.** The register says what is settled; git already holds the
//     history of how it got there.
//
// The block is delimited by HTML comments, which GitHub renders as nothing and decision 11
// already tolerates in the corpus. They are what makes "replace the answer" a mechanical
// operation on an exact range of lines rather than a guess about where a paragraph ends.
//
// Nothing here reads the clock. A date written into the text would be a second, worse copy of
// something git already records to the second, and the one thing in this repository that two runs
// over one input could disagree about.

/** A failure with a code the endpoint turns into a status and a sentence. */
export class RecordError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RecordError';
    this.code = code;
  }
}

const OPEN = (kind) => `<!-- atlas:${kind} -->`;
const CLOSE = (kind) => `<!-- /atlas:${kind} -->`;

/** The longest an answer or a note may be. Long enough for a paragraph of reasoning. */
const MAX_TEXT = 8000;

const HEADING = /^ {0,3}#{1,6}\s+(.*)$/;

/**
 * The id a heading carries, or `null`.
 *
 * A question's id is the first whitespace-separated token of its heading, with any trailing
 * punctuation removed — `## Q1 · Does the cutover…`, `### Q12. Something`, `## OQ3 — …`. The shape
 * is deliberately narrow: letters then digits. It has to be, because a rule that matched any first
 * token would let a request for `Open` write an answer under `# Open questions`.
 */
function headingId(headingText) {
  const [token] = headingText.trim().split(/\s+/);
  if (!token) return null;
  const stripped = token.replace(/[.,:;)\]]+$/, '');
  return /^[A-Za-z]{1,8}[-.]?\d+[a-z]?$/.test(stripped) ? stripped : null;
}

/**
 * Why a piece of text may not be written into a record, or `''` when it may.
 *
 * @param {unknown} text
 * @returns {string} a sentence, or ''.
 */
export function whyNotWritableText(text) {
  if (typeof text !== 'string') return 'it is not text';
  const normalised = text.replace(/\r\n/g, '\n');
  if (normalised.trim() === '') return 'it is empty, and an empty answer answers nothing';
  if (normalised.length > MAX_TEXT) {
    return `it is longer than the ${MAX_TEXT} characters a record will carry — put the reasoning in the plan and link to it`;
  }
  if (normalised.split('').some((ch) => ch.codePointAt(0) < 0x20 && ch !== '\n' && ch !== '\t')) {
    return 'it contains a control character';
  }
  if (normalised.split('\n').some((line) => HEADING.test(line))) {
    return 'one of its lines would become a Markdown heading, which would split the record it was written into';
  }
  if (/<!--\s*\/?atlas:/.test(normalised)) {
    return "it contains one of Atlas's own record markers";
  }
  return '';
}

function assertWritable(text, what) {
  const why = whyNotWritableText(text);
  if (why) throw new RecordError(`the ${what} cannot be written into a record because ${why}.`, 'invalid-payload');
}

// Split a file into lines, remembering how it ended them and whether it ended with one, so that
// the file it is rejoined into is the same file it came from.
function decompose(text) {
  const crlf = text.includes('\r\n');
  const trailingNewline = /\r?\n$/.test(text);
  const body = trailingNewline ? text.replace(/\r?\n$/, '') : text;
  return { lines: body.split(/\r?\n/), crlf, trailingNewline };
}

function recompose({ lines, crlf, trailingNewline }) {
  const eol = crlf ? '\r\n' : '\n';
  return lines.join(eol) + (trailingNewline ? eol : '');
}

/**
 * Replace the block of the given kind lying inside `[from, to)`, or insert one at the end of that
 * range when there is none.
 *
 * @returns {string[]} the new lines for the whole file.
 */
function placeBlock(lines, from, to, kind, blockLines) {
  const open = OPEN(kind);
  const close = CLOSE(kind);

  let start = -1;
  let end = -1;
  for (let i = from; i < to; i += 1) {
    const line = lines[i].trim();
    if (line === open && start === -1) start = i;
    if (line === close) end = i;
  }

  const block = [open, ...blockLines, close];

  if (start !== -1 && end > start) {
    return [...lines.slice(0, start), ...block, ...lines.slice(end + 1)];
  }

  // No block yet. It goes at the end of the range, after the section's own trailing blank lines
  // are stepped back over, with exactly one blank line separating it from the prose above.
  let at = to;
  while (at > from && lines[at - 1].trim() === '') at -= 1;

  const before = lines.slice(0, at);
  const after = lines.slice(at);
  const separator = at > 0 && lines[at - 1].trim() !== '' ? [''] : [];
  const gap = after.length > 0 && after[0].trim() !== '' ? [''] : [];

  return [...before, ...separator, ...block, ...gap, ...after];
}

/**
 * Write an answer into the question it answers.
 *
 * @param {string} text - the register's whole current content.
 * @param {object} opts
 * @param {string} opts.question - the question's id, matched case-insensitively.
 * @param {string} opts.answer
 * @param {string} opts.author - from the request's principal, never from its body.
 * @param {string} [opts.where] - the register's repository-relative path, for the failure message.
 * @returns {string} the register's whole new content.
 * @throws {RecordError}
 */
export function answerQuestion(text, { question, answer, author, where = 'the register' }) {
  assertWritable(answer, 'answer');

  const file = decompose(text);
  const wanted = String(question).toLowerCase();

  // Where every heading is, so a section is a range rather than a search.
  const headings = [];
  file.lines.forEach((line, index) => {
    const match = HEADING.exec(line);
    if (match) headings.push({ index, id: headingId(match[1]) });
  });

  const matches = headings.filter((heading) => heading.id?.toLowerCase() === wanted);

  if (matches.length === 0) {
    throw new RecordError(
      `${where} has no question ${JSON.stringify(question)}. A question is a heading whose first ` +
        `word is its id, as in "## ${question} · …". Nothing was written.`,
      'no-such-question',
    );
  }
  if (matches.length > 1) {
    throw new RecordError(
      `${where} has ${matches.length} questions with the id ${JSON.stringify(question)}, so Atlas ` +
        `cannot tell which one is being answered. Give them separate ids. Nothing was written.`,
      'ambiguous-question',
    );
  }

  const start = matches[0].index;
  const next = headings.find((heading) => heading.index > start);
  const end = next ? next.index : file.lines.length;

  const body = String(answer).replace(/\r\n/g, '\n').trim().split('\n');
  const lines = placeBlock(file.lines, start + 1, end, 'answer', [
    `**Answer** (${author}):`,
    '',
    ...body,
  ]);

  return recompose({ ...file, lines });
}

/**
 * Write an acceptance result at the end of the record that holds it.
 *
 * The record is the one a milestone's manifest names in `acceptance.record` (decision 14), so no
 * request ever names a path.
 *
 * @param {string} text - the record's whole current content.
 * @param {object} opts
 * @param {'pass' | 'fail'} opts.result - already checked against the closed vocabulary.
 * @param {string} [opts.note]
 * @param {string} opts.author
 * @returns {string} the record's whole new content.
 * @throws {RecordError}
 */
export function recordAcceptance(text, { result, note, author }) {
  if (note !== undefined && note !== null && String(note).trim() !== '') {
    assertWritable(note, 'note');
  }

  const file = decompose(text);
  const noteLines =
    note && String(note).trim() !== ''
      ? ['', ...String(note).replace(/\r\n/g, '\n').trim().split('\n')]
      : [];

  const lines = placeBlock(file.lines, 0, file.lines.length, 'acceptance', [
    `**Acceptance: ${result}** — recorded by ${author} through Atlas.`,
    ...noteLines,
  ]);

  return recompose({ ...file, lines });
}
