import type { Row } from './queryResults';

export type ExportFormat = 'tsv';

export function isExportFormat(value: unknown): value is ExportFormat {
  return value === 'tsv';
}

export const TSV_CHUNK_ROWS = 5_000;

export function toTsv(rows: Row[], columns: string[]): string {
  const blocks = [...toTsvBlocks(rows, columns, Math.max(rows.length, 1))];
  // Clipboard payloads keep the historical shape: no trailing separator.
  return blocks.join('').replace(/\r\n$/, '');
}

// Streams TSV in bounded blocks so exporting a large result set never has to
// build one giant string (V8 caps strings around 512MB).
export function* toTsvBlocks(
  rows: Row[],
  columns: string[],
  chunkRows: number = TSV_CHUNK_ROWS,
): Generator<string> {
  const separator = '\t';
  const encode = (value: unknown): string => {
    const text = displayValue(value);
    const needsQuotes = text.includes(separator) || /["\r\n]/.test(text);
    return needsQuotes ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const size = Number.isInteger(chunkRows) && chunkRows >= 1 ? chunkRows : TSV_CHUNK_ROWS;

  yield `${columns.map((column) => encode(column)).join(separator)}\r\n`;
  for (let index = 0; index < rows.length; index += size) {
    const chunk = rows.slice(index, index + size);
    yield `${chunk.map((row) => columns.map((column) => encode(row[column])).join(separator)).join('\r\n')}\r\n`;
  }
}

export function displayValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (Buffer.isBuffer(value)) {
    return `0x${value.toString('hex')}`;
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, jsonReplacer) ?? '';
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
