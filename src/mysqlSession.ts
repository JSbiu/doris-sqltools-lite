import type mysql from 'mysql2/promise';
import type { ConnectionProfile } from './connectionSecurity';
import { isConnectionFailure } from './connectionDiagnostics';
import { createMysqlConnection } from './mysqlConnect';
import { normalizeMysqlResult } from './queryResults';
import {
  QueryCancelledError,
  type CancelSignal,
  type QueryOutcome,
  type QuerySession,
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

  public async execute(sql: string, signal: CancelSignal): Promise<QueryOutcome> {
    let cancelled = false;
    let settled = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

    const subscription = signal.onRequest(() => {
      cancelled = true;
      // Cancelling a MySQL statement means killing it from another connection,
      // because this one is blocked inside query().
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
      const [rawResult, rawFields] = await this.connection.query(sql);
      if (cancelled) {
        throw new QueryCancelledError();
      }
      return normalizeMysqlResult(rawResult, rawFields);
    } catch (error) {
      if (isConnectionFailure(error)) {
        this.invalid = true;
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
  // tearing down the session the user is working in (USE / temp tables /
  // session variables survive). Returns false when the caller must fall back to
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
