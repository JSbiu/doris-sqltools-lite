const assert = require('node:assert/strict');
const test = require('node:test');
const { assertDirectExportSql } = require('../out/directExport');

test('direct export accepts single result queries including CTEs, existing LIMIT and quoted punctuation', () => {
  for (const sql of [
    'SELECT 1;', 'SELECT * FROM orders LIMIT 10;',
    "-- context\nSELECT ';DELETE' AS text;",
    'WITH c AS (SELECT 1), d AS (SELECT * FROM c) SELECT * FROM d;',
    'WITH RECURSIVE c AS (SELECT 1 UNION ALL SELECT 2) SELECT * FROM c;',
    'SHOW TABLES;', 'DESC orders;', 'DESCRIBE orders;', 'EXPLAIN SELECT * FROM orders;',
    'SELECT `into`, "with", replace(name, "a", "b") FROM orders;',
  ]) assert.doesNotThrow(() => assertDirectExportSql(sql), sql);
});

test('direct export rejects writes, multi-statements and server-side file output before execution', () => {
  for (const sql of [
    '', 'SELECT 1; SELECT 2;', 'INSERT INTO orders VALUES (1);', 'UPDATE orders SET a=1;',
    'DELETE FROM orders;', 'CREATE TABLE copy AS SELECT * FROM orders;', 'CALL side_effect();',
    'WITH c AS (SELECT 1) DELETE FROM orders;', 'WITH c AS (SELECT 1) UPDATE orders SET a=1;',
    "SELECT * FROM orders INTO OUTFILE '/tmp/orders.tsv';", '/*! SELECT 1 */;',
  ]) assert.throws(() => assertDirectExportSql(sql), sql);
});
