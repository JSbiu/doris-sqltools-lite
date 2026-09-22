const assert = require('node:assert/strict');
const test = require('node:test');
const { Readable } = require('node:stream');

const { consumeMysqlStream } = require('../out/mysqlSession.js');

// Shaped like mysql2's Query.stream(): an object-mode Readable that raises
// `fields` before the first row, and with `undefined` when the statement has no
// result set.
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
    affected: [],
    onColumns(columns) {
      this.columns = columns;
    },
    onRow(row) {
      this.rows.push(row);
    },
    onAffectedRows(count) {
      this.affected.push(count);
    },
  };
}

test('keeps a partial row count when the stream fails mid-way', async () => {
  // A row limit stops the statement by killing it, and the driver then reports
  // that interruption as an error. The caller still has the rows it collected,
  // so the count has to survive the throw -- a caller-owned summary is what
  // makes "read 1001 rows" reportable instead of "read nothing".
  const sink = recordingSink();
  const stream = new FakeQueryStream([{ id: 1 }, { id: 2 }], [{ name: 'id' }]);
  stream._read = function read() {
    if (!this.fieldsSent) {
      this.fieldsSent = true;
      this.emit('fields', this.fields);
    }
    this.push(this.items[0]);
    this.destroy(new Error('ER_QUERY_INTERRUPTED: Query execution was interrupted'));
  };
  const summary = { rowsRead: 0, affectedRows: 0 };

  await assert.rejects(() => consumeMysqlStream(stream, sink, () => false, summary));

  assert.equal(summary.rowsRead, 1, 'the row that did arrive is still counted');
  assert.equal(sink.rows.length, 1);
});

test('streams result rows into the sink with their column names', async () => {
  const sink = recordingSink();
  const stream = new FakeQueryStream([{ id: 1 }, { id: 2 }], [{ name: 'id' }]);

  const summary = await consumeMysqlStream(stream, sink, () => false);

  assert.deepEqual(sink.columns, ['id']);
  assert.deepEqual(sink.rows, [{ id: 1 }, { id: 2 }]);
  assert.equal(summary.rowsRead, 2);
  assert.equal(summary.affectedRows, 0);
});

test('announces columns for a result set that turns out to be empty', async () => {
  const sink = recordingSink();
  const stream = new FakeQueryStream([], [{ name: 'id' }]);

  const summary = await consumeMysqlStream(stream, sink, () => false);

  assert.deepEqual(sink.columns, ['id']);
  assert.deepEqual(sink.rows, []);
  assert.equal(summary.rowsRead, 0);
});

test('reads affected rows from the header of a statement with no result set', async () => {
  const sink = recordingSink();
  // mysql2 raises `fields` with undefined here and pushes the ResultSetHeader
  // as the stream's single item.
  const stream = new FakeQueryStream([{ affectedRows: 3, insertId: 0, fieldCount: 0 }], undefined);

  const summary = await consumeMysqlStream(stream, sink, () => false);

  assert.deepEqual(sink.rows, []);
  assert.deepEqual(sink.affected, [3]);
  assert.equal(summary.affectedRows, 3);
  assert.equal(summary.rowsRead, 0);
});

test('keeps draining after a cancel so the socket is left clean', async () => {
  const rows = [];
  let cancelled = false;
  let seen = 0;
  const sink = {
    onColumns: () => undefined,
    onAffectedRows: () => undefined,
    onRow(row) {
      seen += 1;
      if (seen >= 2) {
        cancelled = true;
      }
      rows.push(row);
    },
  };
  const stream = new FakeQueryStream([{ id: 1 }, { id: 2 }, { id: 3 }], [{ name: 'id' }]);

  const summary = await consumeMysqlStream(stream, sink, () => cancelled);

  // Nothing past the cancel point reached the sink...
  assert.equal(summary.rowsRead, 2);
  // ...but the stream was still read through to its end. Breaking out instead
  // would leave unread packets on the wire to be parsed as the next statement's
  // answer. `destroyed` is true either way -- Readable destroys itself on a
  // normal end as well -- so `readableEnded` is what tells the two apart.
  assert.equal(stream.readableEnded, true);
});

test('an early break leaves the stream unfinished, which is why we drain', async () => {
  // Guards the assumption the test above rests on: a stream abandoned mid-read
  // reports readableEnded = false, while one drained to the end reports true.
  // Without this, that assertion would hold either way and prove nothing.
  const stream = new Readable({
    objectMode: true,
    read() {
      this.push({ id: 1 });
    },
  });

  for await (const item of stream) {
    void item;
    break;
  }

  assert.equal(stream.readableEnded, false);
});

test('waits for an async sink, one row at a time', async () => {
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
  const stream = new FakeQueryStream([{ id: 1 }, { id: 2 }, { id: 3 }], [{ name: 'id' }]);

  await consumeMysqlStream(stream, sink, () => false);

  assert.equal(rows.length, 3);
  assert.equal(concurrent, 0);
  assert.equal(maxConcurrent, 1);
});
