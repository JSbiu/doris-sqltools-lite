const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createQueryResultView,
  hasMultipleStatements,
} = require('../out/queryResults.js');

test('keeps field headers and zero rows for an empty SELECT', () => {
  const result = createQueryResultView([], [{ name: 'id' }], 1000);

  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.columns, ['id']);
  assert.equal(result.truncated, false);
});

test('represents an affected-row statement without pretending it returned rows', () => {
  const result = createQueryResultView({ affectedRows: 2 }, undefined, 1000);

  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.columns, []);
  assert.equal(result.affectedRows, 2);
});

test('marks only genuinely truncated result sets', () => {
  const result = createQueryResultView(
    [{ id: 1 }, { id: 2 }, { id: 3 }],
    [{ name: 'id' }],
    2,
  );

  assert.deepEqual(result.rows, [{ id: 1 }, { id: 2 }]);
  assert.equal(result.truncated, true);
  assert.equal(createQueryResultView([{ id: 1 }, { id: 2 }], [{ name: 'id' }], 2).truncated, false);
});

test('allows one statement with a trailing semicolon or comments', () => {
  assert.equal(hasMultipleStatements('SELECT 1;'), false);
  assert.equal(hasMultipleStatements("SELECT ';' AS value;"), false);
  assert.equal(hasMultipleStatements('SELECT 1; -- trailing comment'), false);
  assert.equal(hasMultipleStatements('SELECT 1; /* trailing comment */'), false);
});

test('detects a second SQL statement outside strings and comments', () => {
  assert.equal(hasMultipleStatements('SELECT 1; SELECT 2'), true);
  assert.equal(hasMultipleStatements('SELECT 1; /* comment */ UPDATE demo SET value = 2'), true);
  assert.equal(hasMultipleStatements('SELECT 1;\n# comment\nDELETE FROM demo'), true);
});
