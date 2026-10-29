import { findSqlStatementRanges, type SqlStatementRange } from './queryResults';
import { isParameterName } from './sqlParameters';

export interface StatementContext {
  sql: string;
  name?: string;
  connection?: string;
  output?: string;
  parameters: Record<string, string>;
  line: number;
  endLine: number;
}

interface Header {
  defaults: Record<string, string>;
  parameters: Record<string, string>;
  defaultConnection?: string;
  connection?: string;
  name?: string;
  output?: string;
  batchScript?: string;
  batchSteps?: string[];
  batchInit?: string[];
  removals: SqlStatementRange[];
}

// Only leading, standalone -- comments carry directives. Text inside a string,
// a block comment or the SQL body must never change the selected connection.
function readHeader(sql: string, fileDefaults: boolean): Header {
  const header: Header = { defaults: {}, parameters: {}, removals: [] };
  const seen = new Set<string>();
  let index = 0;
  while (index < sql.length) {
    if (/\s|\uFEFF/.test(sql[index])) {
      index += 1;
      continue;
    }
    if (sql.startsWith('/*', index)) {
      const end = sql.indexOf('*/', index + 2);
      if (end < 0) break;
      index = end + 2;
      continue;
    }
    if (sql[index] === '#') {
      const end = sql.indexOf('\n', index);
      index = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (!sql.startsWith('--', index) || !/\s|$/.test(sql[index + 2] ?? '')) break;
    const newline = sql.indexOf('\n', index);
    const end = newline < 0 ? sql.length : newline + 1;
    const comment = sql.slice(index, end).trimEnd();
    if (/^--\s*@/.test(comment)) {
      const match = /^--\s*@([a-z-]+):\s*(.*)$/.exec(comment);
      if (!match) throw new Error(`SQL 注释格式错误：${comment}`);
      const [, key, value] = match;
      if (!['default-connection', 'default-param', 'connection', 'param', 'name', 'output',
        'batch-script', 'batch-steps', 'batch-init'].includes(key)) {
        throw new Error(`未知 SQL 注释 @${key}。`);
      }
      if ((key.startsWith('default-') || key.startsWith('batch-')) && !fileDefaults) {
        throw new Error(`@${key} 只能写在文件第一条 SQL 之前。`);
      }
      let unique = key;
      if (key === 'param' || key === 'default-param') {
        const parameter = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(value);
        if (!parameter || !isParameterName(parameter[1]) || !parameter[2].trim()) {
          throw new Error(`@${key} 应写成 参数名 = 值，值不能为空。`);
        }
        unique += ':' + parameter[1];
        Object.defineProperty(key === 'param' ? header.parameters : header.defaults, parameter[1], {
          value: parameter[2].trim(), enumerable: true, configurable: true,
        });
      } else {
        if (!value.trim()) throw new Error(`@${key} 不能为空。`);
        if (key === 'name') header.name = value.trim();
        if (key === 'output') header.output = value.trim();
        if (key === 'connection') header.connection = value.trim();
        if (key === 'default-connection') header.defaultConnection = value.trim();
        if (key === 'batch-script') header.batchScript = value.trim();
        if (key === 'batch-steps') header.batchSteps = batchNames(value, key);
        if (key === 'batch-init') header.batchInit = batchNames(value, key);
      }
      if (seen.has(unique)) throw new Error(`重复的 SQL 注释 @${unique}。`);
      seen.add(unique);
      header.removals.push({ start: index, end });
    }
    index = end;
  }
  return header;
}

function batchNames(value: string, key: string): string[] {
  let names: unknown;
  try { names = JSON.parse(value); } catch { /* Report the directive, not JSON internals. */ }
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string' || !name.trim())) {
    throw new Error(`@${key} 应为 SQL 名称的 JSON 数组，例如 ["清理当天", "回填当天"]。`);
  }
  if (new Set(names).size !== names.length) throw new Error(`@${key} 中的名称不能重复。`);
  return names;
}

export function readBatchDirectives(document: string): { script: string; steps: string[]; init: string[] } {
  const first = findSqlStatementRanges(document)[0];
  if (!first) throw new Error('没有可分批执行的 SQL。');
  const header = readHeader(document.slice(first.start, first.end), true);
  if (!header.batchScript || !header.batchSteps?.length) {
    throw new Error('分批执行需要在文件头声明 @batch-script 和非空的 @batch-steps。');
  }
  const init = header.batchInit ?? [];
  if (init.some((name) => header.batchSteps!.includes(name))) {
    throw new Error('@batch-init 和 @batch-steps 不能包含同一个 SQL 名称。');
  }
  return { script: header.batchScript, steps: header.batchSteps, init };
}

function withoutDirectives(sql: string, header: Header): string {
  for (const range of [...header.removals].reverse()) {
    sql = sql.slice(0, range.start) + sql.slice(range.end);
  }
  return sql.trim();
}

// Selection offsets refer to the original document. Even when just the SELECT
// is selected, its preceding directives still apply. Crossing a statement
// boundary is rejected instead of guessing which connection should win.
export function resolveStatementContext(
  document: string,
  start: number,
  end: number = start,
): StatementContext | undefined {
  const ranges = findSqlStatementRanges(document);
  if (!ranges.length) return undefined;
  start = Math.max(0, Math.min(document.length, start));
  end = Math.max(start, Math.min(document.length, end));
  const selected = ranges.filter((range) => start < range.end && end > range.start);
  if (end > start && selected.length > 1) throw new Error('当前一次只支持执行一条 SQL，请分开选择后再执行。');
  const range = selected[0]
    ?? ranges.find((candidate) => start >= candidate.start && start < candidate.end)
    ?? ranges.reduce((best, candidate) => {
    const distance = (item: SqlStatementRange): number =>
      start < item.start ? item.start - start : start >= item.end ? start - item.end : 0;
    return distance(candidate) < distance(best) ? candidate : best;
  });
  const first = readHeader(document.slice(ranges[0].start, ranges[0].end), true);
  const header = range === ranges[0] ? first : readHeader(document.slice(range.start, range.end), false);
  const raw = end > start ? document.slice(start, end) : document.slice(range.start, range.end);
  const sql = withoutDirectives(raw, readHeader(raw, range === ranges[0]));
  if (!findSqlStatementRanges(sql).length) return undefined;
  return {
    sql,
    name: header.name,
    connection: header.connection ?? first.defaultConnection,
    output: header.output,
    parameters: { ...first.defaults, ...header.parameters },
    line: document.slice(0, end > start ? start : range.start).split('\n').length,
    endLine: document.slice(0, Math.max(0, (end > start ? end : range.end) - 1)).split('\n').length,
  };
}

export function findDirectiveConnection<T extends { id: string; name: string }>(
  profiles: readonly T[], reference: string,
): T {
  const byId = profiles.find((profile) => profile.id === reference);
  if (byId) return byId;
  const matches = profiles.filter((profile) => profile.name === reference);
  if (matches.length === 0) throw new Error(`SQL 注释指定的连接「${reference}」不存在，请检查连接名称或 ID。`);
  if (matches.length > 1) throw new Error(`连接名称「${reference}」不唯一，请在 SQL 注释中使用连接 ID。`);
  return matches[0];
}
