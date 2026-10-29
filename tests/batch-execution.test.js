const assert = require('node:assert/strict');
const test = require('node:test');
const {
  readBatchDefinition, parseBatchParameters, prepareBatchTask, createBatchFeedback, runBatchTask,
} = require('../out/batchExecution');
const { QueryCancelledError } = require('../out/querySession');
const { buildSqlFeedback } = require('../out/sqlFeedback');

const connection = { id: 'warehouse', name: '测试连接', type: 'Spark' };
const sql = [
  '-- @default-connection: 测试连接', '-- @default-param: day = file',
  '-- @batch-script: ./params.ps1', '-- @batch-steps: ["清理", "回填"]', '-- @batch-init: ["设置"]',
  '-- @name: 设置', 'SET test.option=true;',
  '-- @name: 不执行', 'DELETE FROM unrelated;',
  '-- @name: 清理', '-- @param: day = statement', "DELETE FROM target WHERE dt='${day=inline}';",
  '-- @name: 回填', "INSERT INTO target SELECT '${day}';",
].join('\n');
const params = [{ day: '2024-02-29' }, { day: '2024-03-01' }];
const prepare = (document = sql, values = params) => prepareBatchTask(readBatchDefinition(document), values, () => connection);
const signal = () => ({ requested: false, reason: undefined, onRequest: () => ({ dispose() {} }) });

test('parameter arrays preserve leap days, month boundaries, hourly windows and scalar values', () => {
  assert.deepEqual(parseBatchParameters('\uFEFF' + JSON.stringify([
    { day: '2024-02-29', start: '2024-02-29 23:00:00', end: '2024-03-01 00:00:00', n: 0, flag: false },
    { day: '2024-03-01' },
  ])), [
    { day: '2024-02-29', start: '2024-02-29 23:00:00', end: '2024-03-01 00:00:00', n: '0', flag: 'false' },
    { day: '2024-03-01' },
  ]);
  for (const text of ['noise\n[]', '[]', '{}', '[null]', '[[]]', '[{"bad name":"x"}]',
    '[{"a":null}]', '[{"a":{}}]', '[{"a":[]}]', '[{"a":""}]', '[{"a":1e999}]']) {
    assert.throws(() => parseBatchParameters(text));
  }
  assert.deepEqual(parseBatchParameters('[{}]'), [{}]);
});

test('batch selection rejects absent/duplicate/overlapping names and outputs before execution', () => {
  for (const document of [
    sql.replace('["清理", "回填"]', '["missing"]'),
    sql.replace('-- @name: 回填', '-- @name: 清理'),
    sql.replace('["清理", "回填"]', '["清理", "清理"]'),
    sql.replace('["设置"]', '["清理"]'),
    sql.replace('-- @name: 回填', '-- @name: 回填\n-- @output: a.tsv'),
    sql.replace('-- @batch-steps: ["清理", "回填"]', '-- @batch-steps: []'),
  ]) assert.throws(() => readBatchDefinition(document));
});

test('all parameters, including the last batch and initialization, are checked before a task starts', () => {
  assert.throws(() => prepare(sql.replace("SELECT '${day}'", "SELECT '${extra}'")), /第 1 批.*extra/);
  assert.throws(() => prepare(sql.replace('-- @default-param: day = file\n', '')
    .replace('-- @param: day = statement\n', '').replace('${day=inline}', '${day}'), [{ day: 'ok' }, {}]), /第 2 批/);
  assert.throws(() => prepare(sql.replace('SET test.option=true', 'SET test.option=${init}')), /设置.*init/);
  assert.throws(() => prepare(sql, [{ day: "x'; DELETE FROM other; -- " }]), /一条 SQL/);
  assert.throws(() => prepare(sql, Array.from({ length: 5000 }, () => ({ day: 'x' }))), /10000/);
});

test('batch values override local, file and inline defaults and never update the input', async () => {
  const values = [{ day: 'batch' }];
  const task = prepare(sql, values);
  values[0].day = 'later edit';
  const feedback = createBatchFeedback(task);
  const sent = [];
  assert.equal(await runBatchTask(task, feedback, signal(), async (step, statement, record) => {
    record.submitted = true;
    sent.push(statement);
    return { hasResultSet: false, rowsRead: 0, affectedRows: null };
  }), 'success');
  assert.deepEqual(sent, ['SET test.option=true;', "DELETE FROM target WHERE dt='batch';", "INSERT INTO target SELECT 'batch';"]);
  assert.equal(feedback.completedBatches, 1);
  assert.equal(feedback.records[1].parameters.day, 'batch');
  const defaults = createBatchFeedback(prepare(sql, [{}]));
  assert.equal(defaults.records[1].parameters.day, 'statement');
  assert.equal(defaults.records[2].parameters.day, 'file');
  assert.equal(createBatchFeedback(prepare(sql.replace('-- @default-param: day = file\n', '')
    .replace("SELECT '${day}'", "SELECT '${day=inline}'"), [{}])).records[2].parameters.day, 'inline');
});

test('initialization runs once and every batch and step awaits previous completion', async () => {
  const task = prepare();
  const feedback = createBatchFeedback(task);
  const order = [];
  let active = 0;
  assert.equal(await runBatchTask(task, feedback, signal(), async (step, statement, record) => {
    assert.equal(active++, 0);
    record.submitted = true;
    order.push([record.phase, record.batchIndex, step.name, statement]);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return { hasResultSet: false, rowsRead: 0, affectedRows: step.name === '设置' ? null : 0 };
  }), 'success');
  assert.deepEqual(order.map((item) => item[2]), ['设置', '清理', '回填', '清理', '回填']);
  assert.deepEqual(order.map((item) => item[1]), [undefined, 1, 1, 2, 2]);
  assert.ok(!order.some((item) => item[3].includes('unrelated')));
  assert.equal(feedback.completedBatches, 2);
  assert.equal(feedback.records[0].affectedRows, null);
});

test('a successful DELETE and failed INSERT leave the exact completed range without retry', async () => {
  const task = prepare();
  const feedback = createBatchFeedback(task);
  const sent = [];
  assert.equal(await runBatchTask(task, feedback, signal(), async (step, statement, record) => {
    record.submitted = true;
    record.sessionState = 'retained';
    sent.push(step.name);
    if (step.name === '回填') {
      record.sessionState = 'lost';
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    }
    return { hasResultSet: false, rowsRead: 0, affectedRows: 2 };
  }), 'failed');
  assert.deepEqual(sent, ['设置', '清理', '回填']);
  assert.deepEqual(feedback.records.map((record) => record.status), ['success', 'success', 'failed', 'not-run', 'not-run']);
  assert.equal(feedback.completedBatches, 0);
  assert.equal(feedback.records[2].needsReview, true);
});

test('cancellation awaits current execution cleanup and keeps later records unsubmitted', async () => {
  const task = prepare();
  const feedback = createBatchFeedback(task);
  const cancel = signal();
  let cleanupFinished = false;
  assert.equal(await runBatchTask(task, feedback, cancel, async (_step, _statement, record) => {
    record.submitted = true;
    cancel.requested = true;
    await new Promise((resolve) => setImmediate(resolve));
    cleanupFinished = true;
    throw new QueryCancelledError();
  }), 'cancelled');
  assert.equal(cleanupFinished, true);
  assert.equal(feedback.records[0].status, 'cancelled');
  assert.equal(feedback.records[0].needsReview, true);
  assert.ok(feedback.records.slice(1).every((record) => record.status === 'not-run' && !record.submitted));
  const untouched = createBatchFeedback(task);
  assert.equal(await runBatchTask(task, untouched, cancel, () => assert.fail('cancelled task submitted SQL')), 'cancelled');
  assert.ok(untouched.records.every((record) => record.status === 'not-run'));
});

test('session loss after an acknowledged statement preserves its success but stops all following steps', async () => {
  const task = prepare();
  const feedback = createBatchFeedback(task);
  assert.equal(await runBatchTask(task, feedback, signal(), async (_step, _statement, record) => {
    record.submitted = true;
    record.sessionState = 'lost';
    return { hasResultSet: false, rowsRead: 0, affectedRows: 0 };
  }), 'failed');
  assert.equal(feedback.records[0].status, 'success');
  assert.equal(feedback.records[0].needsReview, undefined);
  assert.match(feedback.error, /已完成.*已断开/);
  assert.ok(feedback.records.slice(1).every((record) => record.status === 'not-run'));
});

test('unexpected result sets stop a batch task and compact feedback whitelists every step', async () => {
  const task = prepare();
  const batch = createBatchFeedback(task);
  assert.equal(await runBatchTask(task, batch, signal(), async (_step, _statement, record) => {
    record.submitted = true;
    return { hasResultSet: true, rowsRead: 0, affectedRows: null };
  }), 'failed');
  batch.records[0].sql = 'SECRET_SQL_BODY';
  batch.records[0].error = 'problem\n    at privateStack';
  const text = buildSqlFeedback({
    name: '批次', connectionName: connection.name, databaseType: 'Spark', parameters: {},
    source: { path: '/queries.sql', startLine: 1, endLine: 12, savedAtExecution: true, changedSinceExecution: false },
    action: 'batch', status: 'failed', submitted: true, generatedAt: '', durationMs: 1, batch,
  });
  assert.ok(text.includes('not-run'));
  assert.ok(text.includes('batchIndex'));
  assert.ok(!text.includes('SECRET_SQL_BODY'));
  assert.ok(!text.includes('privateStack'));
  assert.ok(!text.includes('DELETE FROM target'));
});
