const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const idle = require('../out/idleGuard');
const { neverCancelled, QueryCancelledError } = require('../out/querySession');
const { thrift } = require('hive-driver');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function cancellation() {
  const listeners = new Set();
  let requested = false;
  let reason;
  return {
    get requested() { return requested; },
    get reason() { return reason; },
    onRequest(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
    cancel(nextReason = 'user') { requested = true; reason = nextReason; for (const listener of [...listeners]) listener(); },
  };
}
async function bounded(promise) {
  // A referenced timer keeps the fake network test alive while the production
  // cancellation guard deliberately unrefs its own timer.
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('session did not finish')), 1500);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
function loadSession(name, className, dependencies = {}) {
  const filename = path.resolve(__dirname, `../out/${name}.js`);
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  const scaled = (ms) => ms >= 2000 ? 40 : ms;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + `\nmodule.exports.Session = ${className};`, {
    module, exports: module.exports, Buffer,
    setTimeout: (callback, ms) => setTimeout(callback, scaled(ms)), clearTimeout,
    require: (id) => {
      if (id === './idleGuard') return { ...idle,
        createIdleGuard: (ms, callback) => idle.createIdleGuard(scaled(ms), callback),
        settleWithin: (promise, ms, callback) => idle.settleWithin(promise, scaled(ms), callback),
      };
      return dependencies[id] ?? realRequire(id);
    },
  });
  return module.exports.Session;
}
function sink(onRow = () => {}) {
  return { onColumns() {}, onAffectedRows() {}, onRow };
}
class RowStream extends EventEmitter {
  constructor(rows = [{ id: 1 }], tail) { super(); this.rows = rows; this.tail = tail; }
  async *[Symbol.asyncIterator]() {
    this.emit('fields', [{ name: 'id' }]);
    for (const row of this.rows) yield row;
    if (this.tail) await this.tail;
  }
}
function mysql(options = {}) {
  const calls = { sql: [], destroyed: 0, kills: [], controlClosed: 0, controlDestroyed: 0 };
  const control = {
    query: async (sql) => { calls.kills.push(sql); return options.kill?.(); },
    end: async () => { calls.controlClosed++; return options.controlEnd?.(); },
    destroy: () => { calls.controlDestroyed++; },
  };
  const connection = {
    threadId: 17,
    connection: { query(sql) { calls.sql.push(sql); return { stream: () => options.stream?.() ?? new RowStream() }; } },
    destroy() { calls.destroyed++; }, end: async () => {},
  };
  const Session = loadSession('mysqlSession', 'MysqlSession', {
    './mysqlConnect': { createMysqlConnection: () => options.openControl?.(control) ?? Promise.resolve(control) },
  });
  return { session: new Session({}, '', connection, options.idleMs ?? 0), calls, control };
}
function hive(options = {}) {
  const calls = { sql: [], clientClosed: 0, operationClosed: 0, cancelled: 0, flushed: 0, fetches: 0 };
  const operation = {
    setMaxRows() {},
    status: async () => ({ operationState: thrift.TCLIService_types.TOperationState.FINISHED_STATE, hasResultSet: true }),
    fetch: async () => { calls.fetches++; await options.fetch?.(); },
    getSchema: () => ({ columns: [{ columnName: 'id', position: 0 }] }),
    getData: () => [{ columns: [{ i32Val: { values: [1, 2] } }] }],
    hasMoreRows: () => false,
    flush: () => { calls.flushed++; },
    cancel: async () => { calls.cancelled++; await options.cancel?.(); },
    close: async () => { calls.operationClosed++; await options.closeOperation?.(); },
  };
  const Session = loadSession('hiveSession', 'HiveQuerySession');
  const session = new Session({ close() { calls.clientClosed++; } }, {
    executeStatement: async (sql) => { calls.sql.push(sql); return options.submit ? options.submit(operation) : operation; },
    close: async () => {},
  }, options.idleMs ?? 0);
  return { session, operation, calls };
}

for (const asynchronous of [false, true]) {
  test(`MySQL ${asynchronous ? 'async' : 'sync'} disk failure discards the unread connection and preserves its error`, async () => {
    const h = mysql({ stream: () => new RowStream([{ id: 1 }, { id: 2 }]) });
    const error = Object.assign(new Error('test disk full'), { code: 'ENOSPC' });
    let delivered = 0;
    await assert.rejects(bounded(h.session.execute('SELECT id', neverCancelled, sink(() => {
      delivered++;
      if (asynchronous) return Promise.reject(error);
      throw error;
    }))), (caught) => caught === error);
    assert.equal(delivered, 1);
    assert.equal(h.session.broken, true);
    assert.equal(h.calls.destroyed, 1);
    await assert.rejects(h.session.execute('SELECT again', neverCancelled, sink()), /失效/);
    assert.equal(h.calls.sql.length, 1);
  });
  test(`Hive ${asynchronous ? 'async' : 'sync'} disk failure flushes and closes its operation while retaining a healthy session`, async () => {
    const h = hive();
    const error = Object.assign(new Error('test disk full'), { code: 'ENOSPC' });
    await assert.rejects(bounded(h.session.execute('SELECT id', neverCancelled, sink(() => {
      if (asynchronous) return Promise.reject(error);
      throw error;
    }))), (caught) => caught === error);
    assert.equal(h.calls.flushed, 1);
    assert.equal(h.calls.operationClosed, 1);
    assert.equal(h.session.broken, false);
    const summary = await bounded(h.session.execute('SELECT again', neverCancelled, sink()));
    assert.equal(summary.rowsRead, 2);
  });
}

for (const factory of [mysql, hive]) {
  test(`${factory.name} row-limit summaries retain the result-set flag and an unknown affected count`, async () => {
    const h = factory();
    const signal = cancellation();
    const summary = await bounded(h.session.execute('SELECT id', signal, sink(() => signal.cancel('limit'))));

    assert.equal(summary.hasResultSet, true);
    assert.equal(summary.rowsRead, 1);
    assert.equal(summary.affectedRows, null);
  });
  test(`${factory.name} does not count local disk backpressure as network silence`, async () => {
    const h = factory({ idleMs: 10 });
    const summary = await bounded(h.session.execute('SELECT id', neverCancelled, sink(() => sleep(45))));
    assert.ok(summary.rowsRead > 0);
    assert.equal(h.session.broken, false);
  });
  test(`${factory.name} cancellation waits for an in-flight sink write before returning`, async () => {
    const writing = deferred();
    const disk = deferred();
    const signal = cancellation();
    const h = factory();
    let delivered = 0;
    let settled = false;
    const executing = h.session.execute('SELECT id', signal, sink(() => {
      delivered++;
      writing.resolve();
      return disk.promise;
    }));
    const rejected = assert.rejects(bounded(executing), QueryCancelledError);
    executing.then(() => { settled = true; }, () => { settled = true; });
    await writing.promise;
    signal.cancel();
    await sleep(75);
    assert.equal(settled, false);
    disk.resolve();
    await rejected;
    assert.equal(delivered, 1);
  });
  test(`${factory.name} pre-cancelled requests do not submit SQL`, async () => {
    const h = factory();
    const signal = cancellation();
    signal.cancel();
    await assert.rejects(h.session.execute('SELECT id', signal, sink()), QueryCancelledError);
    assert.equal(h.calls.sql.length, 0);
  });
}

test('MySQL cancellation has a deadline while opening the control connection, even with idle checking off', async () => {
  const opening = deferred();
  const tail = deferred();
  const seen = deferred();
  const h = mysql({ stream: () => new RowStream([{ id: 1 }], tail.promise), openControl: () => opening.promise });
  const signal = cancellation();
  const rejected = assert.rejects(bounded(h.session.execute('SELECT id', signal, sink(() => seen.resolve()))), QueryCancelledError);
  await seen.promise;
  signal.cancel();
  await rejected;
  assert.equal(h.session.broken, true);
  opening.resolve(h.control);
  tail.resolve();
  await tick();
  assert.deepEqual(h.calls.kills, []);
  assert.equal(h.calls.controlClosed, 1);
});

test('MySQL cannot reuse a connection while a sent KILL is still unacknowledged', async () => {
  const tail = deferred();
  const seen = deferred();
  const killSent = deferred();
  const killReply = deferred();
  const h = mysql({ stream: () => new RowStream([{ id: 1 }], tail.promise), kill: () => { killSent.resolve(); return killReply.promise; } });
  const signal = cancellation();
  const executing = h.session.execute('SELECT id', signal, sink(() => seen.resolve()));
  const rejected = assert.rejects(bounded(executing), QueryCancelledError);
  await seen.promise;
  signal.cancel();
  await killSent.promise;
  tail.resolve();
  await rejected;
  assert.equal(h.session.broken, true);
  assert.equal(h.calls.destroyed, 1);
  killReply.resolve();
});

test('a late MySQL control connection cannot kill the next query', async () => {
  const opening = deferred();
  const tail = deferred();
  const seen = deferred();
  let first = true;
  const h = mysql({
    stream: () => { if (first) { first = false; return new RowStream([{ id: 1 }], tail.promise); } return new RowStream(); },
    openControl: () => opening.promise,
  });
  const signal = cancellation();
  const rejected = assert.rejects(bounded(h.session.execute('SELECT first', signal, sink(() => seen.resolve()))), QueryCancelledError);
  await seen.promise;
  signal.cancel();
  tail.resolve();
  await rejected;
  assert.equal(h.session.broken, false);
  const next = h.session.execute('SELECT second', neverCancelled, sink());
  opening.resolve(h.control);
  await bounded(next);
  await tick();
  assert.deepEqual(h.calls.kills, []);
  assert.equal(h.calls.controlClosed, 1);
});

test('acknowledged MySQL cancellation retains the session even when closing its control connection fails', async () => {
  const tail = deferred();
  const seen = deferred();
  const h = mysql({ stream: () => new RowStream([{ id: 1 }], tail.promise),
    kill: () => { tail.resolve(); }, controlEnd: () => Promise.reject(new Error('test control close failed')) });
  const signal = cancellation();
  const rejected = assert.rejects(bounded(h.session.execute('SELECT id', signal, sink(() => seen.resolve()))), QueryCancelledError);
  await seen.promise;
  signal.cancel();
  await rejected;
  await tick();
  assert.equal(h.session.broken, false);
  assert.equal(h.calls.controlDestroyed, 1);
});

for (const stage of ['submission', 'fetch']) {
  test(`Hive cancellation bounds a hanging ${stage} with idle checking off and rejects late rows`, async () => {
    const gate = deferred();
    const started = deferred();
    const h = hive(stage === 'submission'
      ? { submit: async (operation) => { started.resolve(); await gate.promise; return operation; } }
      : { fetch: async () => { started.resolve(); await gate.promise; } });
    let delivered = 0;
    const signal = cancellation();
    const rejected = assert.rejects(bounded(h.session.execute('SELECT id', signal, sink(() => { delivered++; }))), QueryCancelledError);
    await started.promise;
    signal.cancel();
    await rejected;
    assert.equal(h.session.broken, true);
    assert.ok(h.calls.clientClosed > 0);
    gate.resolve();
    await tick();
    assert.equal(h.calls.operationClosed, 1);
    assert.equal(delivered, 0);
  });
}

for (const stage of ['reject', 'hang']) {
  test(`Hive operation close ${stage} retires the session while complete rows remain usable`, async () => {
    const h = hive({ closeOperation: () => stage === 'reject' ? Promise.reject(new Error('test close failed')) : new Promise(() => {}) });
    const summary = await bounded(h.session.execute('SELECT id', neverCancelled, sink()));
    assert.equal(summary.rowsRead, 2);
    assert.equal(h.session.broken, true);
    assert.ok(h.calls.clientClosed > 0);
    await assert.rejects(h.session.execute('SELECT again', neverCancelled, sink()), /失效/);
    assert.equal(h.calls.sql.length, 1);
  });
}
