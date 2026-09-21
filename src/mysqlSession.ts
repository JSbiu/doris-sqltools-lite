import type mysql from 'mysql2/promise';
import type { ConnectionProfile } from './connectionSecurity';
import { isConnectionFailure } from './connectionDiagnostics';
import { createMysqlConnection } from './mysqlConnect';
import { columnNamesFromFields, type Row } from './queryResults';
import {
  QueryCancelledError,
  type CancelSignal,
  type QuerySession,
  type QuerySummary,
  type RowSink,
} from './querySession';

// If the server never acknowledges a KILL QUERY (Doris KILL semantics vary by
// version), fall back to tearing the socket down after this long.
const CANCEL_FALLBACK_TIMEOUT_MS = 5_000;

export async function openMysqlSession(
  profile: ConnectionProfile,
  password: string,
): Promise<QuerySession> {
  const connection = await createMysqlConnection(profile, password);
  return new MysqlSession(profile, password, connection);
}

// mysql2/promise hides the callback-style connection behind `.connection`, and
// its own query() always passes a callback -- which sends the driver down the
// branch that accumulates every row internally instead of emitting it. Reaching
// the raw connection is therefore the only way to stream, and its type is not
// re-exported, so the shape actually used is declared here.
export interface MysqlRowStream extends AsyncIterable<unknown> {
  on(event: 'fields', listener: (fields: unknown) => void): unknown;
}

interface RawMysqlConnection {
  query(sql: string): { stream(): MysqlRowStream };
}

export function rawConnectionOf(connection: mysql.Connection): RawMysqlConnection {
  return (connection as unknown as { connection: RawMysqlConnection }).connection;
}

// Drains a result set into the sink, holding at most one row at a time. Split
// out of the session so it can be exercised against a plain Readable, with no
// server involved.
export async function consumeMysqlStream(
  stream: MysqlRowStream,
  sink: RowSink,
  isCancelled: () => boolean,
): Promise<QuerySummary> {
  let hasResultSet = false;
  let affectedRows = 0;
  let rowsRead = 0;

  // mysql2 raises `fields` before the first row. A statement that returns no
  // result set raises it with `undefined` instead, and the single item that
  // follows is its ResultSetHeader, not data -- that is how the two cases are
  // told apart.
  stream.on('fields', (fields) => {
    if (Array.isArray(fields)) {
      hasResultSet = true;
      sink.onColumns(columnNamesFromFields(fields));
    }
  });

  for await (const item of stream) {
    if (isCancelled()) {
      // Keep draining rather than breaking out: tearing the stream down while
      // the server is still sending leaves unread packets on the connection,
      // and they would be parsed as the answer to the next statement. KILL
      // QUERY stops the server; the caller destroys the socket if it does not.
      continue;
    }
    if (!hasResultSet) {
      affectedRows = affectedRowCount(item);
      continue;
    }
    rowsRead += 1;
    const pending = sink.onRow(item as Row);
    if (pending) {
      await pending;
    }
  }

  if (!hasResultSet) {
    sink.onAffectedRows(affectedRows);
  }
  return { rowsRead, affectedRows };
}

function affectedRowCount(header: unknown): number {
  if (header && typeof header === 'object' && 'affectedRows' in header) {
    const value = Number((header as { affectedRows?: unknown }).affectedRows ?? 0);
    return Number.isFinite(value) ? value : 0;
  }
  return 0;
}

class MysqlSession implements QuerySession {
  private invalid = false;
  private closed = false;

  public constructor(
    private readonly profile: ConnectionProfile,
    private readonly password: string,
    private readonly connection: mysql.Connection,
  ) {}

  public get broken(): boolean {
    return this.invalid || this.closed;
  }

  public async execute(sql: string, signal: CancelSignal, sink: RowSink): Promise<QuerySummary> {
    let cancelled = false;
    let settled = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

    const subscription = signal.onRequest(() => {
      cancelled = true;
      // Cancelling a MySQL statement means killing it from another connection,
      // because this one is parked on the result stream.
      if (!this.connection.threadId) {
        this.invalid = true;
        this.connection.destroy();
        return;
      }
      void this.killRunningQuery().then((killed) => {
        if (!killed) {
          this.invalid = true;
          this.connection.destroy();
          return;
        }
        fallbackTimer = setTimeout(() => {
          if (!settled) {
            this.invalid = true;
            this.connection.destroy();
          }
        }, CANCEL_FALLBACK_TIMEOUT_MS);
      });
    });

    try {
      const stream = rawConnectionOf(this.connection).query(sql).stream();
      const summary = await consumeMysqlStream(stream, sink, () => cancelled);
      if (cancelled) {
        throw new QueryCancelledError();
      }
      return summary;
    } catch (error) {
      if (isConnectionFailure(error)) {
        this.invalid = true;
      }
      // A cancel that arrived mid-flight surfaces as a driver error; report it
      // as a cancellation so the user does not see a scary failure toast.
      if (cancelled && !(error instanceof QueryCancelledError)) {
        throw new QueryCancelledError();
      }
      throw error;
    } finally {
      settled = true;
      if (fallbackTimer !== undefined) {
        clearTimeout(fallbackTimer);
      }
      subscription.dispose();
    }
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.invalid = true;
    await this.connection.end().catch(() => undefined);
  }

  // A short-lived second connection used to KILL the running statement without
  // tearing down the session the user is working in (USE / temp tables / session
  // variables survive). Returns false when the caller must fall back to
  // destroying the connection.
  private async killRunningQuery(): Promise<boolean> {
    const threadId = this.connection.threadId;
    if (!threadId) {
      return false;
    }

    let control: mysql.Connection | undefined;
    try {
      control = await createMysqlConnection(this.profile, this.password, { omitDatabase: true });
      await control.query(`KILL QUERY ${threadId}`);
      return true;
    } catch {
      return false;
    } finally {
      await control?.end().catch(() => undefined);
    }
  }
}
