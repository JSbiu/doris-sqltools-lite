// Pure helpers for the "default export directory" flow.
// Deliberately free of any `vscode` import so `node --test` can require the
// compiled output directly (see tests/export-path.test.js).
import { dirname, extname, isAbsolute, resolve } from 'node:path';

// Treats missing, blank, and non-string values as "not configured" so clearing
// the setting falls back to the save dialog instead of writing to a bogus path.
export function normalizeExportDirectory(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function buildExportFileName(title: string, extension: string, now: Date): string {
  const safeTitle = title.replace(/[^a-z0-9_-]+/gi, '_') || 'query';
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  return `query_${safeTitle}_${timestamp}.${extension}`;
}

// @output names a literal filesystem path. Relative paths belong to the SQL
// file, never to the extension host's working directory or another workspace.
export function resolveOutputPath(value: string, sourceFile?: string): string {
  const target = value.trim();
  if (!target || /[\0\r\n]/.test(target) || /\$\{/.test(target)) {
    throw new Error('@output 请填写实际 TSV 文件路径，暂不支持路径参数替换。');
  }
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(target) || extname(target).toLowerCase() !== '.tsv') {
    throw new Error('执行并导出只支持文件系统中的 .tsv 文件，请检查输出路径。');
  }
  if (process.platform === 'win32' && (/^[a-z]:[^\\/]/i.test(target) || /^[\\/](?![\\/])/.test(target))) {
    throw new Error('输出路径不能只指定盘符或当前盘根目录，请使用完整绝对路径或相对 SQL 文件的路径。');
  }
  if (!isAbsolute(target) && (!sourceFile || !isAbsolute(sourceFile))) {
    throw new Error('相对 @output 路径需要先保存为本地 SQL 文件，或改用绝对路径。');
  }
  const resolved = isAbsolute(target) ? resolve(target) : resolve(dirname(sourceFile!), target);
  if (process.platform === 'win32' && resolved.replace(/^[a-z]:/i, '').split(/[\\/]+/).some((part) =>
    /[<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('输出路径含 Windows 不支持的文件名或设备名，请修改后重试。');
  }
  return resolved;
}
