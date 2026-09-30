import type mysql from 'mysql2/promise';
import type { ConnectionProfile } from './connectionSecurity';
import { isConnectionFailure } from './connectionDiagnostics';
import { createMysqlConnection } from './mysqlConnect';
import { QueryIdleTimeoutError, createIdleGuard, settleWithin } from './idleGuard';
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

// How long the answer may go quiet before the connection is presumed dead. The
// clock only starts once rows have started arriving, so this never fires for a
// slow statement -- see idleGuard.ts. Five minutes is far longer than any gap a
// live MySQL/Doris server leaves mid-result.
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

// How long the goodbye may take. Only a connection that is already gone will
// ever hit this -- see close() below.
const CLOSE_TIMEOUT_MS = 2_000;

export async function openMysqlSession(
  profile: ConnectionProfile,
  password: string,
  idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS,
): Promise<QuerySession> {
  const connection = await createMysqlConnection(profile, password);
  return new MysqlSession(profile, password, connection, idleTimeoutMs);
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
  // Filled in as the stream is read. Passed in rather than returned so the
  // counts survive an interruption: a stop part-way through leaves the caller
  // with an accurate "read this many rows" instead of nothing at all.
  summary: QuerySummary = { rowsRead: 0, affectedRows: 0 },
  // Called once per item that arrives, which is the only proof available that
  // the socket is still alive -- the caller's idle guard is armed and reset
  // from here. Deliberately not called for `fields`: that fires before the
  // answer starts, and a statement still working has sent nothing at all.
  onActivity?: () => void,
): Promise<QuerySummary> {
  let hasResultSet = false;

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
    onActivity?.();
    if (isCancelled()) {
      // Keep draining rather than breaking out: tearing the stream down while
      // the server is still sending leaves unread packets on the connection,
      // and they would be parsed as the answer to the next statement. KILL
      // QUERY stops the server; the caller destroys the socket if it does not.
      continue;
    }
    if (!hasResultSet) {
      summary.affectedRows = affectedRowCount(item);
      continue;
    }
    summary.rowsRead += 1;
    const pending = sink.onRow(item as Row);
    if (pending) {
      await pending;
    }
  }

  if (!hasResultSet) {
    sink.onAffectedRows(summary.affectedRows);
  }
  return summary;
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
    private readonly idleTimeoutMs: number,
  ) {}

  public get broken(): boolean {
    return this.invalid || this.closed;
  }

  public async execute(sql: string, signal: CancelSignal, sink: RowSink): Promise<QuerySummary> {
    let cancelled = false;
    let settled = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

    // Not a query timeout: this only starts counting once the answer has begun
    // arriving, so a statement that is merely slow never trips it. What it
    // catches is a socket that goes away without a FIN -- the read loop would
    // otherwise be parked on it forever, holding the "this file is running"
    // flag and leaving the progress notification spinning with no way out.
    const idle = createIdleGuard(this.idleTimeoutMs, () => {
      this.invalid = true;
      this.connection.destroy();
    });

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

    // Owned by the caller so the counts survive an interrupted read.
    const summary: QuerySummary = { rowsRead: 0, affectedRows: 0 };

    try {
      const stream = rawConnectionOf(this.connection).query(sql).stream();
      const read = consumeMysqlStream(stream, sink, () => cancelled, summary, () =>
        idle.noteActivity(),
      );
      // Awaiting the read on its own is not safe. When a socket dies without an
      // error -- which is exactly what a vanished peer leaves behind -- mysql2
      // emits nothing at all, so the iterator stays parked on a value that will
      // never arrive, and destroying the socket does not wake it. Measured: the
      // guard fired and the read then sat there for another 17 seconds anyway.
      // Racing against the guard is what actually gives control back.
      const outcome = await Promise.race([
        read.then(
          () => 'read' as const,
          (error: unknown) => ({ error }),
        ),
        idle.whenExpired.then(() => 'expired' as const),
      ]);
      if (outcome === 'expired') {
        throw new QueryIdleTimeoutError(this.idleTimeoutMs);
      }
      if (typeof outcome === 'object') {
        throw outcome.error;
      }
      if (cancelled && signal.reason !== 'limit') {
        throw new QueryCancelledError();
      }
      return summary;
    } catch (error) {
      // Checked before the cancel branch: when the guard is what ended the
      // read, the driver error that surfaced is a symptom of the teardown, and
      // the user needs to hear about the dead connection rather than see it
      // reported as a failed statement.
      if (idle.expired) {
        this.invalid = true;
        throw new QueryIdleTimeoutError(this.idleTimeoutMs);
      }
      if (isConnectionFailure(error)) {
        this.invalid = true;
      }
      if (cancelled) {
        // Stopping at a row limit interrupts the server on purpose, so a driver
        // error raised by that interruption is expected, not a failure. MySQL
        // streams as it produces, so that kill also stops work the server has
        // not done yet -- here a limit saves compute, not just bandwidth.
        if (signal.reason === 'limit') {
          return summary;
        }
        // A cancel that arrived mid-flight surfaces as a driver error; report it
        // as a cancellation so the user does not see a scary failure toast.
        if (!(error instanceof QueryCancelledError)) {
          throw new QueryCancelledError();
        }
      }
      throw error;
    } finally {
      settled = true;
      idle.dispose();
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
    // `end()` waits for the server to acknowledge the goodbye, and a connection
    // that went half-open never sends one. Without a deadline the caller's
    // finally block -- and with it the progress notification and the "this file
    // is running" flag -- would hang here even after the read itself was
    // abandoned. Past the deadline the socket is of no use to anyone.
    await settleWithin(this.connection.end(), CLOSE_TIMEOUT_MS, () => this.connection.destroy());
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
