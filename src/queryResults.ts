export type Row = Record<string, unknown>;

export interface QueryResultView {
  rows: Row[];
  columns: string[];
  affectedRows: number;
  truncated: boolean;
}

interface SqlStatementRange {
  start: number;
  end: number;
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
  return findSqlStatementRanges(sql).length > 1;
}

export function findSqlStatementAtOffset(sql: string, offset: number): string | undefined {
  const ranges = findSqlStatementRanges(sql);
  if (ranges.length === 0) {
    return undefined;
  }

  const safeOffset = Math.max(0, Math.min(Number.isFinite(offset) ? offset : 0, sql.length));
  const containing = ranges.find((range) => safeOffset >= range.start && safeOffset < range.end);
  if (containing) {
    return sql.slice(containing.start, containing.end);
  }

  const nearest = ranges.reduce((best, candidate) => {
    const bestDistance = distanceFromRange(safeOffset, best);
    const candidateDistance = distanceFromRange(safeOffset, candidate);
    return candidateDistance < bestDistance ? candidate : best;
  });
  return sql.slice(nearest.start, nearest.end);
}

function findSqlStatementRanges(sql: string): SqlStatementRange[] {
  let quote: "'" | '"' | '`' | undefined;
  let lineComment = false;
  let blockComment = false;
  let statementStart = 0;
  const ranges: SqlStatementRange[] = [];

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
        if (next === quote) {
          index += 1;
        } else {
          quote = undefined;
        }
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
      appendStatementRange(ranges, sql, statementStart, index + 1);
      statementStart = index + 1;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
    }
  }

  appendStatementRange(ranges, sql, statementStart, sql.length);
  return ranges;
}

function appendStatementRange(
  ranges: SqlStatementRange[],
  sql: string,
  rawStart: number,
  rawEnd: number,
): void {
  const raw = sql.slice(rawStart, rawEnd);
  if (!hasExecutableSql(raw)) {
    return;
  }

  const leadingWhitespace = raw.match(/^\s*/)?.[0].length ?? 0;
  const trailingWhitespace = raw.match(/\s*$/)?.[0].length ?? 0;
  ranges.push({
    start: rawStart + leadingWhitespace,
    end: Math.max(rawStart + leadingWhitespace, rawEnd - trailingWhitespace),
  });
}

function hasExecutableSql(sql: string): boolean {
  let lineComment = false;
  let blockComment = false;

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
    if (!/\s/.test(character) && character !== ';') {
      return true;
    }
  }

  return false;
}

function distanceFromRange(offset: number, range: SqlStatementRange): number {
  if (offset < range.start) {
    return range.start - offset;
  }
  if (offset >= range.end) {
    return offset - range.end;
  }
  return 0;
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
