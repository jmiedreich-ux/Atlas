// A question register's contract (M5, decision 51): a register is structured data, and its
// readable document (register.mjs's own renderRegisterMarkdown, below) is generated from it —
// decision 3's rule, applied here rather than excepted from.
//
// Every register in practice offers multiple choice with a recommendation, and the owner
// routinely supplies an answer that was not on the list. `chosen` therefore has three shapes,
// not two: an offered option was picked, an answer was written in, or the question is deferred —
// and an unanswered question is a deferral, never silent acceptance (the same rule the corpus's
// own README already states in prose).

export const REGISTER_SEVERITIES = Object.freeze(['BLOCKING', 'important', 'minor']);
export const CHOSEN_KINDS = Object.freeze(['offered', 'written-in', 'deferred']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
function joinPath(base, segment) {
  return base ? `${base}.${segment}` : segment;
}
function requireString(obj, key, path, errors) {
  if (!isNonEmptyString(obj[key])) {
    errors.push({ path: joinPath(path, key), message: `"${key}" is required and must be a non-empty string (got ${JSON.stringify(obj[key])})` });
    return false;
  }
  return true;
}
function requireEnum(obj, key, allowed, path, errors) {
  if (typeof obj[key] !== 'string' || !allowed.includes(obj[key])) {
    errors.push({ path: joinPath(path, key), message: `"${key}" must be one of: ${allowed.join(', ')} (got ${JSON.stringify(obj[key])})` });
    return false;
  }
  return true;
}

function validateChosen(chosen, options, path, errors) {
  if (!isPlainObject(chosen)) {
    errors.push({ path, message: '"chosen" is required and must be an object with "kind" and "value"' });
    return;
  }
  if (!requireEnum(chosen, 'kind', CHOSEN_KINDS, path, errors)) return;

  if (chosen.kind === 'deferred') {
    if (chosen.value !== null) {
      errors.push({ path: joinPath(path, 'value'), message: '"value" must be null when chosen.kind is "deferred"' });
    }
    return;
  }
  if (chosen.kind === 'written-in') {
    if (!isNonEmptyString(chosen.value)) {
      errors.push({ path: joinPath(path, 'value'), message: '"value" is required and must be a non-empty string when chosen.kind is "written-in"' });
    }
    return;
  }
  // kind === 'offered'
  if (!isNonEmptyString(chosen.value) || !options.includes(chosen.value)) {
    errors.push({
      path: joinPath(path, 'value'),
      message: `"value" must be one of this question's own "options" when chosen.kind is "offered" (got ${JSON.stringify(chosen.value)})`,
    });
  }
}

function validateQuestion(q, path, errors) {
  if (!isPlainObject(q)) {
    errors.push({ path, message: 'a register question must be an object' });
    return;
  }
  requireString(q, 'id', path, errors);
  requireString(q, 'question', path, errors);
  requireString(q, 'why', path, errors);

  if (!Array.isArray(q.options) || q.options.length === 0 || !q.options.every(isNonEmptyString)) {
    errors.push({ path: joinPath(path, 'options'), message: '"options" is required and must be a non-empty array of non-empty strings' });
  } else if (!requireString(q, 'recommended', path, errors)) {
    // already errored
  } else if (!q.options.includes(q.recommended)) {
    errors.push({ path: joinPath(path, 'recommended'), message: `"recommended" must be one of this question's own "options" (got ${JSON.stringify(q.recommended)})` });
  }

  requireEnum(q, 'severity', REGISTER_SEVERITIES, path, errors);
  if (Array.isArray(q.options)) validateChosen(q.chosen, q.options, joinPath(path, 'chosen'), errors);

  if (q.citations !== undefined && (!Array.isArray(q.citations) || !q.citations.every((c) => typeof c === 'string'))) {
    errors.push({ path: joinPath(path, 'citations'), message: '"citations" must be an array of strings when present' });
  }
}

function assertNoDuplicateIds(questions, errors) {
  const seen = new Map();
  questions.forEach((q, index) => {
    if (typeof q?.id !== 'string') return;
    const key = q.id.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) {
      errors.push({
        path: `questions[${index}].id`,
        message: `question id ${JSON.stringify(q.id)} is already used by questions[${first}]`,
      });
      return;
    }
    seen.set(key, index);
  });
}

/**
 * Validate a question register (decision 51): the contract for
 * `docs/features/<slug>/register.json`.
 *
 * @param {unknown} obj
 * @returns {{ ok: true, value: object } | { ok: false, errors: { path: string, message: string }[] }}
 */
export function validateRegister(obj) {
  if (!isPlainObject(obj)) {
    return { ok: false, errors: [{ path: '', message: 'a register must be an object' }] };
  }
  const errors = [];
  requireString(obj, 'slug', '', errors);
  requireString(obj, 'title', '', errors);

  if (!Array.isArray(obj.questions)) {
    errors.push({ path: 'questions', message: '"questions" is required and must be an array' });
  } else {
    obj.questions.forEach((q, i) => validateQuestion(q, `questions[${i}]`, errors));
    assertNoDuplicateIds(obj.questions, errors);
  }

  if (errors.length > 0) return { ok: false, errors };

  const value = structuredClone(obj);
  value.questions = value.questions.map((q) => ({ citations: [], ...q }));
  return { ok: true, value };
}
