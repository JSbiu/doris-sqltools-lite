import type { DatabaseType } from './connectionSecurity';
import type { CopyMode } from './copyMode';
import { toTsv } from './exports';
import type { Row } from './queryResults';

export interface OutputSource {
  path: string;
  startLine: number;
  endLine: number;
  saved: boolean;
}

export interface OutputCopyContext {
  name: string;
  connectionName?: string;
  databaseType?: DatabaseType | null;
  database?: string;
  parameters?: Readonly<Record<string, string>>;
  durationMs?: number;
  generatedAt?: string;
  protectionFields?: Readonly<Record<string, string>>;
  source?: OutputSource;
  sql?: string;
}

export interface ResultCopyInput {
  mode: CopyMode;
  rows: readonly Row[];
  columns: readonly string[];
  context: OutputCopyContext;
  totalRows: number;
  readComplete: boolean;
  truncated: boolean;
}

export interface PlanCopyInput {
  mode: CopyMode;
  plan: string;
  context: OutputCopyContext;
}

export interface ErrorCopyInput {
  context: OutputCopyContext;
  error: string;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.max(0, durationMs)} ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 2 : 1)} s`;
}

export function formatSourceReference(source: OutputSource): string {
  const range = source.startLine === source.endLine
    ? `${source.startLine}` : `${source.startLine}-${source.endLine}`;
  if (!source.saved || !source.path) return `未保存 SQL · L${range}`;
  const fileName = source.path.split(/[\\/]/).pop() || source.path;
  const target = source.path.replace(/\\/g, '/');
  return `[${fileName.replace(/\]/g, '\\]')}:${range}](${target}:${source.startLine})`;
}

function contextLines(context: OutputCopyContext): string[] {
  const title = [context.name, context.databaseType, context.connectionName]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(' · ');
  const lines = [title];
  if (context.source) lines.push(formatSourceReference(context.source));
  if (context.database) lines.push(`数据库: ${context.database}`);
  const parameters = Object.entries(context.parameters ?? {});
  if (parameters.length > 0) {
    lines.push(`参数: ${parameters.map(([name, value]) => `${name}=${value}`).join(' · ')}`);
  }
  if (context.durationMs !== undefined) lines.push(`耗时: ${formatDuration(context.durationMs)}`);
  const protectedFields = Object.entries(context.protectionFields ?? {});
  if (protectedFields.length > 0) {
    lines.push(`保护字段: ${protectedFields.map(([name, domain]) => `${name}(${domain})`).join(' · ')}`);
  }
  if (context.generatedAt) lines.push(`生成: ${context.generatedAt}`);
  return lines;
}

function unsavedSqlLines(context: OutputCopyContext): string[] {
  if (context.source?.saved === true || !context.sql) return [];
  return ['', '```sql', context.sql, '```'];
}

export function buildSqlReference(context: OutputCopyContext): string {
  const title = [context.name, context.databaseType]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(' · ');
  return [title, context.source ? formatSourceReference(context.source) : '未保存 SQL', ...unsavedSqlLines(context)]
    .join('\n');
}

export function buildResultCopy(input: ResultCopyInput): string {
  const text = toTsv([...input.rows], [...input.columns]);
  if (input.mode === 'origin') return text;

  const resultLine = input.truncated
    ? input.readComplete
      ? `结果: 已加载 ${input.rows.length} 行，查询共 ${input.totalRows} 行（面板截断）`
      : `结果: 已加载 ${input.rows.length} 行，结果未读完`
    : `结果: ${input.rows.length} 行 × ${input.columns.length} 列（完整）`;
  const lines = [...contextLines(input.context), resultLine];
  lines.push('', text);
  return lines.join('\n');
}

export function buildPlanCopy(input: PlanCopyInput): string {
  if (input.mode === 'origin') return input.plan;
  return [...contextLines(input.context), '', '计划:', input.plan].join('\n');
}

export function buildErrorCopy(input: ErrorCopyInput): string {
  const lines = [...contextLines(input.context), `错误: ${input.error}`];
  lines.push(...unsavedSqlLines(input.context));
  return lines.join('\n');
}
