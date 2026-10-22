const assert = require('node:assert/strict');
const test = require('node:test');
const { buildExplainSql, planText, buildPlanReview } = require('../out/executionPlan');

test('explain selects the engine syntax without rewriting or adding LIMIT to the SQL', () => {
  const sql = "-- query\nWITH t AS (SELECT ';' AS x) SELECT * FROM t;";
  for (const [engine, prefix] of [['Spark', 'EXPLAIN FORMATTED'], ['Doris', 'EXPLAIN VERBOSE'], ['MySQL', 'EXPLAIN']]) {
    assert.equal(buildExplainSql(sql, engine), prefix + '\n' + sql);
  }
  assert.equal(buildExplainSql('SELECT * FROM t LIMIT 5;', 'Spark'), 'EXPLAIN FORMATTED\nSELECT * FROM t LIMIT 5;');
});

test('explain refuses multiple statements and existing EXPLAIN / ANALYZE input', () => {
  for (const sql of ['', 'SELECT 1; SELECT 2;', 'EXPLAIN SELECT 1;', '-- note\n/* note */ EXPLAIN ANALYZE SELECT 1;', 'DESC t;']) {
    assert.throws(() => buildExplainSql(sql, 'Spark'));
  }
});

test('plan text preserves indentation, line breaks and every row beyond the display limit', () => {
  const rows = Array.from({ length: 1200 }, (_, i) => ({ plan: `  +- node ${i}\n     detail` }));
  const text = planText(['plan'], rows);
  assert.ok(text.startsWith('  +- node 0\n     detail'));
  assert.ok(text.endsWith('  +- node 1199\n     detail'));
  assert.equal(planText(['id', 'Extra'], [{ id: 1, Extra: 'Using index' }]), 'id\tExtra\n1\tUsing index');
});

test('review is a snapshot with SQL, parameters and full plan, using safe Markdown fences', () => {
  const snapshot = {
    name: '订单', source: 'file:///queries.sql:6', connectionName: 'Spark数仓', databaseType: 'Spark',
    parameters: { day: '2026-10-21' }, sql: "SELECT '```' AS x;", explainSql: "EXPLAIN FORMATTED\nSELECT '```' AS x;",
    plan: '  +- Scan\n     Filter', generatedAt: '2026-10-22T00:00:00.000Z',
  };
  const review = buildPlanReview(snapshot);
  assert.ok(review.includes('````sql\n' + snapshot.sql + '\n````'));
  for (const text of [snapshot.source, snapshot.connectionName, snapshot.parameters.day, snapshot.plan, '未追加预览 LIMIT', '审核后由用户执行']) {
    assert.ok(review.includes(text));
  }
});
