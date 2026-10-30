import { decryptValue, encryptValue, isEncryptedValue, type DataKey } from './fieldEncryption';
import type { DataKeys } from './dataKeys';
import type { Row } from './queryResults';
import type { RowSink } from './querySession';

export type DataMode = 'plain' | 'encrypted';
export interface ProtectionInfo {
  mode: DataMode;
  keyId: string;
  fields: Readonly<Record<string, string>>;
}
export interface ProtectionProjection {
  readonly mode: DataMode;
  readonly rules: Readonly<Record<string, string>>;
  readonly info: ProtectionInfo;
  value(name: string, value: unknown): unknown;
  row(row: Row): Row;
  parameters(values: Readonly<Record<string, string>>, input?: boolean): Record<string, string>;
  validate(columns: readonly string[], parameters: Readonly<Record<string, string>>, hasResultSet: boolean): void;
  withMode(mode: DataMode): ProtectionProjection;
}

let mode: DataMode = 'encrypted';
const listeners = new Set<() => void>();
export function getDataMode(): DataMode { return mode; }
export function setDataMode(next: DataMode): void {
  if (mode === next) return;
  mode = next;
  for (const listener of [...listeners]) listener();
}
export function onDataModeChange(listener: () => void): { dispose(): void } {
  listeners.add(listener);
  return { dispose: () => { listeners.delete(listener); } };
}

// Parameters remain verbatim SQL fragments, following the existing quoting
// contract. Ciphertext is decoded only for explicitly declared parameters.
export function parameterText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return Object.is(value, -0) ? '-0' : String(value);
  }
  if (value instanceof Date) return value.toISOString();
  throw new Error('此字段密文类型不能作为 SQL 参数。');
}

export async function loadParameterKeys(
  values: Readonly<Record<string, string | undefined>>, rules: Readonly<Record<string, string>>, keys: DataKeys,
): Promise<void> {
  for (const [name, value] of Object.entries(values)) {
    if (Object.hasOwn(rules, name) && isEncryptedValue(value)) await keys.loadToken(value);
  }
}

export function decodeParameter(
  name: string, value: string, rules: Readonly<Record<string, string>>, keys: Pick<DataKeys, 'lookup'>,
): string {
  return Object.hasOwn(rules, name) && isEncryptedValue(value)
    ? parameterText(decryptValue(value, (id) => keys.lookup(id), rules[name])) : value;
}

export function createProtection(
  rules: Readonly<Record<string, string>>, required: readonly string[], key: DataKey,
  lookup: (id: string) => DataKey | undefined, selectedMode: DataMode = getDataMode(),
): ProtectionProjection {
  const fields = Object.freeze(Object.fromEntries(Object.entries(rules)));
  const requiredFields = [...required];
  const snapshotKey = { id: key.id, material: Uint8Array.from(key.material) };
  const project = (current: DataMode): ProtectionProjection => {
    const value = (name: string, raw: unknown): unknown => current === 'encrypted' && Object.hasOwn(fields, name)
      ? encryptValue(raw, fields[name], snapshotKey) : raw;
    return Object.freeze({
      mode: current, rules: fields,
      info: Object.freeze({ mode: current, keyId: snapshotKey.id, fields }),
      value,
      row: (row: Row) => Object.fromEntries(Object.entries(row).map(([name, raw]) => [name, value(name, raw)])),
      parameters: (values: Readonly<Record<string, string>>, input = false) => Object.fromEntries(Object.entries(values).map(([name, raw]) => {
        // Only external inputs may be tokens. An already decoded string can
        // itself start with enc: and must never be interpreted a second time.
        const decoded = input && Object.hasOwn(fields, name) && isEncryptedValue(raw)
          ? decryptValue(raw, lookup, fields[name]) : raw;
        return [name, parameterText(value(name, decoded))];
      })),
      validate: (columns: readonly string[], parameters: Readonly<Record<string, string>>, hasResultSet: boolean) => {
        // A successful no-result write cannot be relabelled as failed because
        // it has no output columns. Required parameter keys are checked earlier.
        if (!hasResultSet) return;
        if (columns.some((column, index) => Object.hasOwn(fields, column) && columns.indexOf(column) !== index)) {
          throw new Error('受保护的结果列重名，请使用唯一 AS 别名。');
        }
        if (requiredFields.some((name) => !columns.includes(name) && !Object.hasOwn(parameters, name))) {
          throw new Error('局部 @encrypt 字段未匹配结果列或 SQL 参数，请核对字段名。');
        }
      },
      withMode: project,
    });
  };
  return project(selectedMode);
}

export function encryptedOutput(protection?: ProtectionProjection): boolean {
  return protection !== undefined && protection.mode === 'encrypted' && Object.keys(protection.rules).length > 0;
}

// Column metadata may arrive in an EventEmitter callback. Never throw from
// that callback: reject the next row, or check after execute for an empty set.
export function protectSink(
  target: RowSink, protection: ProtectionProjection | undefined,
  parameters: Readonly<Record<string, string>>, projectRows = true,
): { sink: RowSink; check(): void } {
  let columnError: unknown;
  const check = (): void => { if (columnError) throw columnError; };
  return {
    check,
    sink: {
      onColumns(columns) {
        try { protection?.validate(columns, parameters, true); }
        catch (error) { columnError = error; }
        target.onColumns(columns);
      },
      onRow(row) {
        check();
        return target.onRow(projectRows && protection ? protection.row(row) : row);
      },
      onAffectedRows: (count) => target.onAffectedRows(count),
    },
  };
}
export const PROTECTED_MATERIAL_NOTICE = '加密模式仅提供结构化反馈；SQL、计划和错误原文请切换到明文模式查看。';
