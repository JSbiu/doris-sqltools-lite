const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveStatementContext, findDirectiveConnection } = require('../out/sqlDirectives');
const { resolveSqlParameters } = require('../out/sqlParameters');

const document = [
  '-- @default-connection: Spark数仓',
  '-- @default-param: day = 2026-10-21',
  '-- @default-param: id = 1',
  '',
  '-- @name: 订单',
  "SELECT '${day}', ${id};",
  '',
  '-- @name: 支付',
  '-- @connection: MySQL业务库',
  '-- @param: id = 2',
  "SELECT '${day}', ${id};",
  '',
  '-- 普通注释',
  "SELECT '${day}', ${id};",
].join('\n');

test('file defaults, local overrides and names resolve independently for each statement', () => {
  const first = resolveStatementContext(document, document.indexOf('SELECT'));
  const second = resolveStatementContext(document, document.indexOf('SELECT', document.indexOf('SELECT') + 1));
  const third = resolveStatementContext(document, document.lastIndexOf('SELECT'));
  assert.equal(first.name, '订单');
  assert.equal(first.connection, 'Spark数仓');
  assert.equal(second.name, '支付');
  assert.equal(second.connection, 'MySQL业务库');
  assert.deepEqual(second.parameters, { day: '2026-10-21', id: '2' });
  assert.equal(third.connection, 'Spark数仓');
  assert.equal(third.name, undefined);
  assert.equal(third.parameters.id, '1');
  assert.equal(resolveSqlParameters(second.sql, second.parameters).sql, "SELECT '2026-10-21', 2;");
  assert.doesNotMatch(first.sql, /@default/);
});

test('selecting just SQL inherits its header without executing surrounding SQL', () => {
  const start = document.lastIndexOf('SELECT');
  const context = resolveStatementContext(document, start, document.length);
  assert.equal(context.connection, 'Spark数仓');
  assert.equal(context.sql, "SELECT '${day}', ${id};");
  assert.throws(() => resolveStatementContext(document, 0, document.length), /一条 SQL/);
});

test('directives in strings, block comments and SQL body cannot route a query', () => {
  const sql = "/* -- @connection: bad */\nSELECT '-- @connection: bad' AS text\n-- @connection: bad\n;";
  const context = resolveStatementContext(sql, sql.indexOf('SELECT'));
  assert.equal(context.connection, undefined);
  assert.equal(context.sql, sql);
});

test('header scanning handles CRLF, BOM, comments and semicolons in parameter values', () => {
  const sql = '\uFEFF-- ordinary\r\n/* context */\r\n-- @default-param: code = A;B=C\r\n-- @name: demo\r\nSELECT \'${code}\';';
  const context = resolveStatementContext(sql, sql.length);
  assert.equal(context.parameters.code, 'A;B=C');
  assert.equal(context.name, 'demo');
  assert.doesNotMatch(context.sql, /@default-param/);
});

test('invalid, unknown and duplicate directives fail instead of silently using another source', () => {
  for (const sql of [
    '-- @connection: \nSELECT 1;',
    '-- @conection: wrong\nSELECT 1;',
    '-- @param: bad name = 1\nSELECT 1;',
    '-- @name: one\n-- @name: two\nSELECT 1;',
    '-- @param: x = 1\n-- @param: x = 2\nSELECT 1;',
    '-- @connection wrong\nSELECT 1;',
  ]) assert.throws(() => resolveStatementContext(sql, sql.length));
  const sql = 'SELECT 1;\n-- @default-connection: wrong\nSELECT 2;';
  assert.throws(() => resolveStatementContext(sql, sql.length), /第一条 SQL/);
});

test('whitespace / comments alone are not executable; local first-statement values are not file defaults', () => {
  assert.equal(resolveStatementContext('-- @name: only comments', 0), undefined);
  const sql = '-- @connection: local\n-- @param: x = 1\nSELECT ${x};\nSELECT 2;';
  const second = resolveStatementContext(sql, sql.length);
  assert.equal(second.connection, undefined);
  assert.deepEqual(second.parameters, {});
});

test('connection resolution accepts exact ID or unique name and rejects missing or ambiguous names', () => {
  const profiles = [{ id: 'a', name: 'same' }, { id: 'b', name: 'same' }, { id: 'c', name: 'unique' }];
  assert.equal(findDirectiveConnection(profiles, 'b'), profiles[1]);
  assert.equal(findDirectiveConnection(profiles, 'unique'), profiles[2]);
  assert.throws(() => findDirectiveConnection(profiles, 'same'), /不唯一/);
  assert.throws(() => findDirectiveConnection(profiles, 'missing'), /不存在/);
});

test('a cursor immediately after a semicolon belongs to the next statement', () => {
  const sql = 'SELECT 1;SELECT 2;';
  assert.equal(resolveStatementContext(sql, sql.indexOf('SELECT 2')).sql, 'SELECT 2;');
});

test('@output belongs to its statement and is inherited when selecting only the SQL body', () => {
  const sql = '-- @output: results/orders.tsv\nSELECT 1;\nSELECT 2;';
  const start = sql.indexOf('SELECT');
  assert.equal(resolveStatementContext(sql, start).output, 'results/orders.tsv');
  assert.equal(resolveStatementContext(sql, start, sql.indexOf(';') + 1).output, 'results/orders.tsv');
  assert.doesNotMatch(resolveStatementContext(sql, start).sql, /@output/);
  assert.equal(resolveStatementContext(sql, sql.lastIndexOf('SELECT')).output, undefined);
  for (const header of ['-- @output: ', '-- @output: a.tsv\n-- @output: b.tsv', '-- @default-output: a.tsv']) {
    assert.throws(() => resolveStatementContext(`${header}\nSELECT 1;`, 0));
  }
});

test('file batch directives are stripped in ordinary execution and cannot appear on later statements', () => {
  const header = '-- @batch-script: ./params.ps1\n-- @batch-steps: ["写入"]\n-- @batch-init: []\n';
  const sql = header + '-- @name: 写入\nINSERT INTO target VALUES (1);';
  const context = resolveStatementContext(sql, 0);
  assert.equal(context.sql, 'INSERT INTO target VALUES (1);');
  assert.equal(context.name, '写入');
  assert.throws(() => resolveStatementContext('SELECT 1;\n' + sql, 100), /第一条 SQL/);
  assert.throws(() => resolveStatementContext(header.replace('["写入"]', '写入') + 'SELECT 1;', 0), /JSON 数组/);
});
