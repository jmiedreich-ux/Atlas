import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRegister, renderRegisterMarkdown } from '../src/register.mjs';

function question(overrides = {}) {
  return {
    id: 'Q1',
    question: 'A question invented for this test?',
    why: 'Because a test needs a why.',
    options: ['Option A', 'Option B'],
    recommended: 'Option A',
    severity: 'BLOCKING',
    chosen: { kind: 'offered', value: 'Option A' },
    citations: [],
    ...overrides,
  };
}

function register(overrides = {}) {
  return { slug: 'lighthouse', title: 'Lighthouse register', questions: [question()], ...overrides };
}

test('register: a well-formed register validates', () => {
  const result = validateRegister(register());
  assert.equal(result.ok, true);
});

test('register: an unknown severity is rejected by name', () => {
  const result = validateRegister(register({ questions: [question({ severity: 'urgent' })] }));
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /severity.*must be one of/i);
});

test('register: an unknown chosen.kind is rejected by name', () => {
  const result = validateRegister(register({ questions: [question({ chosen: { kind: 'maybe', value: null } })] }));
  assert.equal(result.ok, false);
});

test('register: recommended must name a real option', () => {
  const result = validateRegister(register({ questions: [question({ recommended: 'Option Z' })] }));
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /recommended.*must be one of.*options/i);
});

test('register: chosen.kind "offered" must name a real option too', () => {
  const result = validateRegister(
    register({ questions: [question({ chosen: { kind: 'offered', value: 'Option Z' } })] }),
  );
  assert.equal(result.ok, false);
});

test('register: chosen.kind "deferred" requires value to be null', () => {
  const result = validateRegister(
    register({ questions: [question({ chosen: { kind: 'deferred', value: 'Option A' } })] }),
  );
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /value.*null.*deferred/i);
});

test('register: chosen.kind "written-in" requires a non-empty value', () => {
  const result = validateRegister(
    register({ questions: [question({ chosen: { kind: 'written-in', value: '' } })] }),
  );
  assert.equal(result.ok, false);
});

test('register: two questions with the same id fail loudly', () => {
  const result = validateRegister(register({ questions: [question(), question()] }));
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /Q1.*already used/i);
});

test('register: citations defaults to an empty array when omitted, not required', () => {
  const q = question();
  delete q.citations;
  const result = validateRegister(register({ questions: [q] }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.questions[0].citations, []);
});

// --- renderRegisterMarkdown ----------------------------------------------------------------------

test("register: renderRegisterMarkdown reproduces the corpus's own heading and answer shape", () => {
  const md = renderRegisterMarkdown(register({
    questions: [question({
      id: 'Q1',
      chosen: { kind: 'offered', value: 'Option A' },
      citations: ['decisions.md 10', 'README.md'],
    })],
  }));
  assert.match(md, /^### Q1 · BLOCKING$/m);
  assert.match(md, /\*\*A question invented for this test\?\*\*/);
  assert.match(md, /\*Recommended:\* Option A/);
  assert.match(md, /\*Answer:\* Option A/);
  assert.match(md, /<sub>decisions\.md 10; README\.md<\/sub>/);
});

test('register: a written-in answer is marked as such in the document', () => {
  const md = renderRegisterMarkdown(register({
    questions: [question({ chosen: { kind: 'written-in', value: 'A different plan entirely.' } })],
  }));
  assert.match(md, /\*Answer:\* A different plan entirely\. \(written in\)/);
});

test('register: a deferred question says so, with no answer line', () => {
  const md = renderRegisterMarkdown(register({
    questions: [question({ chosen: { kind: 'deferred', value: null } })],
  }));
  assert.match(md, /\*\*Status:\*\* deferred/);
  assert.doesNotMatch(md, /\*Answer:\*/);
});
