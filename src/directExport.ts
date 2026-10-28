import { findSqlStatementRanges } from './queryResults';

// This is a routing guard for a result-file command, not a SQL permission
// system. Only result-producing forms belong here; writes keep their normal
// execution entry point. Inspect the resolved SQL too, since a parameter can
// change its structure.
export function assertDirectExportSql(sql: string): void {
  if (findSqlStatementRanges(sql).length !== 1) {
    throw new Error('执行并导出一次只接受一条 SQL，参数替换后也不能包含多条语句。');
  }
  const tokens = /--(?=\s|$)[^\r\n]*|#[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:\\[\s\S]|''|[^'\\])*'|"(?:\\[\s\S]|""|[^"\\])*"|`(?:\\[\s\S]|``|[^`\\])*`|[A-Za-z_][A-Za-z_0-9$]*|[^\s]/g;
  let depth = 0;
  const words: string[] = [];
  for (const match of sql.matchAll(tokens)) {
    const token = match[0];
    if (/^\/\*(?:!|M!)/i.test(token)) {
      throw new Error('执行并导出不支持可执行注释，请改成明确的查询语句。');
    }
    if (/^(?:--|#|\/\*|'|"|`)/.test(token)) continue;
    if (token === '(') depth += 1;
    else if (token === ')') depth -= 1;
    else if (depth === 0 && /^[A-Za-z_]/.test(token)) words.push(token.toUpperCase());
  }
  const first = words[0];
  const main = first === 'WITH'
    ? words.find((word) => /^(?:SELECT|INSERT|UPDATE|DELETE|MERGE|REPLACE)$/.test(word))
    : first;
  if (!main || !['SELECT', 'SHOW', 'DESC', 'DESCRIBE', 'EXPLAIN'].includes(main) || words.includes('INTO')) {
    throw new Error('执行并导出只支持 SELECT、WITH…SELECT、SHOW、DESCRIBE 和 EXPLAIN 等结果查询；写入语句请使用普通执行入口。');
  }
}
