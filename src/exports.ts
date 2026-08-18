import type { Row } from './queryResults';

export type ExportFormat = 'csv' | 'json' | 'tsv';

export function isExportFormat(value: unknown): value is ExportFormat {
  return value === 'csv' || value === 'json' || value === 'tsv';
}

export function toJson(rows: Row[]): string {
  return JSON.stringify(rows, jsonReplacer, 2);
}

export function toDelimited(rows: Row[], columns: string[], separator: ',' | '\t'): string {
  const encode = (value: unknown): string => {
    const text = displayValue(value);
    const needsQuotes = separator === ',' || text.includes(separator) || /["\r\n]/.test(text);
    return needsQuotes ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [
    columns.map((column) => encode(column)).join(separator),
    ...rows.map((row) => columns.map((column) => encode(row[column])).join(separator)),
  ].join('\r\n');
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
