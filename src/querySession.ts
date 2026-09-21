import type { QueryOutcome } from './queryResults';

// Driver-agnostic surface the extension talks to. Both the MySQL/Doris driver
// (mysql2) and the Spark Thrift driver (hive-driver) implement this, so
// extension.ts never has to know which wire protocol is underneath.

export type { QueryOutcome };

// The extension owns a vscode.CancellationToken. Adapters only need to know
// whether cancellation was requested and to be told once when it happens --
// how a driver actually interrupts a statement differs per protocol (MySQL
// needs a second connection and KILL QUERY, HiveServer2 has CancelOperation).
export interface CancelSignal {
  readonly requested: boolean;
  onRequest(listener: () => void): { dispose(): void };
}

export interface QuerySession {
  execute(sql: string, signal: CancelSignal): Promise<QueryOutcome>;
  // Set once the underlying connection had to be torn down -- a cancel the
  // server would not honour, or a socket-level failure. The caller must drop
  // the session instead of reusing it.
  readonly broken: boolean;
  close(): Promise<void>;
}

// Raised when a statement was interrupted, so callers can report "已取消"
// instead of surfacing a driver error the user did not cause.
export class QueryCancelledError extends Error {
  public constructor(message = '查询已取消。') {
    super(message);
    this.name = 'QueryCancelledError';
  }
}

export function isQueryCancelled(error: unknown): boolean {
  return error instanceof QueryCancelledError;
}

// For statements that must run to completion no matter what (opening a session,
// the form's "测试连接"), where no token exists to listen to.
export const neverCancelled: CancelSignal = {
  requested: false,
  onRequest: () => ({ dispose: () => undefined }),
};
