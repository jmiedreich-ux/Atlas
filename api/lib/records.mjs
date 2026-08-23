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

// A setext heading: a line of text with a line of `=` or `-` under it. Not the same rule as
// `HEADING`, and the reason this constant exists separately — the ATX form was pinned by a test
// and the underlined form was not, so `"Injected Heading\n================"` rendered as an `<h1>`
// inside somebody else's question.
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)\s*$/;

// `<` followed by anything that could open a tag, close one, start a comment, or start a
// processing instruction.
//
// **Why this is a flat refusal and not a sanitiser.** `src/markdown.mjs` sets `html: true`
// deliberately — decision 11, the corpus's `<sub>` citations must survive — and the site carries
// no CSP, so anything that reaches a record reaches every reader's browser same-origin with these
// endpoints. The alternative to refusing is an allow-list of safe tags and attributes, which is a
// sanitiser, and a sanitiser is a thing somebody has to keep current forever. An answer is typed
// into a form rather than authored as a document; it does not need tags, and the corpus's own
// inline HTML keeps working because it is not written through here.
//
// `<` on its own is untouched: `3 < 4` is ordinary prose, and a rule that banned the character
// would be refusing sentences rather than markup.
const TAG_ISH = /<[a-zA-Z/!?]/;

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

  // Every heading form, not only the one with a `#`. Either would split the record the text was
  // written into and steal the rest of somebody else's question.
  const lines = normalised.split('\n');
  if (lines.some((line) => HEADING.test(line))) {
    return 'one of its lines would become a Markdown heading, which would split the record it was written into';
  }
  for (let i = 1; i < lines.length; i += 1) {
    // A setext underline only makes a heading when there is a non-blank line above it to underline
    // — otherwise `---` is a thematic break and a row of dashes is a table's delimiter, both of
    // which belong in an answer.
    if (SETEXT_UNDERLINE.test(lines[i]) && lines[i - 1].trim() !== '') {
      return (
        'one of its lines would underline the line above it into a Markdown heading, which would ' +
        'split the record it was written into'
      );
    }
  }

  if (/<!--\s*\/?atlas:/.test(normalised)) {
    return "it contains one of Atlas's own record markers";
  }

  // C1. The one that mattered: see TAG_ISH above.
  if (TAG_ISH.test(normalised)) {
    return (
      'it contains HTML, and the records are rendered with inline HTML enabled — so a tag written ' +
      'here would run in the browser of everyone who can read the site. Write it as prose, or as ' +
      'an entity such as &lt;sub&gt;'
    );
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

  // The FIRST open, and the FIRST close after it. Taking the last close instead — which this did
  // until a review found it — means a record holding a stray `<!-- /atlas:acceptance -->` further
  // down loses everything between the two markers on the next write. A block is the span between
  // one open and its own close; every later marker is somebody else's text, and Atlas replaces its
  // own block or nothing.
  let start = -1;
  let end = -1;
  for (let i = from; i < to; i += 1) {
    const line = lines[i].trim();
    if (start === -1) {
      if (line === open) start = i;
      continue;
    }
    if (line === close) {
      end = i;
      break;
    }
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

/**
 * Append a deployment transition to a JSON log.
 *
 * A deployment log is a flat JSON array of transition objects. This function parses the current
 * content, appends one new entry with `stage` and optional `note`, and returns the stringified
 * result with 2-space indentation and a trailing newline.
 *
 * Following the repository's convention, absent optional fields (like `note` when
 * undefined/null/empty) are omitted from the JSON object rather than set to null.
 *
 * @param {string} text - the current file content ('' or '[]' for a new log).
 * @param {object} opts
 * @param {string} opts.stage - the deployment stage.
 * @param {string} [opts.note] - optional note; omitted from output if undefined, null, or empty.
 * @returns {string} the new JSON text with one more entry appended, with trailing newline.
 */
export function appendDeploymentTransition(text, { stage, note }) {
  // Handle empty or missing input as an empty array
  const input = text.trim() === '' ? '[]' : text;
  let arr;
  try {
    arr = JSON.parse(input);
  } catch {
    arr = [];
  }

  // Build the new entry, omitting `note` if it's absent/empty
  const entry = { stage };
  if (note !== undefined && note !== null && String(note).trim() !== '') {
    entry.note = note;
  }

  // Append and stringify with 2-space indent and trailing newline
  arr.push(entry);
  return JSON.stringify(arr, null, 2) + '\n';
}
