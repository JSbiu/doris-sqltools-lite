const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { buildSqlFeedback } = require('../out/sqlFeedback.js');

function feedback(overrides = {}) {
  return {
    name: '订单明细',
    connectionName: '本地 Doris',
    databaseType: 'Doris',
    parameters: { day: '2026-10-28', region: '华东' },
    source: {
      path: 'D:\\queries\\orders.sql', startLine: 8, endLine: 16,
      savedAtExecution: true, changedSinceExecution: false,
    },
    action: 'query', status: 'success', submitted: true,
    generatedAt: '2026-10-28T08:00:00.000Z', durationMs: 42,
    ...overrides,
  };
}

function contents(markdown) {
  assert.ok(markdown.startsWith('# SQL 执行反馈\n\n'));
  const block = /^```json\n([^\n]*)\n```$/m.exec(markdown);
  assert.ok(block, 'feedback contains one compact, parseable JSON block');
  return JSON.parse(block[1]);
}

test('whitelists feedback and source fields without serializing SQL, plans, rows or connection credentials', () => {
  const expected = feedback();
  const input = Object.freeze({
    ...expected,
    parameters: Object.freeze(expected.parameters),
    source: Object.freeze({ ...expected.source, sql: 'nested SQL must stay out' }),
    sql: "SELECT 'sql-body-must-stay-out';".repeat(10000),
    plan: 'plan-body-must-stay-out', rows: [{ detail: 'result-row-must-stay-out' }],
    host: 'unlisted.example.invalid', username: 'unlisted-account', password: randomUUID(),
    stack: 'unlisted-stack',
  });
  const markdown = buildSqlFeedback(input);

  assert.deepEqual(contents(markdown), expected);
  for (const omitted of ['sql-body-must-stay-out', 'nested SQL', input.plan, input.rows[0].detail,
    input.host, input.username, input.password, input.stack]) {
    assert.ok(!markdown.includes(omitted), omitted);
  }
  assert.equal(markdown.split(expected.name).length - 1, 1);
});

test('query and explain use the same common fields and reference the plan by path', () => {
  const query = contents(buildSqlFeedback(feedback()));
  const explain = contents(buildSqlFeedback(feedback({
    action: 'explain', explainKind: 'EXPLAIN VERBOSE', planFile: 'D:\\reports\\orders.plan.md',
  })));
  const { action: queryAction, ...queryCommon } = query;
  const { action: explainAction, explainKind, planFile, ...explainCommon } = explain;

  assert.equal(queryAction, 'query');
  assert.equal(explainAction, 'explain');
  assert.equal(explainKind, 'EXPLAIN VERBOSE');
  assert.equal(planFile, 'D:\\reports\\orders.plan.md');
  assert.deepEqual(queryCommon, explainCommon);
});

test('unknown totals stay null even when a successful preview has read some rows', () => {
  const input = feedback({
    rowsRead: 11, totalRows: null, displayedRows: 10, readComplete: false,
    truncated: true, previewLimit: 10, sessionState: 'retained',
  });
  const markdown = buildSqlFeedback(input);

  assert.deepEqual(contents(markdown), input);
  assert.match(markdown, /`totalRows=null`：总行数未知/);
});

test('complete exports report exact counts and only reference the full result file', () => {
  const input = feedback({
    action: 'export', rowsRead: 120000, totalRows: 120000, displayedRows: 0,
    readComplete: true, truncated: false, affectedRows: 0,
    resultFile: 'D:\\reports\\orders.full.tsv', sessionState: 'retained',
  });
  const markdown = buildSqlFeedback({ ...input, rows: [{ value: 'full-result-body' }] });

  assert.deepEqual(contents(markdown), input);
  assert.ok(!markdown.includes('full-result-body'));
  assert.ok(!markdown.includes('总行数未知'));
  const empty = feedback({ rowsRead: 0, totalRows: 0, displayedRows: 0, readComplete: true });
  assert.deepEqual(contents(buildSqlFeedback(empty)), empty);
});

test('preparation failures and cancellations preserve unknown database type and submitted=false', () => {
  for (const status of ['failed', 'cancelled']) {
    const input = feedback({
      status, submitted: false, databaseType: null, durationMs: 0, sessionState: 'not-opened',
      source: { path: 'untitled:SQL-1', startLine: 1, endLine: 1,
        savedAtExecution: false, changedSinceExecution: null },
    });
    const markdown = buildSqlFeedback(input);

    assert.deepEqual(contents(markdown), input);
    assert.match(markdown, /`databaseType=null`：数据库类型未知/);
    assert.ok(!markdown.includes('MySQL'));
    assert.ok(!markdown.includes('success'));
  }
});

test('submitted failures and cancellations retain partial counts and temporary paths without claiming completion', () => {
  for (const status of ['failed', 'cancelled']) {
    const input = feedback({
      action: 'export', status, rowsRead: 12, totalRows: null, readComplete: false,
      temporaryFile: 'D:\\reports\\orders.tsv.partial', sessionState: 'lost',
    });
    const markdown = buildSqlFeedback(input);

    assert.deepEqual(contents(markdown), input);
    assert.ok(!markdown.includes('success'));
    assert.ok(!markdown.includes('resultFile'));
    assert.match(markdown, /总行数未知/);
  }
});

test('source notes agree with every saved and changed state and preserve line ranges', () => {
  for (const savedAtExecution of [true, false]) {
    for (const changedSinceExecution of [true, false, null]) {
      const source = {
        path: 'D:\\queries\\orders.sql', startLine: 3, endLine: 25,
        savedAtExecution, changedSinceExecution,
      };
      const markdown = buildSqlFeedback(feedback({ source }));

      assert.deepEqual(contents(markdown).source, source);
      assert.equal(markdown.includes('当时来源未保存'), !savedAtExecution);
      assert.equal(markdown.includes('来源在执行后已改动'), changedSinceExecution === true);
      assert.equal(markdown.includes('当前来源尚未核对'), changedSinceExecution === null);
    }
  }
});

test('Markdown characters and prototype-like parameter keys preserve the actual values without injecting structure', () => {
  const parameters = Object.fromEntries([
    ['__proto__', '原型名也是参数'], ['constructor', '构造参数'], ['toString', '字符串参数'],
    ['hasOwnProperty', '原键名'], ['toJSON', '正常参数值'],
    ['region.code', '  华东\\分区 "A"  '],
    ['filter', 'token=business-value'],
    ['markdown', '```json\n{"injected":true}\n```\n# 伪标题 *强调* [链接](x) <tag>'],
  ]);
  Object.setPrototypeOf(parameters, { inherited: 'not-an-actual-parameter' });
  const input = Object.freeze(feedback({
    name: '订单 *每日* [明细](x) `名称`\n# 伪标题',
    connectionName: '<连接> [本地](x)', parameters: Object.freeze(parameters),
    source: Object.freeze(feedback().source),
  }));
  const markdown = buildSqlFeedback(input);
  const parsed = contents(markdown);

  assert.equal(parsed.name, input.name);
  assert.equal(parsed.connectionName, input.connectionName);
  assert.deepEqual(Object.entries(parsed.parameters), Object.entries(parameters));
  assert.equal(Object.hasOwn(parsed.parameters, '__proto__'), true);
  assert.equal(Object.hasOwn(parsed.parameters, 'inherited'), false);
  assert.equal(markdown.match(/^#/gm).length, 1);
  assert.equal(markdown.match(/^```/gm).length, 2);
  assert.ok(!markdown.includes('not-an-actual-parameter'));
});

test('error and warning are redacted, explicitly truncated and bounded to 2000 characters each', () => {
  const secret = randomUUID();
  const markdown = buildSqlFeedback(feedback({
    status: 'failed',
    error: `password=${secret}; mysql://placeholder:${secret}@example.invalid/demo; ` + '错误详情 '.repeat(600),
    warning: `api_key=${secret}; token=${secret}; pwd=${secret}; ` + '警告详情 '.repeat(600),
  }));
  const parsed = contents(markdown);

  assert.ok(!markdown.includes(secret));
  for (const message of [parsed.error, parsed.warning]) {
    assert.ok(message.length <= 2000);
    assert.match(message, /\[redacted\]/);
    assert.match(message, /已截断/);
  }
});

test('redaction happens before truncation so long credentials cannot leak a partial value', () => {
  const parsed = contents(buildSqlFeedback(feedback({
    error: `password="${randomUUID().repeat(250)}"; 读取失败`,
    warning: '短警告',
  })));

  assert.equal(parsed.error, 'password=[redacted]; 读取失败');
  assert.equal(parsed.warning, '短警告');
  const exact = '错'.repeat(2000);
  assert.equal(contents(buildSqlFeedback(feedback({ error: exact }))).error, exact);
});

test('messages keep multiline diagnostics but omit supplied stack frames and attached stack properties', () => {
  const secret = randomUUID();
  const markdown = buildSqlFeedback(feedback({
    status: 'failed',
    error: '读取失败\r\n请检查列名\r\n    at runQuery (runner.js:12:3)\r\n    at main (runner.js:1:1)',
    warning: `IDENTIFIED BY '${secret}'\n\tat org.example.Driver.run(Driver.java:42)`,
    stack: 'attached stack must stay out',
  }));
  const parsed = contents(markdown);

  assert.equal(parsed.error, '读取失败\r\n请检查列名');
  assert.equal(parsed.warning, 'IDENTIFIED BY [redacted]');
  for (const text of ['runner.js', 'Driver.java', 'attached stack', secret]) {
    assert.ok(!markdown.includes(text));
  }
});
