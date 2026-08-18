export type Row = Record<string, unknown>;

export interface QueryResultView {
  rows: Row[];
  columns: string[];
  affectedRows: number;
  truncated: boolean;
}

export function createQueryResultView(
  rawResult: unknown,
  rawFields: unknown,
  maxRows: number,
): QueryResultView {
  const safeMaxRows = Number.isInteger(maxRows) && maxRows >= 1 ? maxRows : 1000;
  const allRows = normalizeRows(rawResult);
  const fields = normalizeFields(rawFields);
  return {
    rows: allRows.slice(0, safeMaxRows),
    columns: fields.length > 0 ? fields : Object.keys(allRows[0] ?? {}),
    affectedRows: getAffectedRows(rawResult),
    truncated: allRows.length > safeMaxRows,
  };
}

export function hasMultipleStatements(sql: string): boolean {
  let quote: "'" | '"' | '`' | undefined;
  let lineComment = false;
  let blockComment = false;
  let separatorSeen = false;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];

    if (lineComment) {
      if (character === '\n' || character === '\r') {
        lineComment = false;
      }
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === '-' && next === '-' && (index + 2 >= sql.length || /\s/.test(sql[index + 2]))) {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '#') {
      lineComment = true;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === ';') {
      separatorSeen = true;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      if (separatorSeen) {
        return true;
      }
      quote = character;
      continue;
    }
    if (separatorSeen && !/\s/.test(character)) {
      return true;
    }
  }

  return false;
}

function normalizeRows(value: unknown): Row[] {
  const candidate = Array.isArray(value) && Array.isArray(value[0]) ? value[0] : value;
  if (!Array.isArray(candidate)) {
    return [];
  }
  return candidate.filter((row): row is Row => Boolean(row && typeof row === 'object' && !Array.isArray(row)));
}

function normalizeFields(value: unknown): string[] {
  const candidate = Array.isArray(value) && Array.isArray(value[0]) ? value[0] : value;
  if (!Array.isArray(candidate)) {
    return [];
  }
  return candidate
    .map((field) => (field && typeof field === 'object' ? String((field as { name?: unknown }).name ?? '') : ''))
    .filter(Boolean);
}

function getAffectedRows(value: unknown): number {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'affectedRows' in value) {
    const affectedRows = Number((value as { affectedRows?: unknown }).affectedRows ?? 0);
    return Number.isFinite(affectedRows) ? affectedRows : 0;
  }
  return 0;
}
