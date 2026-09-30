const assert = require('node:assert/strict');
const test = require('node:test');
const { Readable } = require('node:stream');

const { createIdleGuard, createRequestGuard, QueryIdleTimeoutError } = require('../out/idleGuard.js');
const { consumeMysqlStream } = require('../out/mysqlSession.js');
const { drainHiveRows } = require('../out/hiveSession.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Shaped like mysql2's Query.stream(): an object-mode Readable that raises
// `fields` before the first row.
class FakeQueryStream extends Readable {
  constructor(items, fields) {
    super({ objectMode: true });
    this.items = items;
    this.fields = fields;
    this.fieldsSent = false;
  }

  _read() {
    if (!this.fieldsSent) {
      this.fieldsSent = true;
      this.emit('fields', this.fields);
    }
    for (const item of this.items) {
      this.push(item);
    }
    this.push(null);
  }
}

function recordingSink() {
  return {
    columns: undefined,
    rows: [],
    onColumns(columns) {
      this.columns = columns;
    },
    onRow(row) {
      this.rows.push(row);
    },
    onAffectedRows() {
      // not exercised here
    },
  };
}

test('stays quiet until the driver reports activity', async () => {
  // The whole point of the guard is that it is not a query timeout. A statement
  // that has produced nothing yet and one whose connection has died look
  // identical, so the clock must not be running yet.
  let fired = 0;
  const guard = createIdleGuard(10, () => {
    fired += 1;
  });

  await sleep(60);

  assert.equal(fired, 0);
  guard.dispose();
});

test('fires once when a connection that was sending goes quiet', async () => {
  let fired = 0;
  const guard = createIdleGuard(20, () => {
    fired += 1;
  });

  guard.noteActivity();
  await sleep(80);

  assert.equal(fired, 1);
  assert.equal(guard.expired, true);
  guard.dispose();
});

test('every arriving row pushes the deadline back', async () => {
  let fired = 0;
  const guard = createIdleGuard(40, () => {
    fired += 1;
  });

  for (let index = 0; index < 5; index += 1) {
    guard.noteActivity();
    await sleep(15);
  }

  assert.equal(fired, 0, 'a stream that keeps producing is never cut off');
  guard.dispose();
});

test('stops watching once disposed', async () => {
  let fired = 0;
  const guard = createIdleGuard(15, () => {
    fired += 1;
  });

  guard.noteActivity();
  guard.dispose();
  await sleep(60);

  assert.equal(fired, 0);
});

test('a non-positive timeout disables the guard', async () => {
  let fired = 0;
  const guard = createIdleGuard(0, () => {
    fired += 1;
  });

  guard.noteActivity();
  await sleep(40);

  assert.equal(fired, 0);
  guard.dispose();
});

test('the error names the wait in units a person reads', () => {
  const minutes = new QueryIdleTimeoutError(300_000);
  assert.equal(minutes.name, 'QueryIdleTimeoutError');
  assert.match(minutes.message, /5 分钟/);
  assert.match(minutes.message, /连接已中断/);

  assert.match(new QueryIdleTimeoutError(15_000).message, /15 秒/);
});

test('the mysql stream reports one activity per row, and none for fields', async () => {
  // `fields` arrives before the answer does. Arming the guard there would let a
  // statement that is still working be mistaken for a dead connection.
  let activity = 0;
  const stream = new FakeQueryStream([{ id: 1 }, { id: 2 }], [{ name: 'id' }]);

  await consumeMysqlStream(stream, recordingSink(), () => false, undefined, () => {
    activity += 1;
  });

  assert.equal(activity, 2);
});

test('the mysql stream still works when no activity callback is given', async () => {
  const sink = recordingSink();
  const stream = new FakeQueryStream([{ id: 1 }], [{ name: 'id' }]);

  const summary = await consumeMysqlStream(stream, sink, () => false);

  assert.equal(summary.rowsRead, 1);
  assert.deepEqual(sink.columns, ['id']);
});

test('the hive drain loop reports one activity per batch', async () => {
  const batches = 3;
  let served = 0;
  const operation = {
    async fetch() {
      served += 1;
    },
    hasMoreRows() {
      return served < batches;
    },
    getSchema() {
      return { columns: [{ columnName: 'id', position: 0 }] };
    },
    getData() {
      return [];
    },
    flush() {
      // the real operation resets its buffer here
    },
  };

  let activity = 0;
  await drainHiveRows(operation, recordingSink(), () => false, () => {
    activity += 1;
  });

  assert.equal(served, batches);
  assert.equal(activity, batches);
});

// The request guard is what makes a polling loop safe against a transport that
// goes half-open while the server is still working on the statement. Its whole
// justification is that it measures one round trip instead of the total run
// time, so that is the case worth pinning down.

test('a request that answers in time is passed straight through', async () => {
  const guard = createRequestGuard(50, () => undefined, new Promise(() => undefined));
  const outcome = await guard.run(Promise.resolve('answered'));

  assert.deepEqual(outcome, { kind: 'done', value: 'answered' });
  guard.dispose();
});

test('a failed request keeps the original error object', async () => {
  const guard = createRequestGuard(50, () => undefined, new Promise(() => undefined));
  const failure = new Error('transport blew up');
  const outcome = await guard.run(Promise.reject(failure));

  assert.equal(outcome.kind, 'failed');
  assert.equal(outcome.error, failure);
  guard.dispose();
});

test('a request that never answers is reported as stalled', async () => {
  let stalled = 0;
  const guard = createRequestGuard(20, () => {
    stalled += 1;
  }, new Promise(() => undefined));

  let outcome;
  void guard.run(new Promise(() => undefined)).then((value) => {
    outcome = value;
  });

  // The deadline is deliberately an unref'd timer (see idleGuard.ts), so it can
  // never be the reason a process stays alive -- which also means a test that
  // waits on it has to hold the loop open itself. This ref'd sleep does that,
  // and it mirrors production, where a live socket keeps the loop alive.
  await sleep(80);

  assert.equal(stalled, 1, 'the teardown callback runs exactly once');
  assert.equal(outcome?.kind, 'stalled');
  guard.dispose();
});

test('the deadline measures one round trip, not the whole loop', async () => {
  // This is what keeps a long-running statement from being cut off: the total
  // here is well past the limit, but no single round exceeds it.
  let stalled = 0;
  const guard = createRequestGuard(100, () => {
    stalled += 1;
  }, new Promise(() => undefined));

  for (let index = 0; index < 6; index += 1) {
    const outcome = await guard.run(sleep(30).then(() => index));
    assert.equal(outcome.kind, 'done');
  }

  assert.equal(stalled, 0, '~180ms elapsed against a 100ms limit, yet it never fired');
  guard.dispose();
});

test('cancelling ends a hanging request without waiting for the deadline', async () => {
  let release;
  const cancelled = new Promise((resolve) => {
    release = resolve;
  });
  // Deliberately enormous: if the outcome came from the deadline this would
  // take a minute instead of milliseconds.
  const guard = createRequestGuard(60_000, () => undefined, cancelled);

  const started = Date.now();
  const pending = guard.run(new Promise(() => undefined));
  setTimeout(release, 20);
  const outcome = await pending;

  assert.equal(outcome.kind, 'cancelled');
  assert.ok(Date.now() - started < 1000, `returned after ${Date.now() - started}ms`);
  guard.dispose();
});

test('disposing stops the deadline from firing at all', async () => {
  let stalled = 0;
  const guard = createRequestGuard(15, () => {
    stalled += 1;
  }, new Promise(() => undefined));

  void guard.run(new Promise(() => undefined));
  guard.dispose();
  await sleep(60);

  assert.equal(stalled, 0);
});

test('the stalled error says which phase went quiet', () => {
  const status = new QueryIdleTimeoutError(300_000, 'status');
  assert.equal(status.name, 'QueryIdleTimeoutError');
  assert.match(status.message, /5 分钟/);
  assert.match(status.message, /查询状态/);
  assert.match(status.message, /结果已经取不回来/);

  // The default stays what it always was, so the read phase keeps its wording.
  const result = new QueryIdleTimeoutError(300_000);
  assert.match(result.message, /结果开始返回后/);
  assert.match(result.message, /连接已断开，可以重新执行/);
});
