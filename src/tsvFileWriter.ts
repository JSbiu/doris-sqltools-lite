import { randomUUID } from 'node:crypto';
import { link, lstat, open, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { encodeTsvHeader, encodeTsvRows, TSV_CHUNK_ROWS } from './exports';
import { QueryCancelledError } from './querySession';
import type { Row } from './querySession';

export interface TsvFileWriter {
  readonly temporaryPath: string;
  readonly rowsWritten: number;
  readonly cleanupWarning?: string;
  begin(): Promise<void>;
  onColumns(columns: string[]): void;
  write(row: Row): Promise<void>;
  finish(): Promise<number>;
  abort(): Promise<void>;
}

const MAX_BUFFER_BYTES = 1024 * 1024;

export function createTsvFileWriter(
  targetPath: string,
  options: {
    chunkRows: number;
    escapeFormulas: boolean;
    token: { readonly isCancellationRequested: boolean };
    onProgress?: (rows: number) => void;
  },
): TsvFileWriter {
  const destination = resolve(targetPath);
  const temporaryPath = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.partial`);
  const chunkRows = Number.isInteger(options.chunkRows) && options.chunkRows >= 1
    ? options.chunkRows : TSV_CHUNK_ROWS;
  const encodeOptions = { escapeFormulas: options.escapeFormulas };
  let file: FileHandle | undefined;
  let ownsTemporary = false;
  let state: 'new' | 'open' | 'published' | 'aborted' = 'new';
  let columns: string[] | undefined;
  let columnsSeen = false;
  let columnError: Error | undefined;
  let headerWritten = false;
  let buffer: string[] = [];
  let bufferedBytes = 0;
  let rowsWritten = 0;
  let cleanupWarning: string | undefined;
  let pending: Promise<unknown> | undefined;
  let aborting = false;
  let failed = false;
  let failure: unknown;

  function checkCancellation(): void {
    if (options.token.isCancellationRequested) {
      throw new QueryCancelledError();
    }
  }

  function checkColumns(): string[] {
    checkCancellation();
    if (columnError) {
      throw columnError;
    }
    if (!columns) {
      throw new Error('SQL 未返回列信息，无法保存 TSV 文件。');
    }
    return columns;
  }

  function requireOpen(): void {
    if (state !== 'open' || !file) {
      throw new Error('请先 await begin()，并在 finish()/abort() 前写入 TSV 文件。');
    }
  }

  // The caller awaits each write, so disk latency supplies backpressure. Reject
  // overlapping operations instead of building an unbounded promise/row queue.
  function run<T>(action: () => Promise<T>): Promise<T> {
    if (pending || aborting) {
      return Promise.reject(new Error('请等待上一次 TSV 文件操作完成；已中止的写入器不能复用。'));
    }
    const operation = Promise.resolve().then(() => {
      if (failed) {
        throw failure;
      }
      return action();
    }).catch((error: unknown) => {
      failed = true;
      failure = error;
      throw error;
    }).finally(() => {
      pending = undefined;
    });
    pending = operation;
    return operation;
  }

  async function append(text: string, rowCount: number): Promise<void> {
    checkColumns();
    await file!.writeFile(text, 'utf8');
    rowsWritten += rowCount;
    if (rowCount > 0) {
      options.onProgress?.(rowsWritten);
    }
    checkColumns();
  }

  async function ensureHeader(): Promise<void> {
    if (!headerWritten) {
      await append(encodeTsvHeader(checkColumns(), encodeOptions), 0);
      headerWritten = true;
    }
  }

  async function flush(): Promise<void> {
    if (buffer.length === 0) {
      return;
    }
    const text = buffer.join('');
    const rowCount = buffer.length;
    buffer = [];
    bufferedBytes = 0;
    await append(text, rowCount);
  }

  function cleanupError(error: unknown): Error {
    return new Error(`无法清理 TSV 临时文件 ${temporaryPath}：${String(error)}`, { cause: error });
  }

  return {
    get temporaryPath() { return temporaryPath; },
    get rowsWritten() { return rowsWritten; },
    get cleanupWarning() { return cleanupWarning; },

    begin() {
      return run(async () => {
        if (state !== 'new') {
          throw new Error('TSV 文件写入器只能 begin() 一次。');
        }
        checkCancellation();
        const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') {
            throw error;
          }
          return undefined;
        });
        if (existing) {
          throw Object.assign(new Error(`目标文件已存在：${destination}`), { code: 'EEXIST' });
        }
        checkCancellation();
        file = await open(temporaryPath, 'wx', 0o600);
        ownsTemporary = true;
        state = 'open';
        checkCancellation();
      });
    },

    onColumns(nextColumns) {
      // mysql2 invokes this in an event callback: validation must never throw
      // there or perform asynchronous IO. The next write/finish reports it.
      if (columnsSeen) {
        columnError ??= new Error('SQL 返回了多个结果集，不能合并保存为一个 TSV 文件。');
        return;
      }
      columnsSeen = true;
      if (!Array.isArray(nextColumns) || nextColumns.length === 0
        || nextColumns.some((column) => typeof column !== 'string')) {
        columnError = new Error('SQL 返回了空或无效的列名数组，无法保存 TSV 文件。');
      } else if (new Set(nextColumns).size !== nextColumns.length) {
        columnError = new Error('SQL 返回了重复列名；请使用唯一 AS 别名后再保存 TSV 文件。');
      } else {
        columns = nextColumns.slice();
      }
    },

    write(row) {
      return run(async () => {
        requireOpen();
        const currentColumns = checkColumns();
        await ensureHeader();
        const text = encodeTsvRows([row], currentColumns, encodeOptions);
        const bytes = Buffer.byteLength(text, 'utf8');
        if (bufferedBytes + bytes > MAX_BUFFER_BYTES) {
          await flush();
        }
        if (bytes >= MAX_BUFFER_BYTES) {
          await append(text, 1);
        } else {
          buffer.push(text);
          bufferedBytes += bytes;
          if (buffer.length >= chunkRows || bufferedBytes >= MAX_BUFFER_BYTES) {
            await flush();
          }
        }
      });
    },

    finish() {
      return run(async () => {
        if (state === 'published') {
          return rowsWritten;
        }
        requireOpen();
        checkColumns();
        await ensureHeader();
        await flush();
        await file!.close();
        file = undefined;
        checkColumns();
        // link is exclusive (including existing/dangling symlinks) and is the
        // commit point. Never check cancellation after it has succeeded.
        await link(temporaryPath, destination);
        state = 'published';
        try {
          await unlink(temporaryPath);
          ownsTemporary = false;
        } catch (error) {
          cleanupWarning = cleanupError(error).message;
        }
        return rowsWritten;
      });
    },

    async abort() {
      aborting = true;
      await pending?.catch(() => undefined);
      buffer = [];
      bufferedBytes = 0;
      try {
        if (file) {
          await file.close();
          file = undefined;
        }
        if (ownsTemporary) {
          await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') {
              throw error;
            }
          });
          ownsTemporary = false;
        }
      } catch (error) {
        throw cleanupError(error);
      }
      if (state !== 'published') {
        state = 'aborted';
      }
    },
  };
}
