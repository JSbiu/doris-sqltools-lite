const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildErrorCopy,
  buildPlanCopy,
  buildResultCopy,
  buildSqlReference,
} = require('../out/outputCopy');

const source = { path: 'D:\\queries\\orders.sql', startLine: 12, endLine: 24, saved: true };
const context = {
  name: '订单汇总',
  connectionName: '分析 Doris',
  databaseType: 'Doris',
  database: 'analytics',
  parameters: { biz_date: '2026-10-30' },
  durationMs: 842,
  source,
  sql: 'SELECT * FROM orders',
};

test('saved SQL uses a Codex-compatible file reference and no SQL body', () => {
  const reference = buildSqlReference(context);
  assert.match(reference, /\[orders\.sql:12-24\]\(D:\/queries\/orders\.sql:12\)/);
  assert.doesNotMatch(reference, /SELECT/);
});

test('unsaved SQL falls back to a marked SQL block', () => {
  const reference = buildSqlReference({
    ...context,
    source: { path: '', startLine: 3, endLine: 3, saved: false },
  });
  assert.match(reference, /未保存 SQL/);
  assert.match(reference, /```sql\nSELECT \* FROM orders\n```/);
});

test('origin result is pure TSV and extra result adds facts without SQL body', () => {
  const rows = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];
  const columns = ['id', 'name'];
  assert.equal(buildResultCopy({
    mode: 'origin', rows, columns, context, totalRows: 2, readComplete: true, truncated: false,
  }), 'id\tname\r\n1\tA\r\n2\tB');

  const extra = buildResultCopy({
    mode: 'extra', rows, columns, context, totalRows: 2, readComplete: true, truncated: false,
  });
  assert.match(extra, /订单汇总 · Doris · 分析 Doris/);
  assert.match(extra, /\[orders\.sql:12-24\]/);
  assert.match(extra, /参数: biz_date=2026-10-30/);
  assert.match(extra, /耗时: 842 ms/);
  assert.match(extra, /结果: 2 行 × 2 列（完整）/);
  assert.doesNotMatch(extra, /^列:/m);
  assert.equal((extra.match(/id\tname/g) ?? []).length, 1, 'TSV header is the only column definition');
  assert.match(extra, /id\tname\r\n1\tA\r\n2\tB/);
  assert.doesNotMatch(extra, /SELECT \* FROM orders/);
});

test('plan origin is pure plan text and extra carries facts, not the explain request or checklist', () => {
  const plan = 'PLAN FRAGMENT 0\n  TABLE: orders';
  assert.equal(buildPlanCopy({ mode: 'origin', plan, context }), plan);
  const extra = buildPlanCopy({ mode: 'extra', plan, context });
  assert.match(extra, /\[orders\.sql:12-24\]/);
  assert.match(extra, /计划:\nPLAN FRAGMENT 0/);
  assert.doesNotMatch(extra, /EXPLAIN VERBOSE/);
  assert.doesNotMatch(extra, /审核要求/);
  assert.doesNotMatch(extra, /分区裁剪/);
});

test('error copy contains the reference and error without SQL body', () => {
  const text = buildErrorCopy({ context, error: 'Unknown column x' });
  assert.match(text, /\[orders\.sql:12-24\]/);
  assert.match(text, /错误: Unknown column x/);
  assert.doesNotMatch(text, /SELECT \* FROM orders/);
});
