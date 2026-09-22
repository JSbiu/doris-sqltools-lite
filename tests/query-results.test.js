const assert = require('node:assert/strict');
const test = require('node:test');

const {
  columnNamesFromFields,
  createRowCollector,
  findSqlStatementAtOffset,
  hasMultipleStatements,
} = require('../out/queryResults.js');

function collect(maxRows, rows) {
  const collector = createRowCollector(maxRows);
  for (const row of rows) {
    collector.onRow(row);
  }
  return collector;
}

test('keeps field headers and zero rows for an empty SELECT', () => {
  const collector = createRowCollector(1000);
  collector.onColumns(['id']);

  const view = collector.toView();
  assert.deepEqual(view.rows, []);
  assert.deepEqual(view.columns, ['id']);
  assert.equal(view.truncated, false);
  assert.equal(view.totalRows, 0);
});

test('represents an affected-row statement without pretending it returned rows', () => {
  const collector = createRowCollector(1000);
  collector.onAffectedRows(2);

  const view = collector.toView();
  assert.deepEqual(view.rows, []);
  assert.deepEqual(view.columns, []);
  assert.equal(view.affectedRows, 2);
});

test('caps the kept rows and counts every row that streamed past', () => {
  const collector = collect(2, [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]);

  const view = collector.toView();
  assert.deepEqual(view.rows, [{ id: 1 }, { id: 2 }]);
  assert.equal(view.totalRows, 5);
  assert.equal(view.truncated, true);
});

test('discarded rows are never retained, whatever the answer size', () => {
  const collector = createRowCollector(3);
  for (let index = 0; index < 20_000; index += 1) {
    collector.onRow({ id: index });
  }

  const view = collector.toView();
  assert.equal(view.rows.length, 3);
  assert.equal(view.totalRows, 20_000);
  assert.equal(view.truncated, true);
});

test('reports the running total so a progress line can follow it', () => {
  const collector = createRowCollector(1);
  assert.equal(collector.totalRows(), 0);

  collector.onRow({ id: 1 });
  collector.onRow({ id: 2 });

  assert.equal(collector.totalRows(), 2);
  assert.equal(collector.toView().rows.length, 1);
});

test('does not mark a result as truncated when it fits exactly', () => {
  const exact = collect(2, [{ id: 1 }, { id: 2 }]).toView();
  assert.equal(exact.truncated, false);
  assert.equal(exact.totalRows, 2);
});

test('falls back to 1000 kept rows for an invalid cap', () => {
  const collector = createRowCollector(0);
  for (let index = 0; index < 1500; index += 1) {
    collector.onRow({ id: index });
  }

  assert.equal(collector.toView().rows.length, 1000);
});

test('falls back to the row keys when the driver reports no columns', () => {
  const collector = createRowCollector(10);
  collector.onRow({ first: 1, second: 2 });

  assert.deepEqual(collector.toView().columns, ['first', 'second']);
});

test('reads column names out of mysql2 field packets', () => {
  assert.deepEqual(columnNamesFromFields([{ name: 'id' }, { name: 'name' }]), ['id', 'name']);
  // A statement with no result set raises `fields` with undefined.
  assert.deepEqual(columnNamesFromFields(undefined), []);
  assert.deepEqual(columnNamesFromFields('not-an-array'), []);
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

test('signals the row limit exactly once, one row past the cap', () => {
  // The signal is what stops the read, so it has to fire at the first row that
  // cannot be kept -- not on the last row we wanted, and not repeatedly.
  let signals = 0;
  const collector = createRowCollector(3, { onLimitReached: () => { signals += 1; } });

  collector.onRow({ n: 1 });
  collector.onRow({ n: 2 });
  collector.onRow({ n: 3 });
  assert.equal(signals, 0, 'a result that fits is not truncated');

  collector.onRow({ n: 4 });
  assert.equal(signals, 1);

  collector.onRow({ n: 5 });
  collector.onRow({ n: 6 });
  assert.equal(signals, 1, 'only the first row past the cap signals');

  const view = collector.toView();
  assert.equal(view.rows.length, 3);
  assert.equal(view.totalRows, 6);
  assert.equal(view.truncated, true);
});

test('never signals when the caller gave no callback', () => {
  const collector = createRowCollector(1);
  assert.doesNotThrow(() => {
    collector.onRow({ n: 1 });
    collector.onRow({ n: 2 });
  });
  assert.equal(collector.totalRows(), 2);
});
