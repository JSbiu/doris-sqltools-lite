const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveStatementContext, findDirectiveConnection, readBatchDirectives } = require('../out/sqlDirectives');
const { readBatchDefinition } = require('../out/batchExecution');
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

test('statements without encryption directives keep the legacy context shape', () => {
  assert.deepEqual(resolveStatementContext('SELECT 1;', 0), {
    sql: 'SELECT 1;', name: undefined, connection: undefined, output: undefined,
    parameters: {}, line: 1, endLine: 1,
  });
  const sql = '-- @encrypt: {"user_id":"user"}\nSELECT 1;\nSELECT 2;';
  const second = resolveStatementContext(sql, sql.length);
  assert.equal(Object.hasOwn(second, 'encryption'), false);
  assert.equal(Object.hasOwn(second, 'requiredEncryption'), false);
});

test('encryption defaults merge with local domains without leaking local fields to other SQL', () => {
  const sql = [
    '-- @default-encrypt: {"user_id":"user","optional_id":"optional"}',
    '-- @encrypt: {"user_id":"owner","space_id":"space"}',
    'SELECT ${user_id} AS owner_id;',
    '-- @encrypt: {"space_id":"project"}',
    'SELECT 2;',
    'SELECT 3;',
  ].join('\n');
  const first = resolveStatementContext(sql, sql.indexOf('SELECT'));
  assert.deepEqual(first.encryption, { user_id: 'owner', optional_id: 'optional', space_id: 'space' });
  assert.deepEqual(first.requiredEncryption, ['user_id', 'space_id']);
  assert.equal(first.sql, 'SELECT ${user_id} AS owner_id;');
  const second = resolveStatementContext(sql, sql.indexOf('SELECT 2'));
  assert.deepEqual(second.encryption, { user_id: 'user', optional_id: 'optional', space_id: 'project' });
  assert.deepEqual(second.requiredEncryption, ['space_id']);
  const third = resolveStatementContext(sql, sql.length);
  assert.deepEqual(third.encryption, { user_id: 'user', optional_id: 'optional' });
  assert.deepEqual(third.requiredEncryption, []);
  assert.equal(third.sql, 'SELECT 3;');
});

test('SQL-only selections inherit encryption alongside parameters, connection and output', () => {
  const sql = [
    '-- @default-encrypt: {"user_id":"user"}',
    '-- @default-param: user_id = 7',
    '-- @default-connection: warehouse',
    '-- @encrypt: {"user_id":"owner"}',
    'SELECT ${user_id} AS user_id;',
    '-- @name: 空间',
    '-- @encrypt: {"space_id":"space"}',
    '-- @param: space_id = 9',
    '-- @output: result.tsv',
    'SELECT ${space_id} AS space_id;',
  ].join('\n');
  for (const start of [sql.indexOf('SELECT'), sql.lastIndexOf('SELECT')]) {
    const end = sql.indexOf(';', start) + 1;
    const whole = resolveStatementContext(sql, start);
    const selected = resolveStatementContext(sql, start, end);
    for (const key of ['encryption', 'requiredEncryption', 'parameters', 'connection', 'output', 'name']) {
      assert.deepEqual(selected[key], whole[key], key);
    }
    assert.equal(selected.sql, sql.slice(start, end));
    assert.doesNotMatch(selected.sql, /@(?:default-)?encrypt/);
  }
  assert.deepEqual(resolveStatementContext(sql, sql.lastIndexOf('SELECT'), sql.length).encryption,
    { user_id: 'user', space_id: 'space' });
  assert.throws(() => resolveStatementContext(sql, sql.indexOf('SELECT'), sql.length), /一条 SQL/);
});

test('empty encryption objects are accepted and cannot remove file defaults', () => {
  for (const header of ['-- @encrypt: {}', '-- @default-encrypt: {}',
    '-- @default-encrypt: {}\n-- @encrypt: {}']) {
    const context = resolveStatementContext(header + '\nSELECT 1;', 0);
    assert.deepEqual(context.encryption, {});
    assert.deepEqual(context.requiredEncryption, []);
    assert.equal(context.sql, 'SELECT 1;');
  }
  const sql = '-- @default-encrypt: {"user_id":"user"}\nSELECT 1;\n-- @encrypt: {}\nSELECT 2;';
  const context = resolveStatementContext(sql, sql.length);
  assert.deepEqual(context.encryption, { user_id: 'user' });
  assert.deepEqual(context.requiredEncryption, []);
  assert.equal(resolveStatementContext('-- @encrypt: {}', 0), undefined);
});

test('default encryption is allowed only before the first SQL', () => {
  const sql = 'SELECT 1;\n-- @default-encrypt: {"user_id":"user"}\nSELECT 2;';
  assert.throws(() => resolveStatementContext(sql, sql.length), /@default-encrypt.*第一条 SQL/);
  assert.throws(() => resolveStatementContext(sql, sql.lastIndexOf('SELECT'), sql.length), /第一条 SQL/);
});

test('encryption directives reject invalid JSON, non-string domains and empty fields', () => {
  const invalid = [
    '', '[]', '["user_id"]', 'null', 'false', '1', '"user"', '{user_id:"user"}',
    '{"user_id":"user",}', '{"user_id":"user"', '{"user_id":"user"} trailing',
    '{"user_id":null}', '{"user_id":false}', '{"user_id":1}', '{"user_id":[]}', '{"user_id":{}}',
    '{"":"user"}', '{"  ":"user"}', '{"user_id":""}', '{"user_id":" \\t"}',
    '{"user_id":"user\\nline"}', '{"user_id":"user\\rline"}',
    '{"user_id":"user\\u2028line"}', '{"user_id":"user\\u2029line"}',
    '{"user_id":[],"user_id":"user"}', '{"user_id":{"nested":"x"},"user_id":"user"}',
  ];
  for (const key of ['encrypt', 'default-encrypt']) {
    for (const value of invalid) {
      const sql = `-- @${key}: ${value}\nSELECT 1;`;
      assert.throws(() => resolveStatementContext(sql, 0), new RegExp(`@${key}`), value);
    }
    assert.throws(() => resolveStatementContext(`-- @${key} {"user_id":"user"}\nSELECT 1;`, 0), /格式错误/);
  }
});

test('repeated encryption directive comments are rejected even for disjoint or empty objects', () => {
  for (const key of ['encrypt', 'default-encrypt']) {
    for (const values of [['{}', '{}'], ['{"user_id":"user"}', '{"space_id":"space"}']]) {
      const sql = `-- @${key}: ${values[0]}\n-- ordinary\n-- @${key}: ${values[1]}\nSELECT 1;`;
      assert.throws(() => resolveStatementContext(sql, 0), /重复的 SQL 注释/);
    }
  }
  const later = 'SELECT 1;\n-- @encrypt: {}\n-- @encrypt: {}\nSELECT 2;';
  assert.throws(() => resolveStatementContext(later, later.length), /重复的 SQL 注释/);
});

test('duplicate JSON fields are rejected after decoding escapes, including prototype names', () => {
  const duplicates = [
    '{"user_id":"user","user_id":"owner"}',
    '{"user_id":"user","space_id":"space","user_id":"user"}',
    '{"user_id":"user","user\\u005fid":"owner"}',
    '{"用户":"user","\\u7528\\u6237":"owner"}',
    '{"__proto__":"user","\\u005f_proto__":"owner"}',
    '{"constructor":"user","constructor":"owner"}',
  ];
  for (const key of ['encrypt', 'default-encrypt']) {
    for (const value of duplicates) {
      assert.throws(() => resolveStatementContext(`-- @${key}: ${value}\nSELECT 1;`, 0), /JSON 字段.*重复/, value);
    }
  }
});

test('prototype fields remain own data properties through parsing, overriding and inheritance', () => {
  const sql = [
    '-- @default-encrypt: {"__proto__":"base","constructor":"ctor","hasOwnProperty":"own"}',
    '-- @encrypt: {"__proto__":"local","toString":"text","prototype":"proto"}',
    'SELECT 1;', 'SELECT 2;',
  ].join('\n');
  const first = resolveStatementContext(sql, sql.indexOf('SELECT'));
  assert.deepEqual(first.encryption, JSON.parse(
    '{"__proto__":"local","constructor":"ctor","hasOwnProperty":"own","toString":"text","prototype":"proto"}'));
  assert.deepEqual(first.requiredEncryption, ['__proto__', 'toString', 'prototype']);
  const second = resolveStatementContext(sql, sql.length);
  assert.deepEqual(second.encryption, JSON.parse('{"__proto__":"base","constructor":"ctor","hasOwnProperty":"own"}'));
  assert.deepEqual(second.requiredEncryption, []);
  for (const context of [first, second]) {
    assert.equal(Object.getPrototypeOf(context.encryption), Object.prototype);
    assert.equal(Object.getOwnPropertyDescriptor(context.encryption, '__proto__').enumerable, true);
    assert.equal(Object.hasOwn(context.encryption, 'constructor'), true);
  }
});

test('Unicode aliases and long field/domain strings preserve their exact contents', () => {
  const fields = {
    '用户 标识🆔': '用户域',
    '字段:"引号"\\路径': '域:"值",\\路径; -- @encrypt: {"fake":"ignored"}',
    padded: ' domain ',
    ['长'.repeat(300)]: '域'.repeat(500),
  };
  const sql = '\uFEFF-- ordinary\r\n/* context */\r\n-- @encrypt: ' + JSON.stringify(fields)
    + '\r\nSELECT 1;';
  const context = resolveStatementContext(sql, 0);
  assert.deepEqual(context.encryption, fields);
  assert.deepEqual(context.requiredEncryption, Object.keys(fields));
  assert.equal(context.sql, '-- ordinary\r\n/* context */\r\nSELECT 1;');
});

test('encryption-like text inside comments, quoted SQL and the SQL body has no effect', () => {
  const sources = [
    '/*\n-- @default-encrypt: []\n-- @encrypt: invalid\n*/\nSELECT 1;',
    '-- ordinary -- @encrypt: {"user_id":"bad"}\nSELECT 1;',
    '# -- @default-encrypt: {"user_id":"bad"}\nSELECT 1;',
    'SELECT \'-- @encrypt: {"user_id":"bad"}\' AS text;',
    'SELECT 1 AS `-- @encrypt: {"user_id":"bad"}`;',
    'SELECT 1\n-- @default-encrypt: []\n-- @encrypt: invalid\n;',
  ];
  for (const sql of sources) {
    const context = resolveStatementContext(sql, 0);
    assert.equal(Object.hasOwn(context, 'encryption'), false);
    assert.equal(Object.hasOwn(context, 'requiredEncryption'), false);
    assert.equal(context.sql, sql);
  }
  const sql = '-- @encrypt: {"user_id":"user"}\n/*\n-- @encrypt: []\n*/\nSELECT 1;';
  assert.deepEqual(resolveStatementContext(sql, 0).encryption, { user_id: 'user' });
});

test('batch headers and steps accept and strip encryption directives without checking SQL columns', () => {
  const sql = [
    '-- @batch-script: ./params.ps1', '-- @batch-steps: ["写入"]', '-- @batch-init: ["设置"]',
    '-- @default-encrypt: {"user_id":"user"}',
    '-- @name: 设置', 'SET test.option=true;',
    '-- @name: 写入', '-- @encrypt: {"space_id":"space"}',
    'INSERT INTO target VALUES (${user_id});',
  ].join('\n');
  assert.deepEqual(readBatchDirectives(sql), { script: './params.ps1', steps: ['写入'], init: ['设置'] });
  const definition = readBatchDefinition(sql);
  assert.deepEqual(definition.init[0].encryption, { user_id: 'user' });
  assert.deepEqual(definition.init[0].requiredEncryption, []);
  assert.deepEqual(definition.steps[0].encryption, { user_id: 'user', space_id: 'space' });
  assert.deepEqual(definition.steps[0].requiredEncryption, ['space_id']);
  assert.equal(definition.init[0].sql, 'SET test.option=true;');
  assert.equal(definition.steps[0].sql, 'INSERT INTO target VALUES (${user_id});');
  assert.throws(() => readBatchDefinition(sql.replace('-- @encrypt:', '-- @default-encrypt:')), /第一条 SQL/);
});
