import type { RowSink } from './querySession';

export type Row = Record<string, unknown>;

export interface QueryResultView {
  // Rows kept for the panel, capped by maxResultRows. Copy uses these.
  rows: Row[];
  columns: string[];
  affectedRows: number;
  truncated: boolean;
  totalRows: number;
}

// A sink that keeps the first maxResultRows rows and counts the rest. Rows past
// the cap are never stored, so a result set costs memory in proportion to the
// cap rather than to the number of rows the server sent.
export interface RowCollector extends RowSink {
  // Rows read so far, including the discarded ones -- drives the progress line.
  totalRows(): number;
  toView(): QueryResultView;
}

export function createRowCollector(maxRows: number): RowCollector {
  const safeMaxRows = Number.isInteger(maxRows) && maxRows >= 1 ? maxRows : 1000;
  const kept: Row[] = [];
  let total = 0;
  let columns: string[] = [];
  let affectedRows = 0;

  return {
    onColumns(next) {
      columns = next;
    },
    onRow(row) {
      total += 1;
      if (kept.length < safeMaxRows) {
        kept.push(row);
      }
    },
    onAffectedRows(count) {
      affectedRows = count;
    },
    totalRows() {
      return total;
    },
    toView() {
      return {
        rows: kept,
        columns: columns.length > 0 ? columns : Object.keys(kept[0] ?? {}),
        affectedRows,
        truncated: total > kept.length,
        totalRows: total,
      };
    },
  };
}

// mysql2 carries column metadata as FieldPacket[] and raises its `fields` event
// before the first row. A statement that returns no result set raises it with
// `undefined` instead, which is how the MySQL adapter tells the two apart.
export function columnNamesFromFields(fields: unknown): string[] {
  if (!Array.isArray(fields)) {
    return [];
  }
  return fields
    .map((field) =>
      field && typeof field === 'object' ? String((field as { name?: unknown }).name ?? '') : '',
    )
    .filter(Boolean);
}

interface SqlStatementRange {
  start: number;
  end: number;
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
