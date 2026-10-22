import type { DatabaseType } from './connectionSecurity';
import { displayValue } from './exports';
import { findSqlStatementRanges, type Row } from './queryResults';

export interface PlanSnapshot {
  name: string;
  source: string;
  connectionName: string;
  databaseType: DatabaseType;
  parameters: Readonly<Record<string, string>>;
  sql: string;
  explainSql: string;
  plan: string;
  generatedAt: string;
}

export function buildExplainSql(sql: string, type: DatabaseType): string {
  const ranges = findSqlStatementRanges(sql);
  if (ranges.length !== 1) throw new Error('查看计划一次只接受一条 SQL。');
  const leading = sql.slice(ranges[0].start).replace(/^(?:\s+|--[^\r\n]*(?:\r?\n|$)|#[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)+/, '');
  if (/^(?:explain|desc(?:ribe)?)\b/i.test(leading)) {
    throw new Error('请把光标放在原 SQL 上查看计划，无需手动添加 EXPLAIN。');
  }
  const prefix = type === 'Spark' ? 'EXPLAIN FORMATTED' : type === 'Doris' ? 'EXPLAIN VERBOSE' : 'EXPLAIN';
  // A newline keeps a leading -- comment from swallowing the actual statement.
  return `${prefix}\n${sql}`;
}

export function planText(columns: readonly string[], rows: readonly Row[]): string {
  const lines = rows.map((row) => columns.map((column) => displayValue(row[column])).join('\t'));
  if (columns.length > 1) lines.unshift(columns.join('\t'));
  return lines.join('\n');
}

function fenced(text: string, language: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

export function buildPlanReview(snapshot: PlanSnapshot): string {
  return [
    `# SQL 执行计划审核：${snapshot.name.replace(/[\r\n]/g, ' ')}`,
    '',
    fenced(JSON.stringify({
      source: snapshot.source,
      connection: snapshot.connectionName,
      engine: snapshot.databaseType,
      generatedAt: snapshot.generatedAt,
      parameters: snapshot.parameters,
    }, null, 2), 'json'),
    '',
    '## 实际解析的 SQL', '', fenced(snapshot.sql, 'sql'), '',
    '## 计划请求', '', fenced(snapshot.explainSql, 'sql'), '',
    '## 完整执行计划', '', fenced(snapshot.plan, 'text'), '',
    '## 审核要求', '',
    '请结合 SQL、参数及执行计划检查：分区裁剪与扫描范围、过滤下推、Join 条件与方式、Shuffle / Exchange、排序与聚合，以及明显的笛卡尔积和数据膨胀。',
    '先指出有计划证据的问题，再给出修改建议；缺少统计信息或表结构时明确说明，勿把估算当作实际运行结果。',
    '本次按原 SQL 生成计划，未追加预览 LIMIT；普通查询预览可能自动追加 LIMIT，计划可能不同。',
    '材料记录的是生成时的 SQL、参数和连接；任一内容或会话设置变化后请重新生成计划。审核后由用户执行原 SQL。',
    '',
  ].join('\n');
}
