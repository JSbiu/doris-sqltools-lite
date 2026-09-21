import type { Row } from './queryResults';

export type ExportFormat = 'tsv';

export function isExportFormat(value: unknown): value is ExportFormat {
  return value === 'tsv';
}

export const TSV_CHUNK_ROWS = 5_000;

export interface TsvEncodeOptions {
  // Neutralise spreadsheet formulas. On unless explicitly disabled: a result set
  // routinely carries user-controlled text, and pasting it into a spreadsheet
  // would otherwise execute it.
  escapeFormulas?: boolean;
}

// A cell starting with one of these is evaluated as a formula by Excel,
// LibreOffice and Google Sheets, which is how exported data becomes a DDE
// payload. `=` and `@` are unambiguous triggers. `+` and `-` are declared in the
// OWASP rule too, but escaping every negative number would turn plain numerics
// into text in the spreadsheet, so a signed value that is just a number is left
// alone.
const FORMULA_PREFIX = /^[=@]/;
const SIGN_PREFIX = /^[+-]/;
const PLAIN_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

export function needsFormulaEscape(value: string): boolean {
  if (!value) {
    return false;
  }
  if (FORMULA_PREFIX.test(value)) {
    return true;
  }
  return SIGN_PREFIX.test(value) && !PLAIN_NUMBER.test(value);
}

// The apostrophe is the "treat as text" marker spreadsheets understand; they
// hide it inside the cell, so the displayed value is unchanged.
export function escapeSpreadsheetFormula(value: string): string {
  return needsFormulaEscape(value) ? `'${value}` : value;
}

export function toTsv(rows: Row[], columns: string[], options: TsvEncodeOptions = {}): string {
  // Clipboard payloads keep the historical shape: no trailing separator. The
  // row cap means this is never asked to build a huge string.
  const blocks = [...toTsvBlocks(rows, columns, Math.max(rows.length, 1), options)];
  return blocks.join('').replace(/\r\n$/, '');
}

// Streams TSV in bounded blocks so exporting a large result set never has to
// build one giant string (V8 caps strings around 512MB).
export function* toTsvBlocks(
  rows: Row[],
  columns: string[],
  chunkRows: number = TSV_CHUNK_ROWS,
  options: TsvEncodeOptions = {},
): Generator<string> {
  const separator = '\t';
  const escapeFormulas = options.escapeFormulas !== false;
  const encode = (value: unknown): string => {
    const displayed = displayValue(value);
    const text = escapeFormulas ? escapeSpreadsheetFormula(displayed) : displayed;
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
