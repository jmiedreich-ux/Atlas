// Fixture content only, invented for Atlas's own test suite.
//
// This script is the sibling of reference.html. Together they exist so a later task can assert
// that standalone HTML and its sibling script are copied byte-for-byte, never templated
// (decision 10). If a template engine ever touches either file, this comment or the DOCTYPE
// above it is exactly the kind of thing it would mangle.
document.getElementById('panel').textContent =
  'Rendered entirely by support.js -- untouched by any template engine.';
