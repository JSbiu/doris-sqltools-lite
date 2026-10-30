const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { buildSqlFeedback, buildBatchReport, hasBatchDetails } = require('../out/sqlFeedback.js');

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

test('protection metadata is explicitly whitelisted and cannot carry key material', () => {
  const input = feedback({ dataMode: 'encrypted', protection: {
    mode: 'encrypted', keyId: 'public-id', fields: { id: 'user' }, material: 'secret-key-material',
  } });
  const text = buildSqlFeedback(input);
  assert.deepEqual(contents(text).protection, { mode: 'encrypted', keyId: 'public-id', fields: { id: 'user' } });
  assert.ok(!text.includes('secret-key-material'));
});

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

function batchFeedback(count = 3) {
  const record = (name, batchIndex) => ({
    phase: batchIndex === undefined ? 'init' : 'batch', batchIndex, name,
    connectionName: name === '回填' ? 'Spark数仓' : '本地 Doris',
    databaseType: name === '回填' ? 'Spark' : 'Doris',
    parameters: batchIndex === undefined ? {} : { day: `day-${batchIndex}` },
    startLine: name === '回填' ? 20 : 8, endLine: name === '回填' ? 25 : 9,
    status: 'success', submitted: true, durationMs: 7, affectedRows: null, sessionState: 'retained',
  });
  return feedback({
    action: 'batch', databaseType: null, batchReportFile: 'D:\\reports\\orders.batch-report.json',
    batch: { script: 'D:\\queries\\params.ps1', batchCount: count, completedBatches: count,
      initSteps: ['会话设置'], steps: ['清理', '回填'], records: [record('会话设置'),
        ...Array.from({ length: count }, (_, index) => [record('清理', index + 1), record('回填', index + 1)]).flat()] },
  });
}

test('batch summaries keep fixed-size endpoint samples and reports retain all records at 1, 180 and 1000 batches', () => {
  const lengths = [];
  for (const count of [1, 180, 1000]) {
    const input = batchFeedback(count);
    const markdown = buildSqlFeedback(input);
    const data = contents(markdown);
    const report = JSON.parse(buildBatchReport(input));
    assert.equal(data.batch.records, undefined);
    assert.equal(data.batchReportFile, input.batchReportFile);
    assert.equal(data.batch.steps.length, 3);
    assert.equal(data.batch.firstBatch.batchIndex, 1);
    assert.equal(data.batch.firstBatch.steps[0].parameters.day, 'day-1');
    assert.equal(data.batch.firstBatch.steps[0].submitted, true);
    assert.equal(data.batch.lastBatch?.batchIndex, count === 1 ? undefined : count);
    assert.equal(data.batch.stopped, undefined);
    assert.equal(report.batch.records.length, 1 + count * 2);
    assert.deepEqual(report.batch.records.at(-1), input.batch.records.at(-1));
    assert.equal(hasBatchDetails(input), true);
    lengths.push(markdown.length);
  }
  assert.ok(lengths[2] - lengths[1] < 100, 'more batches do not append per-batch records to the summary');
});

test('a failed INSERT summary identifies its successful DELETE and leaves last-batch samples explicitly unsubmitted', () => {
  const input = batchFeedback();
  input.status = 'failed';
  input.batch.completedBatches = 0;
  Object.assign(input.batch.records[2], { status: 'failed', needsReview: true, sessionState: 'lost', error: '连接断开' });
  for (const record of input.batch.records.slice(3)) Object.assign(record, { status: 'not-run', submitted: false });
  const data = contents(buildSqlFeedback(input));
  assert.equal(data.batch.stopped.name, '回填');
  assert.equal(data.batch.stopped.batchIndex, 1);
  assert.deepEqual(data.batch.stopped.parameters, { day: 'day-1' });
  assert.deepEqual(data.batch.stopped.completedSteps, ['清理']);
  assert.deepEqual(data.batch.stopped.needsReviewSteps, ['回填']);
  assert.ok(data.batch.lastBatch.steps.every((step) => step.status === 'not-run' && !step.submitted));
  assert.equal(data.batch.steps.find((step) => step.name === '回填').startLine, 20);
});

test('summaries distinguish initialization failure, cancellation between steps, and success followed by session loss', () => {
  const initialization = batchFeedback();
  initialization.status = 'failed';
  Object.assign(initialization.batch.records[0], { status: 'failed', error: '初始化失败' });
  assert.equal(contents(buildSqlFeedback(initialization)).batch.stopped.phase, 'init');

  const cancelled = batchFeedback();
  cancelled.status = 'cancelled';
  for (const record of cancelled.batch.records.slice(2)) Object.assign(record, { status: 'not-run', submitted: false });
  const interrupted = contents(buildSqlFeedback(cancelled)).batch.stopped;
  assert.equal(interrupted.name, '回填');
  assert.equal(interrupted.status, 'not-run');
  assert.equal(interrupted.submitted, false);
  assert.deepEqual(interrupted.completedSteps, ['清理']);

  const lost = batchFeedback();
  lost.status = 'failed';
  lost.batch.error = '语句已完成，但会话已断开';
  lost.batch.records[0].sessionState = 'lost';
  const stopped = contents(buildSqlFeedback(lost)).batch.stopped;
  assert.equal(stopped.status, 'success');
  assert.equal(stopped.sessionState, 'lost');
  assert.equal(stopped.error, lost.batch.error);
});

test('reports whitelist every level, redact diagnostics and retain actual parameters and unknown row counts', () => {
  const input = batchFeedback(1);
  const secret = randomUUID();
  input.sql = 'excluded-long-sql';
  input.batch.sql = 'excluded-batch-sql';
  Object.assign(input.batch.records[1], {
    sql: 'excluded-step-sql', password: secret, error: `password=${secret}; ` + '错'.repeat(3000),
    parameters: Object.fromEntries([['__proto__', '参数值'], ['day', '2026-10-29']]),
  });
  const text = buildBatchReport(input);
  const report = JSON.parse(text);
  for (const omitted of [secret, input.sql, input.batch.sql, input.batch.records[1].sql]) assert.ok(!text.includes(omitted));
  assert.equal(report.batch.records[1].parameters.__proto__, '参数值');
  assert.equal(report.batch.records[1].affectedRows, null);
  assert.ok(report.batch.records[1].error.length <= 2000);
  assert.match(report.batch.records[1].error, /已截断/);
});

test('tasks that submitted no SQL do not require detailed report files', () => {
  const input = batchFeedback(1);
  input.submitted = false;
  input.batchReportFile = undefined;
  for (const record of input.batch.records) Object.assign(record, { status: 'not-run', submitted: false });
  assert.equal(hasBatchDetails(input), false);
  assert.equal(hasBatchDetails(feedback({ action: 'batch', submitted: false })), false);
  assert.ok(!buildSqlFeedback(input).includes('完整批次报告尚未保存'));
});
