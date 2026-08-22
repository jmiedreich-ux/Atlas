import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderMarkdown, headingAnchors } from '../src/markdown.mjs';

// All fixture data below is invented for this test file and for fixture/ only — the generator
// holds no project content of its own (decision 40).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, '..', 'fixture');

function readFixture(relPath) {
  return readFileSync(path.join(FIXTURE_ROOT, relPath), 'utf8');
}

const KEEPER_NOTES = readFixture(path.join('docs', 'design', 'approved', 'keeper-notes.md'));
const KEEPER_NOTES_BASE = path.posix.join('docs', 'design', 'approved');

// --- nested lists (decision 11: two- and three-space, never four) --------

test('renderMarkdown: a two-space nested unordered list nests rather than flattens', () => {
  const html = renderMarkdown('- Top\n  - Nested two-space\n  - Second nested\n- Sibling');
  assert.ok(
    html.includes('<li>Top\n<ul>\n<li>Nested two-space</li>\n<li>Second nested</li>\n</ul>\n</li>'),
    `expected a nested <ul> inside the "Top" item, got:\n${html}`,
  );
});

test('renderMarkdown: a three-space nested ordered list nests rather than flattens', () => {
  const html = renderMarkdown('1. Top\n   1. Nested three-space\n   2. Second nested\n2. Sibling');
  assert.ok(
    html.includes('<li>Top\n<ol>\n<li>Nested three-space</li>\n<li>Second nested</li>\n</ol>\n</li>'),
    `expected a nested <ol> inside the "Top" item, got:\n${html}`,
  );
});

test('renderMarkdown: the fixture corpus nests its two-space list under "watch rotation"', () => {
  const html = renderMarkdown(KEEPER_NOTES, { hrefBase: KEEPER_NOTES_BASE });
  assert.ok(
    html.includes(
      "<li>Beacon's watch rotation\n<ul>\n<li>Dawn shift</li>\n<li>Dusk shift</li>\n</ul>\n</li>",
    ),
  );
});

test('renderMarkdown: the fixture corpus nests its three-space list under "Confirm the lamp is lit"', () => {
  const html = renderMarkdown(KEEPER_NOTES, { hrefBase: KEEPER_NOTES_BASE });
  assert.ok(
    html.includes(
      '<li>Confirm the lamp is lit\n<ol>\n<li>Check the oil reservoir</li>\n<li>Check the mechanism</li>\n</ol>\n</li>',
    ),
  );
});

// --- pipe tables get a horizontally scrollable wrapper (Task 6 depends on this) ---

test('renderMarkdown: a pipe table is wrapped in a horizontally scrollable container', () => {
  const html = renderMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |\n');
  assert.match(html, /<div class="[^"]*scroll[^"]*">\s*<table>/);
  assert.match(html, /<\/table>\s*<\/div>/);
});

test('renderMarkdown: the table wrapper does not appear around ordinary content', () => {
  const html = renderMarkdown('Just a paragraph, no table here.');
  assert.doesNotMatch(html, /scroll/);
});

test('renderMarkdown: the fixture reading-log table ends up inside the scroll wrapper', () => {
  const html = renderMarkdown(KEEPER_NOTES, { hrefBase: KEEPER_NOTES_BASE });
  assert.match(html, /<div class="[^"]*scroll[^"]*">\s*<table>[\s\S]*Oil level[\s\S]*<\/table>\s*<\/div>/);
});

// --- inline HTML survives, because <sub> carries source citations --------

test('renderMarkdown: inline <sub> HTML survives unescaped', () => {
  const html = renderMarkdown('Bearing is 214°<sub>true</sub> today.');
  assert.ok(html.includes('<sub>true</sub>'));
  assert.ok(!html.includes('&lt;sub&gt;'));
});

test('renderMarkdown: <sub> inside a table cell in the fixture survives unescaped', () => {
  const html = renderMarkdown(KEEPER_NOTES, { hrefBase: KEEPER_NOTES_BASE });
  assert.ok(html.includes("<sub>keeper's log, watch 14</sub>"));
});

// --- link rewriting --------------------------------------------------------

test('renderMarkdown: a relative .md link rewrites to the generated page URL', () => {
  const html = renderMarkdown('[text](other.md)');
  assert.ok(html.includes('href="/other/"'), html);
});

test('renderMarkdown: a relative .md link resolves against hrefBase, including ../ segments', () => {
  const html = renderMarkdown('[plan](../../features/beacon/m2-plan.md)', {
    hrefBase: KEEPER_NOTES_BASE,
  });
  assert.ok(html.includes('href="/docs/features/beacon/m2-plan/"'), html);
});

test('renderMarkdown: an absolute link is left untouched', () => {
  const html = renderMarkdown('[repo](https://github.com/atlas-fixtures/lighthouse)', {
    hrefBase: KEEPER_NOTES_BASE,
  });
  assert.ok(html.includes('href="https://github.com/atlas-fixtures/lighthouse"'), html);
});

test('renderMarkdown: a same-page fragment link is left untouched', () => {
  const html = renderMarkdown('[jump](#some-anchor)', { hrefBase: KEEPER_NOTES_BASE });
  assert.ok(html.includes('href="#some-anchor"'), html);
});

test('renderMarkdown: a link to a .html file resolves to the copied file, spaces and all', () => {
  const html = renderMarkdown('[notes](../../field%20notes.html)', { hrefBase: KEEPER_NOTES_BASE });
  assert.ok(html.includes('href="/docs/field%20notes.html"'), html);
});

test('renderMarkdown: the fixture corpus link-rewrites all three link kinds correctly', () => {
  const html = renderMarkdown(KEEPER_NOTES, { hrefBase: KEEPER_NOTES_BASE });
  assert.ok(html.includes('href="/docs/features/beacon/m2-plan/"'), 'relative .md link');
  assert.ok(html.includes('href="https://github.com/atlas-fixtures/lighthouse"'), 'absolute link');
  assert.ok(html.includes('href="/docs/field%20notes.html"'), '.html link with a space in its name');
});

// --- fenced code keeps its language -----------------------------------

test('renderMarkdown: a fenced code block keeps its language as a class', () => {
  const html = renderMarkdown('```bash\necho hi\n```');
  assert.ok(html.includes('<pre><code class="language-bash">'), html);
});

test('renderMarkdown: the fixture corpus fenced JSON block keeps its language', () => {
  const html = renderMarkdown(KEEPER_NOTES, { hrefBase: KEEPER_NOTES_BASE });
  assert.ok(html.includes('<pre><code class="language-json">'), html);
});

// --- heading anchors are stable, so #d15-style deep links keep working ---

test('headingAnchors: a bare "D15" heading produces the literal id "d15"', () => {
  const anchors = headingAnchors('## D15\n\nSome text.');
  assert.deepEqual(anchors, [{ id: 'd15', text: 'D15', level: 2 }]);
});

test('headingAnchors: repeated heading text gets distinct, deterministic ids', () => {
  const anchors = headingAnchors('## Notes\n\nHi\n\n## D15\n\nBye\n\n## Notes\n');
  assert.deepEqual(anchors, [
    { id: 'notes', text: 'Notes', level: 2 },
    { id: 'd15', text: 'D15', level: 2 },
    { id: 'notes-1', text: 'Notes', level: 2 },
  ]);
});

test('headingAnchors: heading levels reflect the number of #s', () => {
  const anchors = headingAnchors('# Title\n\n### Sub\n');
  assert.deepEqual(anchors, [
    { id: 'title', text: 'Title', level: 1 },
    { id: 'sub', text: 'Sub', level: 3 },
  ]);
});

test('headingAnchors: inline formatting is stripped from the slug but kept in the text', () => {
  const anchors = headingAnchors('## The `foo` thing');
  assert.deepEqual(anchors, [{ id: 'the-foo-thing', text: 'The foo thing', level: 2 }]);
});

test('headingAnchors: is deterministic across repeated calls on the same text', () => {
  const first = headingAnchors(KEEPER_NOTES);
  const second = headingAnchors(KEEPER_NOTES);
  assert.deepEqual(first, second);
});

test('headingAnchors: matches the fixture corpus headings in document order', () => {
  const anchors = headingAnchors(KEEPER_NOTES);
  assert.deepEqual(anchors, [
    { id: 'keepers-notes', text: "Keeper's notes", level: 1 },
    { id: 'notes', text: 'Notes', level: 2 },
    { id: 'd15', text: 'D15', level: 2 },
    { id: 'notes-1', text: 'Notes', level: 2 },
  ]);
});

test('renderMarkdown: the id headingAnchors reports for a heading matches the id rendered on the page', () => {
  const html = renderMarkdown(KEEPER_NOTES, { hrefBase: KEEPER_NOTES_BASE });
  for (const { id, text, level } of headingAnchors(KEEPER_NOTES)) {
    assert.ok(
      html.includes(`<h${level} id="${id}">${text}</h${level}>`),
      `expected an <h${level} id="${id}"> for heading "${text}" in:\n${html}`,
    );
  }
});
