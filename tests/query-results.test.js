const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createQueryResultView,
  findSqlStatementAtOffset,
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

test('finds the SQL statement at the cursor without requiring a selection', () => {
  const sql = [
    'SELECT 1;',
    '',
    '-- inspect the second result',
    "SELECT 'a;b' AS value;",
    '',
    'SELECT 3;',
  ].join('\n');

  assert.equal(findSqlStatementAtOffset(sql, sql.indexOf('value')), "-- inspect the second result\nSELECT 'a;b' AS value;");
  assert.equal(findSqlStatementAtOffset(sql, sql.indexOf('SELECT 3')), 'SELECT 3;');
});

test('uses the nearest statement when the cursor is in surrounding whitespace', () => {
  const sql = 'SELECT 1;\n\n\nSELECT 2;';

  assert.equal(findSqlStatementAtOffset(sql, 0), 'SELECT 1;');
  assert.equal(findSqlStatementAtOffset(sql, sql.length), 'SELECT 2;');
});

test('selects the next statement when it starts immediately after a separator', () => {
  const sql = 'SELECT 1;SELECT 2;';

  assert.equal(findSqlStatementAtOffset(sql, sql.indexOf('SELECT 2')), 'SELECT 2;');
});


test('ignores semicolons in quoted identifiers, strings, and comments', () => {
  const sql = [
    "SELECT 'it''s;fine' AS text;",
    '/* ; ignored */ SELECT `semi;colon` FROM demo;',
  ].join('\n');

  assert.equal(findSqlStatementAtOffset(sql, sql.indexOf('demo')), '/* ; ignored */ SELECT `semi;colon` FROM demo;');
  assert.equal(hasMultipleStatements(sql), true);
});

test('returns no statement for whitespace and comments only', () => {
  assert.equal(findSqlStatementAtOffset('  -- note\n /* another note */ ', 4), undefined);
});

test('does not treat `--` followed by non-whitespace as a comment', () => {
  const sql = 'SELECT 1; --x\nSELECT 2;';
  assert.equal(hasMultipleStatements(sql), true);
  assert.equal(findSqlStatementAtOffset('--x;', 0), '--x;');
});

test('treats `/*! */` executable comments as plain comments in this MVP', () => {
  assert.equal(findSqlStatementAtOffset('/*! SELECT 1 */', 0), undefined);
  assert.equal(hasMultipleStatements('SELECT 1; /*! SELECT 2 */'), false);
});

test('keeps DELIMITER-like client commands as plain statements', () => {
  assert.equal(hasMultipleStatements('DELIMITER ;;'), false);
});

test('handles CRLF line endings inside line comments', () => {
  const sql = '-- comment\r\nSELECT 1;';
  assert.equal(hasMultipleStatements(sql), false);
  assert.equal(findSqlStatementAtOffset(sql, sql.indexOf('SELECT 1')), sql);
});

test('ignores comment markers inside strings and quoted identifiers', () => {
  assert.equal(hasMultipleStatements("SELECT '-- not a comment' AS text;"), false);
  assert.equal(hasMultipleStatements('SELECT `semi--colon` FROM demo;'), false);
  assert.equal(hasMultipleStatements("SELECT '/* not a comment */' AS text;"), false);
});

test('ignores empty statements between consecutive semicolons', () => {
  assert.equal(hasMultipleStatements('SELECT 1;;'), false);
  assert.equal(hasMultipleStatements(';;; SELECT 1'), false);
  assert.equal(findSqlStatementAtOffset('SELECT 1;;', 9), 'SELECT 1;');
});

test('clamps out-of-range or invalid cursor offsets', () => {
  assert.equal(findSqlStatementAtOffset('SELECT 1;', 9999), 'SELECT 1;');
  assert.equal(findSqlStatementAtOffset('SELECT 1;', Number.NaN), 'SELECT 1;');
  assert.equal(findSqlStatementAtOffset('SELECT 1;', -5), 'SELECT 1;');
});

test('accepts a final statement without a trailing semicolon', () => {
  assert.equal(findSqlStatementAtOffset('SELECT 1', 0), 'SELECT 1');
});

test('falls back to 1000 rows for an invalid maxRows', () => {
  assert.equal(createQueryResultView([{ id: 1 }], [{ name: 'id' }], 0).truncated, false);
  assert.equal(createQueryResultView([{ id: 1 }], [{ name: 'id' }], Number.NaN).truncated, false);
});
