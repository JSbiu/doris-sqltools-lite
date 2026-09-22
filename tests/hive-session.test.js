const assert = require('node:assert/strict');
const test = require('node:test');

const { drainHiveRows, hiveAuthPassword, toHiveError } = require('../out/hiveSession.js');

test('keeps the errno when converting a non-Error throwable', () => {
  // Some layers re-throw a socket failure as a plain object rather than an Error.
  // Dropping `code` while converting is what made a failed connection surface as
  // a bare English sentence with no explanation: the diagnostics layer
  // classifies by code, and without one it has nothing to say.
  const wrapped = toHiveError({ code: 'ETIMEDOUT', syscall: 'connect', message: 'connect ETIMEDOUT' });

  assert.equal(wrapped.code, 'ETIMEDOUT');
  assert.match(wrapped.message, /connect ETIMEDOUT/);
});

test('puts the target back into a socket message that lost it', () => {
  // A raw Node socket error reads "connect ETIMEDOUT 10.0.0.5:7011"; when one
  // arrives stripped down to "connect ETIMEDOUT", the address has to be restored
  // from the separate fields or the user cannot tell what was attempted.
  const wrapped = toHiveError({
    code: 'ETIMEDOUT',
    message: 'connect ETIMEDOUT',
    address: '10.0.0.5',
    port: 7011,
  });

  assert.match(wrapped.message, /10\.0\.0\.5:7011/);
  assert.equal(wrapped.code, 'ETIMEDOUT');
});

test('hands a blank password to the driver as undefined, not as an empty string', () => {
  // The driver substitutes its own placeholder for `undefined` ("this server
  // checks nothing"), but frames an explicit '' as a genuinely empty password --
  // which HiveServer2 answers with "Error validating the login" even under NONE.
  // Verified against Spark 3.2.0. Passing '' straight through was the bug.
  assert.equal(hiveAuthPassword(''), undefined);
  assert.equal(hiveAuthPassword('x'), 'x');
  assert.equal(hiveAuthPassword('  '), '  ', 'whitespace is a real value, not a blank one');
});

// A TRowSet in the column-oriented shape Hive and Spark actually send.
function stringRowSet(values) {
  return { columns: [{ stringVal: { values } }] };
}

const schema = { columns: [{ columnName: 'name', position: 0 }] };

// Mimics the real operation: getData() accumulates until flush() resets it, and
// the schema only exists once the first batch has arrived.
function fakeOperation(batches, schemaValue) {
  let index = 0;
  let buffered = [];
  let schemaReady = false;

  const operation = {
    fetchCount: 0,
    flushCount: 0,
    async fetch() {
      operation.fetchCount += 1;
      buffered.push(...(batches[index] ?? []));
      index += 1;
      schemaReady = true;
    },
    hasMoreRows() {
      return index < batches.length;
    },
    getSchema() {
      return schemaReady ? schemaValue : null;
    },
    getData() {
      return buffered;
    },
    flush() {
      operation.flushCount += 1;
      buffered = [];
    },
  };
  return operation;
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
    onAffectedRows() {},
  };
}

test('hands every row over and flushes after each batch', async () => {
  const operation = fakeOperation([[stringRowSet(['a', 'b'])], [stringRowSet(['c'])]], schema);
  const sink = recordingSink();

  const rowsRead = await drainHiveRows(operation, sink, () => false);

  assert.equal(rowsRead, 3);
  assert.deepEqual(sink.rows, [{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
  assert.deepEqual(sink.columns, ['name']);
  assert.equal(operation.fetchCount, 2);
  // Flushing per batch is what stops the driver's own buffer from growing.
  assert.equal(operation.flushCount, 2);
});

test('reads the schema only after the first batch has arrived', async () => {
  const operation = fakeOperation([[stringRowSet(['a'])]], schema);
  assert.equal(operation.getSchema(), null);

  const sink = recordingSink();
  await drainHiveRows(operation, sink, () => false);

  assert.deepEqual(sink.columns, ['name']);
  assert.deepEqual(sink.rows, [{ name: 'a' }]);
});

test('stops fetching once cancellation is observed', async () => {
  const operation = fakeOperation(
    [[stringRowSet(['a'])], [stringRowSet(['b'])], [stringRowSet(['c'])]],
    schema,
  );
  let cancelled = false;
  const sink = {
    onColumns: () => undefined,
    onAffectedRows: () => undefined,    onRow: () => {
      cancelled = true;
    },
  };

  const rowsRead = await drainHiveRows(operation, sink, () => cancelled);

  assert.equal(rowsRead, 1);
  assert.equal(operation.fetchCount, 1);
});

test('handles a statement that returns no rows at all', async () => {
  const operation = fakeOperation([], schema);
  const sink = recordingSink();

  const rowsRead = await drainHiveRows(operation, sink, () => false);

  assert.equal(rowsRead, 0);
  assert.equal(operation.fetchCount, 1);
});

test('waits for an async sink, one row at a time', async () => {
  const operation = fakeOperation([[stringRowSet(['a', 'b'])]], schema);
  const rows = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const sink = {
    onColumns: () => undefined,
    onAffectedRows: () => undefined,
    async onRow(row) {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 1));
      rows.push(row);
      concurrent -= 1;
    },
  };

  await drainHiveRows(operation, sink, () => false);

  assert.equal(rows.length, 2);
  assert.equal(maxConcurrent, 1);
});

test('stops in the middle of a batch when the sink has had enough', async () => {
  // The row limit is decided by the sink (it knows maxResultRows), and a batch
  // is 1000 rows -- so checking only between batches would decode up to 999 rows
  // that are about to be thrown away, and one more fetch on top of that.
  const operation = fakeOperation([[stringRowSet(['a', 'b', 'c', 'd'])]], schema);
  let cancelled = false;
  const delivered = [];
  const sink = {
    columns: undefined,
    onColumns(columns) {
      this.columns = columns;
    },
    onAffectedRows: () => undefined,
    onRow(row) {
      delivered.push(row);
      if (delivered.length === 2) {
        cancelled = true;
      }
    },
  };

  const rowsRead = await drainHiveRows(operation, sink, () => cancelled);

  assert.equal(rowsRead, 2);
  assert.deepEqual(delivered, [{ name: 'a' }, { name: 'b' }]);
  assert.deepEqual(sink.columns, ['name']);
  // Still flushed, so the driver's own buffer does not keep the rest of the batch.
  assert.equal(operation.flushCount, 1);
});

test('does not fetch a further batch after the sink stops it', async () => {
  const operation = fakeOperation(
    [[stringRowSet(['a'])], [stringRowSet(['b'])], [stringRowSet(['c'])]],
    schema,
  );
  let cancelled = false;
  const sink = {
    onColumns: () => undefined,
    onAffectedRows: () => undefined,
    onRow() {
      cancelled = true;
    },
  };

  const rowsRead = await drainHiveRows(operation, sink, () => cancelled);

  assert.equal(rowsRead, 1);
  assert.equal(operation.fetchCount, 1, 'the second and third batches are never asked for');
});
