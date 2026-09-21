import type { Row } from './queryResults';

// HiveServer2 (and therefore Spark Thrift Server) returns a statement's rows as
// TRowSet batches. Two encodings exist on the wire:
//
//   * column-oriented -- `<ColumnCode>{ values, nulls }` for every column, which
//     is what both Hive and Spark actually send;
//   * row-oriented -- `rows[].colVals[]`, the legacy form, kept here so a server
//     that uses it does not silently yield zero rows.
//
// This module is deliberately free of any driver or `vscode` import: the shapes
// are structural, so `node --test` can drive it with hand-built fixtures.

// The union member names used by TCLIService.TColumn. `hive-driver` does not
// re-export its ColumnCode enum from the package root, and the values are the
// literal strings themselves, so they are spelled out here.
const COLUMN_KEYS = [
  'binaryVal',
  'boolVal',
  'byteVal',
  'doubleVal',
  'i16Val',
  'i32Val',
  'i64Val',
  'stringVal',
] as const;

type ColumnKey = (typeof COLUMN_KEYS)[number];

export interface DecodedHiveResult {
  columns: string[];
  rows: Row[];
}

export interface ColumnDescriptor {
  name: string;
  position: number;
}

interface RawColumn {
  values?: unknown[];
  nulls?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object');
}

// --------------------------------------------------------------- schema

// Exported so the session can decode one fetch batch at a time instead of
// materialising the whole answer through decodeHiveResult below.
export function hiveColumnDescriptors(schema: unknown): ColumnDescriptor[] {
  const columns = isRecord(schema) && Array.isArray(schema.columns) ? schema.columns : [];
  return columns
    .map((column, index) => {
      const record = isRecord(column) ? column : {};
      const rawName = typeof record.columnName === 'string' ? record.columnName : '';
      const rawPosition = typeof record.position === 'number' ? record.position : index;
      return {
        // Hive prefixes a column with its table (`t.id`); the panel shows the
        // bare name, which is also what a `SELECT id` would give.
        name: rawName.split('.').pop() || rawName || `column_${index + 1}`,
        position: rawPosition,
      };
    })
    .sort((left, right) => left.position - right.position);
}

// --------------------------------------------------------------- decoding

// The null bitmap is LSB-first: bit `i % 8` of byte `i / 8`.
function isNullAt(nulls: unknown, index: number): boolean {
  if (!nulls || typeof nulls !== 'object') {
    return false;
  }
  const byte = (nulls as Record<number, number>)[Math.floor(index / 8)];
  if (typeof byte !== 'number') {
    return false;
  }
  return (byte & (1 << index % 8)) !== 0;
}

// BIGINT arrives as a node-int64 instance, which is a Buffer subclass whose
// toString() is overridden to give the decimal digits. Anything wider than
// Number.MAX_SAFE_INTEGER becomes a string rather than a lossy number.
function decodeInt64(value: unknown): unknown {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value !== 'string' && !isRecord(value)) {
    return value;
  }
  const text = typeof value === 'string' ? value : String(value);
  if (!/^-?\d+$/.test(text)) {
    return text;
  }
  const big = BigInt(text);
  return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(big)
    : text;
}

// TINYINT travels as a one-byte Buffer; it is signed.
function decodeTinyInt(value: unknown): unknown {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? value : parsed;
  }
  if (typeof value === 'object' && value !== null && 'length' in value) {
    const bytes = value as unknown as ArrayLike<number>;
    if (bytes.length === 1) {
      return (bytes[0] << 24) >> 24;
    }
  }
  return value;
}

export function decodeHiveValue(key: ColumnKey, value: unknown): unknown {
  switch (key) {
    case 'i64Val':
      return decodeInt64(value);
    case 'byteVal':
      return decodeTinyInt(value);
    // DECIMAL, DATE, TIMESTAMP and the complex types (ARRAY/MAP/STRUCT) all
    // arrive as strings, which is also the least surprising thing to export.
    default:
      return value;
  }
}

function readColumnValue(column: unknown): RawColumn | undefined {
  if (!isRecord(column)) {
    return undefined;
  }
  for (const key of COLUMN_KEYS) {
    const candidate = column[key];
    if (isRecord(candidate) && Array.isArray(candidate.values)) {
      return candidate as RawColumn;
    }
  }
  return undefined;
}

function columnKeyOf(column: unknown): ColumnKey | undefined {
  if (!isRecord(column)) {
    return undefined;
  }
  return COLUMN_KEYS.find((key) => isRecord(column[key]));
}

function decodeRowOrientedValue(cell: unknown): unknown {
  if (cell === null || cell === undefined) {
    return null;
  }
  if (!isRecord(cell)) {
    return cell;
  }
  for (const key of COLUMN_KEYS) {
    const holder = cell[key];
    if (isRecord(holder) && 'value' in holder) {
      return decodeHiveValue(key, holder.value);
    }
  }
  // A union that is not set is how row-oriented mode encodes NULL.
  return null;
}

function rowCountOf(columns: RawColumn[], rows: unknown[]): number {
  let count = rows.length;
  for (const column of columns) {
    count = Math.max(count, column.values?.length ?? 0);
  }
  return count;
}

function decodeColumnOrientedRowSet(
  columns: unknown[],
  descriptors: ColumnDescriptor[],
  rowCount: number,
): Row[] {
  const base = Math.min(...descriptors.map((descriptor) => descriptor.position));
  const nonNegativeBase = Number.isFinite(base) ? Math.max(base, 0) : 0;

  const readAt = (descriptor: ColumnDescriptor, index: number): unknown => {
    const offset = descriptor.position - nonNegativeBase;
    const column = columns[offset >= 0 && offset < columns.length ? offset : index];
    const raw = readColumnValue(column);
    if (!raw) {
      return null;
    }
    if (isNullAt(raw.nulls, index)) {
      return null;
    }
    const key = columnKeyOf(column);
    return key ? decodeHiveValue(key, raw.values?.[index]) : (raw.values?.[index] ?? null);
  };

  const rows: Row[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    const row: Row = {};
    for (const descriptor of descriptors) {
      row[descriptor.name] = readAt(descriptor, index);
    }
    rows.push(row);
  }
  return rows;
}

function decodeRowOrientedRowSet(rawRows: unknown[], descriptors: ColumnDescriptor[]): Row[] {
  return rawRows.map((rawRow) => {
    const row: Row = {};
    const colVals = isRecord(rawRow) && Array.isArray(rawRow.colVals) ? rawRow.colVals : [];
    descriptors.forEach((descriptor, index) => {
      row[descriptor.name] = decodeRowOrientedValue(colVals[index]);
    });
    return row;
  });
}

export function decodeHiveRowSet(rowSet: unknown, descriptors: ColumnDescriptor[]): Row[] {
  if (!isRecord(rowSet)) {
    return [];
  }
  const columns = Array.isArray(rowSet.columns) ? rowSet.columns : [];
  const rawRows = Array.isArray(rowSet.rows) ? rowSet.rows : [];
  const rowCount = rowCountOf(columns.map((column) => readColumnValue(column) ?? {}), rawRows);
  if (rowCount === 0) {
    return [];
  }
  if (columns.length > 0) {
    return decodeColumnOrientedRowSet(columns, descriptors, rowCount);
  }
  return decodeRowOrientedRowSet(rawRows, descriptors);
}

export function decodeHiveResult(schema: unknown, rowSets: readonly unknown[]): DecodedHiveResult {
  const descriptors = hiveColumnDescriptors(schema);
  const rows: Row[] = [];
  for (const rowSet of rowSets) {
    rows.push(...decodeHiveRowSet(rowSet, descriptors));
  }

  // Without a schema there are still values to show, so fall back to the keys
  // the rows already carry rather than rendering an empty table.
  const columns =
    descriptors.length > 0 ? descriptors.map((descriptor) => descriptor.name) : Object.keys(rows[0] ?? {});
  return { columns, rows };
}
