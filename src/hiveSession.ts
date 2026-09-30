import { createConnection } from 'node:net';
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
  QueryIdleTimeoutError,
  createIdleGuard,
  createRequestGuard,
  settleWithin,
} from './idleGuard';
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

// The driver's TCP transport is a bare net.createConnection with no timeout of
// its own, so a server that accepts the socket but never completes the
// HiveServer2 handshake leaves the promise pending forever -- the progress
// notification just spins. The usual cause is an authentication mode mismatch:
// against a server started with `--auth nosasl`, a SASL/PLAIN client gets no
// reply at all rather than an error.
const HANDSHAKE_TIMEOUT_MS = 20_000;

// A dropped SYN and a silent server look identical to the handshake timeout, so
// the socket is probed first and the two are reported differently. Kept under
// the handshake timeout so a filtered port reports the network problem rather
// than a misleading authentication one.
const TCP_PROBE_TIMEOUT_MS = 15_000;

// How long a fetch may go quiet before the transport is presumed dead. The
// result is already materialised by the time the fetch loop runs (an async
// statement finishes before the first FetchResults), so a fetch that never
// returns is a dead socket rather than a slow query. See idleGuard.ts.
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

// How long closing the session may take before the socket is torn down instead.
// Only a transport that is already gone will ever hit this.
const CLOSE_TIMEOUT_MS = 2_000;

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
  // Called after every batch that actually arrived, which is the only proof
  // available that the transport is still alive -- the caller's idle guard is
  // reset from here.
  onActivity?: () => void,
): Promise<number> {
  let descriptors: ColumnDescriptor[] = [];
  let announced = false;
  let rowsRead = 0;

  do {
    if (isCancelled()) {
      break;
    }
    await operation.fetch();
    onActivity?.();

    // The schema only exists once the first batch has arrived.
    if (!announced) {
      descriptors = hiveColumnDescriptors(operation.getSchema());
      sink.onColumns(descriptors.map((descriptor) => descriptor.name));
      announced = true;
    }

    // Checked per row, not per batch: a caller that has all the rows it needs
    // decides that in the middle of a batch, and the rest of that batch would
    // otherwise be decoded only to be thrown away.
    let stopped = false;
    for (const rowSet of operation.getData()) {
      for (const row of decodeHiveRowSet(rowSet, descriptors)) {
        if (isCancelled()) {
          stopped = true;
          break;
        }
        rowsRead += 1;
        const pending = sink.onRow(row);
        if (pending) {
          await pending;
        }
      }
      if (stopped) {
        break;
      }
    }
    operation.flush();
    if (stopped) {
      break;
    }
  } while (operation.hasMoreRows());

  return rowsRead;
}

// The driver distinguishes two kinds of "no password":
//   undefined -> it substitutes a placeholder, its way of saying "this server
//                checks nothing"
//   ''        -> it frames a genuinely empty password, which HiveServer2
//                answers with "Error validating the login" even under NONE
// Verified against Spark 3.2.0: `undefined` connects, `''` does not. So a blank
// password from the user has to be handed over as `undefined`, not as ''.
export function hiveAuthPassword(password: string): string | undefined {
  return password === '' ? undefined : password;
}

export async function openHiveSession(
  profile: ConnectionProfile,
  password: string,
  idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS,
): Promise<QuerySession> {
  await probeTcpReachable(profile.host, profile.port);

  const client = new HiveClient(TCLIService, TCLIService_types);
  // EventEmitter turns an unhandled 'error' into a thrown exception, which in
  // an extension host means a crash. Keep it from ever escaping, and replay it
  // on the next statement so failures are still visible.
  const relay: { target?: (error: unknown) => void } = {};
  client.on('error', (error: unknown) => relay.target?.(error));

  const authProvider =
    profile.hiveAuth === 'nosasl'
      ? new auth.NoSaslAuthentication()
      : new auth.PlainTcpAuthentication({
          username: profile.username,
          password: hiveAuthPassword(password),
        });

  // Everything up to the opened session is the handshake. A failure there is
  // worth describing as such, because the TCP probe has already proved the port
  // is open by this point.
  let inHandshake = true;
  try {
    await withTimeout(
      client.connect(
        { host: profile.host, port: profile.port },
        new connections.TcpConnection(),
        authProvider,
      ),
      () => closeClient(client),
    );
    const handle = await withTimeout(
      openSessionWithFallback(client, profile, password),
      () => closeClient(client),
    );
    inHandshake = false;

    const session = new HiveQuerySession(client, handle, idleTimeoutMs);
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
    const base = toHiveError(error);
    throw inHandshake ? describeHandshakeFailure(profile, base) : base;
  }
}

// Reached only after the TCP probe succeeded, so the port is demonstrably open.
// Whatever failed now happened during the SASL handshake or OpenSession, and
// saying so keeps someone from chasing a firewall that is not the problem.
function describeHandshakeFailure(profile: ConnectionProfile, error: Error): Error {
  if (error instanceof HandshakeTimeoutError || CJK_PATTERN.test(error.message)) {
    return error;
  }
  const wrapped = new Error(
    `${profile.host}:${profile.port} 端口可以连通，但 HiveServer2 握手失败：${error.message}`,
  );
  wrapped.name = error.name;
  const code = (error as NodeJS.ErrnoException).code;
  if (code) {
    (wrapped as NodeJS.ErrnoException).code = code;
  }
  return wrapped;
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

class HandshakeTimeoutError extends Error {
  public constructor() {
    super(
      `连接超时：${HANDSHAKE_TIMEOUT_MS / 1000} 秒内没有完成 HiveServer2 握手。` +
        '端口是通的（TCP 已经连上），所以问题几乎总是认证方式对不上：' +
        'Spark Thrift Server 默认用 SASL/PLAIN（启动参数 --auth none），' +
        '若服务端以 --auth nosasl 启动，需要在连接表单里把认证方式改成 NOSASL；反之亦然。',
    );
    this.name = 'HandshakeTimeoutError';
  }
}

// Probes the port before handing it to the driver. Without this, a host that
// silently drops packets is reported by the handshake timeout as an
// authentication problem -- verified: an unroutable address produced the
// "认证方式不匹配" message after 20s. A plain socket also surfaces the real errno
// (ECONNREFUSED / ETIMEDOUT / ENOTFOUND / EHOSTUNREACH), which the diagnostics
// layer turns into accurate advice instead of a bare "connect ETIMEDOUT".
const CJK_PATTERN = /[\u4e00-\u9fa5]/;

// Wraps a socket-level failure so the message always names the target and the
// errno, and carries `code` through for the diagnostics layer. A socket error
// that has been re-thrown by another layer can arrive as a bare
// "connect ETIMEDOUT" with no address and no code, which reads like a protocol
// problem and leaves the user nothing to act on.
function describeTcpFailure(host: string, port: number, error: Error): Error {
  const detail = typeof error.message === 'string' ? error.message.trim() : '';
  if (CJK_PATTERN.test(detail)) {
    return error;
  }
  const code = (error as NodeJS.ErrnoException).code;
  const advice =
    code === 'ECONNREFUSED'
      ? '主机能连通，但该端口上没有服务在监听。'
      : '地址或端口可能不对，也可能是防火墙 / 安全组把数据包丢弃了。';
  const wrapped = new Error(
    `无法连接 ${host}:${port}：${detail || code || '连接失败'}。${advice}`,
  );
  wrapped.name = 'TcpConnectError';
  if (code) {
    (wrapped as NodeJS.ErrnoException).code = code;
  }
  return wrapped;
}

function probeTcpReachable(host: string, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port });
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      if (error) {
        reject(describeTcpFailure(host, port, error));
      } else {
        resolve();
      }
    };

    socket.setTimeout(TCP_PROBE_TIMEOUT_MS);
    socket.once('connect', () => finish());
    socket.once('timeout', () =>
      finish(
        new Error(
          `连接 ${host}:${port} 超时（${TCP_PROBE_TIMEOUT_MS / 1000} 秒内无响应）。` +
            '地址或端口可能不对，也可能是防火墙 / 安全组把数据包丢弃了。',
        ),
      ),
    );
    socket.once('error', (error: Error) => finish(error));
  });
}

// Wraps a handshake step so it cannot outlive HANDSHAKE_TIMEOUT_MS. `onTimeout`
// runs first so the half-open socket is torn down before the caller sees the
// error; the underlying promise may still settle later, which the handler below
// absorbs so it never becomes an unhandled rejection.
function withTimeout<T>(action: Promise<T>, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new HandshakeTimeoutError());
    }, HANDSHAKE_TIMEOUT_MS);

    action.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
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
    private readonly idleTimeoutMs: number,
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
    // A latch for the status loop below. CancelOperation is an independent
    // request on the same client, but on a half-open transport it never gets an
    // answer, so waiting for it would be waiting forever. This resolves the
    // instant the user gives up, and that is what actually ends the wait.
    let announceCancel: (() => void) | undefined;
    const cancelledSignal = new Promise<void>((resolve) => {
      announceCancel = resolve;
    });
    const subscription = signal.onRequest(() => {
      cancelled = true;
      announceCancel?.();
      // CancelOperation is an independent request on the same client, so it can
      // be issued while the status loop below is asleep.
      void operation.cancel().catch(() => undefined);
    });

    let rowsRead = 0;
    // Not a query timeout -- the status loop above may legitimately run for
    // minutes with nothing coming back, so the clock only starts once the fetch
    // loop does. From there a fetch that never returns means the transport is
    // gone, and without this the read would be parked on it forever. See
    // idleGuard.ts.
    const idle = createIdleGuard(this.idleTimeoutMs, () => {
      this.invalid = true;
      closeClient(this.client);
    });
    try {
      const status = await this.pollUntilFinished(operation, () => cancelled, cancelledSignal);
      if (cancelled && signal.reason !== 'limit') {
        throw new QueryCancelledError();
      }
      // Started before the first fetch rather than after the first batch: the
      // answer is already materialised at this point, so even the very first
      // fetch going quiet is evidence of a dead socket, not of slow work.
      idle.noteActivity();
      const drain = this.run(() =>
        drainHiveRows(operation, sink, () => cancelled, () => idle.noteActivity()),
      );
      // Same reason as the MySQL path: a transport that dies without an error
      // leaves the driver's callback waiting for a reply that never comes, and
      // tearing the client down is not guaranteed to wake it. Racing against the
      // guard is what actually returns control.
      const outcome = await Promise.race([
        drain.then(
          (count) => ({ count }),
          (error: unknown) => ({ error }),
        ),
        idle.whenExpired.then(() => 'expired' as const),
      ]);
      if (outcome === 'expired') {
        throw new QueryIdleTimeoutError(this.idleTimeoutMs);
      }
      if ('error' in outcome) {
        throw outcome.error;
      }
      rowsRead = outcome.count;
      if (cancelled && signal.reason !== 'limit') {
        throw new QueryCancelledError();
      }
      return { rowsRead, affectedRows: modifiedRowCount(status) };
    } catch (error) {
      // Checked first: when the guard fired, the error that surfaced is a
      // symptom of the teardown, and a dead transport is what the user needs to
      // hear about.
      if (idle.expired) {
        this.invalid = true;
        throw new QueryIdleTimeoutError(this.idleTimeoutMs);
      }
      if (isConnectionFailure(error)) {
        this.invalid = true;
      }
      if (cancelled) {
        // A limit stop interrupts the operation on purpose. Closing it (in the
        // finally block) also releases the result the server had already
        // materialised, which for a large answer is most of what stopping early
        // buys: the fetch phase is short, the server's own work is not saveable
        // because an async statement has usually finished before we fetch.
        if (signal.reason === 'limit') {
          return { rowsRead, affectedRows: 0 };
        }
        // A cancel that arrived mid-flight surfaces as a driver error; report it
        // as a cancellation so the user does not see a scary failure toast.
        if (!(error instanceof QueryCancelledError)) {
          throw new QueryCancelledError();
        }
      }
      throw error;
    } finally {
      idle.dispose();
      subscription.dispose();
      // Closing the operation is a round trip as well, and a transport that went
      // half-open never answers it -- the same trap that session.close() guards
      // against below. Left unguarded, this is where a statement that had just
      // given up would hang the caller's finally block instead, keeping the
      // progress notification spinning and the file marked as running.
      await settleWithin(operation.close(), CLOSE_TIMEOUT_MS, () => closeClient(this.client));
    }
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.invalid = true;
    // closeSession is a round trip, and a transport that went half-open never
    // answers it. closeClient is what actually releases the socket, so it has
    // to run either way -- otherwise a dead connection keeps the caller's
    // finally block waiting and the progress notification spinning.
    await settleWithin(this.session.close(), CLOSE_TIMEOUT_MS, () => closeClient(this.client));
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

  // Waits out a statement the server is running asynchronously.
  //
  // There is deliberately no limit on the total duration -- a Spark job may run
  // for hours -- but each status request on its own is raced against a deadline
  // and against the cancel signal. Without that, a transport that goes
  // half-open mid-run parks this loop for good: the request never returns, the
  // cancel flag is set but the loop never reaches the check for it, and the
  // caller waits until the window is reloaded. Verified against a real
  // HiveServer2 with a freezing TCP proxy: before this guard the wait survived
  // a 20s silence with a 3s limit configured, and cancelling did nothing.
  private async pollUntilFinished(
    operation: HiveOperation,
    isCancelled: () => boolean,
    cancelled: Promise<void>,
  ): Promise<HiveOperationStatus> {
    const states = TCLIService_types.TOperationState;
    // Shares the same limit as the read phase below, but measured per request
    // rather than per silence, so a statement that runs for hours is never cut
    // off by it. The limit must still sit clear of the server's worst status
    // latency -- measured against a local HiveServer2, one getStatus call
    // blocked for several seconds once a CPU-saturating query was about five
    // seconds in -- which is why the default is minutes rather than seconds.
    const guard = createRequestGuard(
      this.idleTimeoutMs,
      () => {
        this.invalid = true;
        closeClient(this.client);
      },
      cancelled,
    );

    try {
      for (;;) {
        const outcome = await guard.run(this.run(() => operation.status(false)));
        if (outcome.kind === 'stalled') {
          throw new QueryIdleTimeoutError(this.idleTimeoutMs, 'status');
        }
        if (outcome.kind === 'cancelled') {
          throw new QueryCancelledError();
        }
        if (outcome.kind === 'failed') {
          throw outcome.error;
        }

        const status = outcome.value;
        const state = status.operationState;

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
    } finally {
      guard.dispose();
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
export function toHiveError(error: unknown): Error {
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
    code?: unknown;
    address?: unknown;
    port?: unknown;
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

  // A socket error can arrive as a plain object whose message is only
  // "connect ETIMEDOUT" -- the target lives in separate fields. Put it back into
  // the text so the user can see what was actually attempted.
  const address = typeof record.address === 'string' ? record.address.trim() : '';
  const port = record.port === undefined || record.port === null ? '' : String(record.port);
  if (address && !parts.join(' ').includes(address)) {
    parts.push(port ? `${address}:${port}` : address);
  }

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
  // The diagnostics layer classifies by `code`, so dropping it here is what made
  // a failed connection surface as a bare English sentence with no explanation
  // and no advice.
  if (typeof record.code === 'string' && record.code.trim()) {
    (wrapped as NodeJS.ErrnoException).code = record.code;
  }
  return wrapped;
}
