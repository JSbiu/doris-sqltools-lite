import { HiveClient, auth, connections, thrift } from 'hive-driver';
import { isConnectionFailure } from './connectionDiagnostics';
import type { ConnectionProfile } from './connectionSecurity';
import {
  decodeHiveRowSet,
  decodeHiveValue,
  hiveColumnDescriptors,
  type ColumnDescriptor,
} from './hiveResult';
import {
  QueryCancelledError,
  neverCancelled,
  type CancelSignal,
  type QuerySession,
  type QuerySummary,
  type RowSink,
} from './querySession';

// Spark Thrift Server speaks HiveServer2's TCLIService over Thrift, not the
// MySQL wire protocol, so it needs its own session implementation. Everything
// below the QuerySession interface is shared with the MySQL/Doris path.

const { TCLIService, TCLIService_types } = thrift;

// Spark bundles different Hive versions (Spark 2.x -> Hive 1.2, Spark 3.x/4.x ->
// Hive 2.3+), and asking for a protocol version the server does not know fails
// the handshake outright. So the newest is tried first and the list walks down
// until one is accepted.
const PROTOCOL_VERSIONS: number[] = [
  TCLIService_types.TProtocolVersion.HIVE_CLI_SERVICE_PROTOCOL_V10,
  TCLIService_types.TProtocolVersion.HIVE_CLI_SERVICE_PROTOCOL_V9,
  TCLIService_types.TProtocolVersion.HIVE_CLI_SERVICE_PROTOCOL_V8,
  TCLIService_types.TProtocolVersion.HIVE_CLI_SERVICE_PROTOCOL_V7,
  TCLIService_types.TProtocolVersion.HIVE_CLI_SERVICE_PROTOCOL_V6,
];

// Rows per FetchResults round trip.
const FETCH_ROWS = 1_000;

// The driver's own waitUntilReady() polls as fast as the server answers. A
// Spark job can run for minutes, so poll on a timer instead.
const STATUS_POLL_INTERVAL_MS = 200;

type HiveClientInstance = InstanceType<typeof HiveClient>;
type HiveSessionHandle = Awaited<ReturnType<HiveClientInstance['openSession']>>;
type HiveOperation = Awaited<ReturnType<HiveSessionHandle['executeStatement']>>;
type HiveOperationStatus = Awaited<ReturnType<HiveOperation['status']>>;

// The slice of the driver's operation object the fetch loop actually uses,
// declared narrowly so `node --test` can drive the loop with a fake.
export interface HiveFetchable {
  fetch(): Promise<unknown>;
  hasMoreRows(): boolean;
  getSchema(): unknown;
  getData(): unknown[];
  flush(): void;
}

// Pulls one batch at a time and hands each row straight to the sink. getData()
// accumulates until flush() resets it, so flushing after every batch is what
// keeps memory flat; the driver's own fetchAll() is what used to hold an entire
// answer in memory.
export async function drainHiveRows(
  operation: HiveFetchable,
  sink: RowSink,
  isCancelled: () => boolean,
): Promise<number> {
  let descriptors: ColumnDescriptor[] = [];
  let announced = false;
  let rowsRead = 0;

  do {
    if (isCancelled()) {
      break;
    }
    await operation.fetch();

    // The schema only exists once the first batch has arrived.
    if (!announced) {
      descriptors = hiveColumnDescriptors(operation.getSchema());
      sink.onColumns(descriptors.map((descriptor) => descriptor.name));
      announced = true;
    }

    for (const rowSet of operation.getData()) {
      for (const row of decodeHiveRowSet(rowSet, descriptors)) {
        rowsRead += 1;
        const pending = sink.onRow(row);
        if (pending) {
          await pending;
        }
      }
    }
    operation.flush();
  } while (operation.hasMoreRows());

  return rowsRead;
}

export async function openHiveSession(
  profile: ConnectionProfile,
  password: string,
): Promise<QuerySession> {
  const client = new HiveClient(TCLIService, TCLIService_types);
  // EventEmitter turns an unhandled 'error' into a thrown exception, which in
  // an extension host means a crash. Keep it from ever escaping, and replay it
  // on the next statement so failures are still visible.
  const relay: { target?: (error: unknown) => void } = {};
  client.on('error', (error: unknown) => relay.target?.(error));

  const authProvider =
    profile.hiveAuth === 'nosasl'
      ? new auth.NoSaslAuthentication()
      : new auth.PlainTcpAuthentication({ username: profile.username, password });

  try {
    await client.connect(
      { host: profile.host, port: profile.port },
      new connections.TcpConnection(),
      authProvider,
    );
    const handle = await openSessionWithFallback(client, profile, password);
    const session = new HiveQuerySession(client, handle);
    relay.target = (error) => session.noteTransportError(error);

    // HiveServer2 has no "default database" connection option, so the chosen
    // database is selected with USE on the fresh session, which is also what
    // beeline does.
    if (profile.database) {
      await session.execute(`USE ${quoteIdentifier(profile.database)}`, neverCancelled, {
        onColumns: () => undefined,
        onRow: () => undefined,
        onAffectedRows: () => undefined,
      });
    }
    return session;
  } catch (error) {
    closeClient(client);
    throw toHiveError(error);
  }
}

async function openSessionWithFallback(
  client: HiveClientInstance,
  profile: ConnectionProfile,
  password: string,
): Promise<HiveSessionHandle> {
  let lastError: unknown;
  for (const clientProtocol of PROTOCOL_VERSIONS) {
    try {
      return await client.openSession({
        client_protocol: clientProtocol,
        username: profile.username,
        password,
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw toHiveError(lastError);
}

function closeClient(client: HiveClientInstance): void {
  try {
    client.close();
  } catch {
    // Closing an already-dead socket is not worth surfacing.
  }
}

function quoteIdentifier(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

class HiveQuerySession implements QuerySession {
  private invalid = false;
  private closed = false;
  private transportError: Error | undefined;

  public constructor(
    private readonly client: HiveClientInstance,
    private readonly session: HiveSessionHandle,
  ) {}

  public get broken(): boolean {
    return this.invalid || this.closed;
  }

  /** Called by the client's 'error' event, which fires outside any await. */
  public noteTransportError(error: unknown): void {
    this.invalid = true;
    this.transportError ??= toHiveError(error);
  }

  public async execute(sql: string, signal: CancelSignal, sink: RowSink): Promise<QuerySummary> {
    this.throwPendingTransportError();

    const operation = await this.run(() =>
      this.session.executeStatement(sql, { runAsync: true }),
    );
    operation.setMaxRows(FETCH_ROWS);

    let cancelled = false;
    const subscription = signal.onRequest(() => {
      cancelled = true;
      // CancelOperation is an independent request on the same client, so it can
      // be issued while the status loop below is asleep.
      void operation.cancel().catch(() => undefined);
    });

    try {
      const status = await this.pollUntilFinished(operation, () => cancelled);
      if (cancelled) {
        throw new QueryCancelledError();
      }
      const rowsRead = await this.run(() => drainHiveRows(operation, sink, () => cancelled));
      if (cancelled) {
        throw new QueryCancelledError();
      }
      return { rowsRead, affectedRows: modifiedRowCount(status) };
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
      subscription.dispose();
      await Promise.resolve(operation.close()).catch(() => undefined);
    }
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.invalid = true;
    try {
      await this.session.close();
    } catch {
      // The session may already be gone server-side.
    }
    closeClient(this.client);
  }

  private throwPendingTransportError(): void {
    const pending = this.transportError;
    if (pending) {
      this.transportError = undefined;
      throw pending;
    }
  }

  // Converts the driver's non-Error throwables into real Errors so the shared
  // diagnostics layer can read a message instead of "[object Object]".
  private async run<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      this.invalid ||= isConnectionFailure(error);
      throw toHiveError(error);
    }
  }

  private async pollUntilFinished(
    operation: HiveOperation,
    isCancelled: () => boolean,
  ): Promise<HiveOperationStatus> {
    for (;;) {
      const status = await this.run(() => operation.status(false));
      const state = status.operationState;
      const states = TCLIService_types.TOperationState;

      if (state === states.FINISHED_STATE) {
        return status;
      }
      if (state === states.CANCELED_STATE || isCancelled()) {
        throw new QueryCancelledError();
      }
      if (state === states.ERROR_STATE) {
        throw new Error(describeFailure(status));
      }
      if (state === states.CLOSED_STATE) {
        throw new Error('查询在服务端被关闭。');
      }
      if (state === states.TIMEDOUT_STATE) {
        throw new Error('查询在服务端超时。');
      }
      if (
        state !== states.INITIALIZED_STATE &&
        state !== states.RUNNING_STATE &&
        state !== states.PENDING_STATE
      ) {
        throw new Error(`服务端返回了无法识别的查询状态（${String(state)}）。`);
      }
      await delay(STATUS_POLL_INTERVAL_MS);
    }
  }
}

function describeFailure(status: HiveOperationStatus): string {
  const parts: string[] = [];
  if (status.errorMessage) {
    parts.push(status.errorMessage);
  }
  if (status.sqlState) {
    parts.push(`SQLState: ${status.sqlState}`);
  }
  return parts.join(' ') || '查询在服务端执行失败。';
}

function modifiedRowCount(status: HiveOperationStatus): number {
  const decoded = decodeHiveValue('i64Val', status.numModifiedRows);
  return typeof decoded === 'number' && Number.isFinite(decoded) && decoded > 0 ? decoded : 0;
}

// The driver's errors are plain classes, not Error subclasses, and it splits the
// server text between `message` and `stack` (which holds infoMessages). Fold all
// of it into one real Error so nothing is lost on the way to the UI.
function toHiveError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  if (!error || typeof error !== 'object') {
    return new Error(String(error));
  }

  const record = error as {
    name?: unknown;
    message?: unknown;
    stack?: unknown;
    response?: unknown;
  };
  const parts: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.trim() && !parts.includes(value)) {
      parts.push(value);
    }
  };

  push(record.message);
  push(record.stack);

  const response = record.response as
    | { errorMessage?: unknown; sqlState?: unknown; errorCode?: unknown }
    | undefined;
  if (response && typeof response === 'object') {
    push(response.errorMessage);
    push(response.sqlState);
  }

  const message = parts.join(' ') || 'Spark Thrift 请求失败。';
  const wrapped = new Error(message);
  if (typeof record.name === 'string' && record.name.trim()) {
    wrapped.name = record.name;
  }
  return wrapped;
}
