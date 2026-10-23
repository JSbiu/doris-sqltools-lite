const assert = require('node:assert/strict');
const test = require('node:test');
const { DocumentSessions, SessionExpiredError } = require('../out/documentSessions');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function session() {
  return { broken: false, closed: 0, async close() { this.closed += 1; } };
}

async function opened(registry, document, profile, connection = session()) {
  const operation = registry.begin(document, () => {});
  const entry = await registry.open(operation, profile, async () => connection);
  operation.finish();
  return entry;
}

test('A → B → A reuses each source, while another document gets its own session', async () => {
  const registry = new DocumentSessions();
  const a = await opened(registry, 'file1', 'A');
  const b = await opened(registry, 'file1', 'B');
  const other = await opened(registry, 'file2', 'A');
  const op = registry.begin('file1', () => {});
  assert.equal(await registry.open(op, 'A', async () => { throw new Error('must not reconnect'); }), a);
  op.finish();
  assert.notEqual(other.session, a.session);
  assert.equal(a.session.closed, 0);
  assert.equal(b.session.closed, 0);
  await registry.closeAll();
});

test('only one operation per document, including preparation; unrelated documents remain independent', () => {
  const registry = new DocumentSessions();
  const op = registry.begin('file1', () => {});
  assert.equal(registry.begin('file1', () => {}), undefined);
  const other = registry.begin('file2', () => {});
  assert.ok(other);
  op.finish();
  assert.ok(registry.begin('file1', () => {}));
  other.finish();
});

test('a snapshot expires on the next statement, including failed or explain requests', async () => {
  const registry = new DocumentSessions();
  const entry = await opened(registry, 'file1', 'A');
  const op = registry.begin('file1', () => {});
  op.profileId = 'A';
  registry.startStatement(op, entry);
  const snapshot = registry.snapshot(entry);
  assert.equal(registry.validate(snapshot), entry);
  registry.startStatement(op, entry);
  assert.throws(() => registry.validate(snapshot), SessionExpiredError);
  op.finish();
});

test('executing on another source does not change the original source snapshot', async () => {
  const registry = new DocumentSessions();
  const a = await opened(registry, 'file1', 'A');
  const snapshot = registry.snapshot(a);
  const b = await opened(registry, 'file1', 'B');
  const op = registry.begin('file1', () => {});
  op.profileId = 'B';
  registry.startStatement(op, b);
  assert.equal(registry.validate(snapshot), a);
  op.finish();
});

test('closing a file invalidates snapshots immediately, cancels and waits for draining, then closes all its sources', async () => {
  const registry = new DocumentSessions();
  const a = await opened(registry, 'file1', 'A');
  const b = await opened(registry, 'file1', 'B');
  const other = await opened(registry, 'file2', 'A');
  const snapshot = registry.snapshot(a);
  let cancelled = 0;
  const op = registry.begin('file1', () => { cancelled += 1; });
  op.profileId = 'A';
  const closing = registry.closeDocument('file1');
  assert.equal(cancelled, 1);
  assert.equal(a.session.closed, 0);
  assert.equal(registry.begin('file1', () => {}), undefined);
  assert.throws(() => registry.validate(snapshot), SessionExpiredError);
  op.finish();
  await closing;
  assert.equal(a.session.closed, 1);
  assert.equal(b.session.closed, 1);
  assert.equal(other.session.closed, 0);
});

test('changing a connection invalidates it across files, preserving other sources and their running operations', async () => {
  const registry = new DocumentSessions();
  const a = await opened(registry, 'file1', 'A');
  const a2 = await opened(registry, 'file2', 'A');
  const b = await opened(registry, 'file1', 'B');
  let cancelled = false;
  const op = registry.begin('file1', () => { cancelled = true; });
  op.profileId = 'B';
  await registry.closeProfile('A');
  assert.equal(cancelled, false);
  assert.equal(a.session.closed, 1);
  assert.equal(a2.session.closed, 1);
  assert.equal(b.session.closed, 0);
  op.finish();
});

test('closing a connection during handshake closes the late arrival and never installs it', async () => {
  const registry = new DocumentSessions();
  const gate = deferred();
  const connection = session();
  const op = registry.begin('file1', () => {});
  const pending = registry.open(op, 'A', () => gate.promise);
  const rejected = assert.rejects(pending, /已取消/);
  const closing = registry.closeProfile('A');
  gate.resolve(connection);
  await rejected;
  op.finish();
  await closing;
  assert.equal(connection.closed, 1);
  assert.equal(registry.hasProfile('A'), false);
});

test('resetting and reopening never makes an old result valid again', async () => {
  const registry = new DocumentSessions();
  const old = await opened(registry, 'file1', 'A');
  const snapshot = registry.snapshot(old);
  await registry.closeDocument('file1');
  const current = await opened(registry, 'file1', 'A');
  assert.notEqual(current, old);
  assert.throws(() => registry.validate(snapshot), SessionExpiredError);
});

test('broken connections are discarded without silently executing on a new connection', async () => {
  const registry = new DocumentSessions();
  const old = await opened(registry, 'file1', 'A');
  old.session.broken = true;
  const op = registry.begin('file1', () => {});
  await assert.rejects(registry.open(op, 'A', async () => { throw new Error('must not reconnect'); }), /状态已丢失/);
  op.finish();
  assert.equal(old.session.closed, 1);
});

test('shutdown cancels preparation and prevents new operations; overlapping releases close each connection once', async () => {
  const registry = new DocumentSessions();
  const entry = await opened(registry, 'file1', 'A');
  const op = registry.begin('file1', () => {});
  op.profileId = 'A';
  const profileClose = registry.closeProfile('A');
  const allClose = registry.closeAll();
  assert.equal(op.cancelled, true);
  assert.equal(registry.begin('file2', () => {}), undefined);
  op.finish();
  await Promise.all([profileClose, allClose]);
  assert.equal(entry.session.closed, 1);
});
