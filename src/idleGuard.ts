// A connection that goes away without a FIN or an RST -- a VPN drop, a firewall
// that forgets the flow, a server killed mid-answer -- leaves the read loop
// parked forever. Nothing below notices: mysql2 waits on its socket and the
// Thrift client waits on its transport, and both are perfectly willing to wait
// for a packet that will never arrive. The progress notification keeps spinning
// and the "this file already has a query running" flag stays set, because the
// finally block that clears it is still awaiting that read.
//
// The timer here is deliberately NOT a query timeout. A statement that has
// produced nothing yet is indistinguishable from a dead one -- a full scan can
// legitimately run for minutes before its first row comes back -- so the guard
// stays disarmed until the answer has actually started arriving. Once it has,
// silence really does mean the connection is gone: a live server with rows to
// give would have given them.

// Which half of a statement the silence was noticed in. The two need different
// wording because they mean different things to the user: rows that stopped
// arriving is a broken answer, whereas a status request that never came back is
// a statement whose outcome has simply become unknowable.
export type IdleTimeoutStage = 'result' | 'status';

export class QueryIdleTimeoutError extends Error {
  public constructor(timeoutMs: number, stage: IdleTimeoutStage = 'result') {
    super(
      stage === 'status'
        ? `连接已中断：连续 ${formatDuration(timeoutMs)} 没能取到查询状态。` +
          '状态查询只是一次轻量往返，耗时与服务端要跑多久无关，' +
          '所以这么久没有任何响应，基本可以断定连接已经不可用' +
          '（VPN 断开、防火墙清掉了这条会话、服务端进程被结束）。' +
          '服务端上的任务可能仍在运行，但结果已经取不回来了，可以重新执行。'
        : `连接已中断：结果开始返回后，${formatDuration(timeoutMs)} 内没有收到任何数据。` +
          '通常是对端已经不在了（VPN 断开、防火墙清掉了这条会话、服务端进程被结束），' +
          '本地连接没有收到关闭通知，于是一直等下去。连接已断开，可以重新执行。',
    );
    this.name = 'QueryIdleTimeoutError';
  }
}

export interface IdleGuard {
  // The consumer may be waiting for local disk backpressure, not the network.
  pause(): void;
  // Called whenever the driver has proof the connection is still alive: a row,
  // a batch. Arms the clock on the first call, resets it on every later one.
  noteActivity(): void;
  // Stops the clock for good. Safe to call more than once.
  dispose(): void;
  // True once the guard fired, so the caller can report *why* the read ended
  // instead of surfacing the driver error the teardown produced.
  readonly expired: boolean;
  // Resolves the moment the guard fires. This is the only way out of an await
  // that cannot be interrupted from the outside: a socket that dies without an
  // error leaves the driver's iterator parked on a value that never comes, and
  // destroying the socket does not wake it -- measured, not assumed. Racing the
  // read against this promise is what actually returns control to the caller.
  readonly whenExpired: Promise<void>;
}

// A non-positive timeout disables the guard, which is what a caller wants when
// it has its own way of noticing a dead connection.
export function createIdleGuard(timeoutMs: number, onIdle: () => void): IdleGuard {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fired = false;
  let disposed = false;
  let announceExpiry: (() => void) | undefined;
  const whenExpired = new Promise<void>((resolve) => {
    announceExpiry = resolve;
  });

  const stopClock = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return {
    pause: stopClock,
    noteActivity(): void {
      if (disposed || fired || timeoutMs <= 0) {
        return;
      }
      stopClock();
      timer = setTimeout(() => {
        timer = undefined;
        fired = true;
        // Before onIdle, so a caller already racing this promise stops waiting
        // even if tearing the connection down turns out to block.
        announceExpiry?.();
        onIdle();
      }, timeoutMs);
      // A timer waiting out a five-minute timeout must never be the reason the
      // extension host stays alive. Cast rather than bare `.unref()`: the type
      // of setTimeout's return value depends on which lib a build picks up.
      //
      // The cost of that choice: an unref'd timer does not hold the event loop
      // open, so it must never be the only thing a pending await could be
      // released by. In production that always holds -- a half-open TCP
      // connection is still a live handle -- but a unit test that waits on this
      // deadline has to keep a ref'd handle around itself; see
      // tests/idle-guard.test.js.
      (timer as { unref?: () => void }).unref?.();
    },
    dispose(): void {
      disposed = true;
      stopClock();
    },
    get expired(): boolean {
      return fired;
    },
    whenExpired,
  };
}

// One round of a polling loop: the request races the connection going quiet and
// the user giving up.
//
// Why this is not a query timeout: a statement submitted with runAsync may
// legitimately run for hours, so nothing may bound the total duration. Each
// status request is instead a small round trip whose cost barely depends on how
// long the statement itself has to run, so the deadline measures one round trip
// -- re-armed after every reply -- and a reply that never comes means the
// transport is gone rather than the statement being slow.
//
// The threshold still has to clear the server's *worst* status latency, not its
// typical one. Measured against a local HiveServer2, getStatus answered in well
// under a second until a CPU-saturating query was about five seconds in, at
// which point a single call blocked for several seconds -- a busy server, not a
// dying socket. The default is minutes precisely to stay clear of that; do not
// tune it down without measuring the real server under load.
//
// Without it, a transport that goes half-open mid-run parks the loop for good:
// the request never comes back, the cancel flag is set but never reached, and
// the caller's progress notification spins until the window is reloaded.
//
// Both escapes are built once and shared by every round, so a loop that polls
// for an hour does not pile up listeners; only the request itself is per-round.
export type RequestOutcome<T> =
  | { kind: 'done'; value: T }
  | { kind: 'failed'; error: unknown }
  | { kind: 'stalled' }
  | { kind: 'cancelled' };

export interface RequestGuard {
  run<T>(request: Promise<T>): Promise<RequestOutcome<T>>;
  dispose(): void;
}

export function createRequestGuard(
  timeoutMs: number,
  onStall: () => void,
  cancelled: Promise<void>,
): RequestGuard {
  const guard = createIdleGuard(timeoutMs, onStall);
  const stalled: Promise<RequestOutcome<never>> = guard.whenExpired.then(() => ({
    kind: 'stalled',
  }));
  const abandoned: Promise<RequestOutcome<never>> = cancelled.then(() => ({ kind: 'cancelled' }));

  return {
    run<T>(request: Promise<T>): Promise<RequestOutcome<T>> {
      guard.noteActivity();
      const settled: Promise<RequestOutcome<T>> = request.then(
        (value) => ({ kind: 'done', value }),
        (error: unknown) => ({ kind: 'failed', error }),
      );
      return Promise.race<RequestOutcome<T>>([settled, stalled, abandoned]);
    },
    dispose(): void {
      guard.dispose();
    },
  };
}

// Waits for `action`, but not forever. Closing a session is the other place a
// half-open socket strands the caller: `end()` waits for the server to
// acknowledge the goodbye, and a connection that went away without a FIN never
// sends one -- so the caller's finally block, the progress notification and the
// "this file is running" flag all hang on it. `onTimeout` is what actually
// releases things (destroy the socket); the error from `action` is swallowed
// because by then there is nothing useful to report.
export async function settleWithin(
  action: Promise<unknown>,
  ms: number,
  onTimeout: () => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      action.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          onTimeout();
          resolve();
        }, ms);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds} 秒`;
  }
  const minutes = seconds / 60;
  return Number.isInteger(minutes) ? `${minutes} 分钟` : `${minutes.toFixed(1)} 分钟`;
}
