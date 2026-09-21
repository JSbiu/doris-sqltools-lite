const assert = require('node:assert/strict');
const test = require('node:test');

const { decodeHiveResult, decodeHiveRowSet, decodeHiveValue } = require('../out/hiveResult.js');

// node-int64 instances are Buffer subclasses whose toString() yields the decimal
// digits; only that contract is needed here, so a stub keeps the test dependency
// free while still exercising the real code path.
class Int64Stub {
  constructor(text) {
    this.text = text;
  }

  toString() {
    return this.text;
  }
}

function primitive(columnName, position, typeId) {
  return { columnName, position, typeDesc: { types: [{ primitiveEntry: { type: typeId } }] } };
}

const SCHEMA = {
  columns: [primitive('t.id', 0, 4), primitive('name', 1, 7), primitive('score', 2, 6), primitive('flag', 3, 1)],
};

test('decodes a column-oriented row set with typed values', () => {
  const result = decodeHiveResult(SCHEMA, [
    {
      startRowOffset: 0,
      // `t.id` keeps its table prefix on the wire; the panel shows the bare name.
      columns: [
        { i64Val: { values: [new Int64Stub('1'), new Int64Stub('2')], nulls: Buffer.from([0]) } },
        { stringVal: { values: ['alice', 'bob'], nulls: Buffer.from([0]) } },
        { doubleVal: { values: [1.5, 2.5], nulls: Buffer.from([0]) } },
        { boolVal: { values: [true, false], nulls: Buffer.from([0]) } },
      ],
      rows: [],
    },
  ]);

  assert.deepEqual(result.columns, ['id', 'name', 'score', 'flag']);
  assert.deepEqual(result.rows, [
    { id: 1, name: 'alice', score: 1.5, flag: true },
    { id: 2, name: 'bob', score: 2.5, flag: false },
  ]);
});

test('reads nulls from the bitmap instead of from the values array', () => {
  const result = decodeHiveResult(SCHEMA, [
    {
      columns: [
        { i64Val: { values: [new Int64Stub('7'), new Int64Stub('0')], nulls: Buffer.from([0b00000010]) } },
        { stringVal: { values: ['x', ''], nulls: Buffer.from([0b00000010]) } },
        { doubleVal: { values: [0, 0], nulls: Buffer.from([0b00000010]) } },
        { boolVal: { values: [false, false], nulls: Buffer.from([0b00000010]) } },
      ],
    },
  ]);

  assert.deepEqual(result.rows[0], { id: 7, name: 'x', score: 0, flag: false });
  assert.deepEqual(result.rows[1], { id: null, name: null, score: null, flag: null });
});

test('keeps a BIGINT beyond Number.MAX_SAFE_INTEGER as a string', () => {
  assert.equal(decodeHiveValue('i64Val', new Int64Stub('9007199254740993')), '9007199254740993');
  assert.equal(decodeHiveValue('i64Val', new Int64Stub('-9007199254740993')), '-9007199254740993');
  assert.equal(decodeHiveValue('i64Val', new Int64Stub('42')), 42);
  // Thrift hands back plain decimal strings for i64 in some paths.
  assert.equal(decodeHiveValue('i64Val', '123'), 123);
});

test('decodes a signed TINYINT from its single-byte buffer', () => {
  assert.equal(decodeHiveValue('byteVal', Buffer.from([0xff])), -1);
  assert.equal(decodeHiveValue('byteVal', Buffer.from([0x7f])), 127);
  assert.equal(decodeHiveValue('byteVal', 5), 5);
});

test('leaves DECIMAL, TIMESTAMP and complex types as strings', () => {
  // None of these need a conversion, and the raw text is what exports as TSV.
  assert.equal(decodeHiveValue('stringVal', '2026-09-21 10:00:00'), '2026-09-21 10:00:00');
  assert.equal(decodeHiveValue('stringVal', '12.34'), '12.34');
  assert.equal(decodeHiveValue('stringVal', '[1,2,3]'), '[1,2,3]');
  assert.equal(decodeHiveValue('stringVal', '{"a":1}'), '{"a":1}');
});

test('keeps a BINARY column as bytes', () => {
  const bytes = Buffer.from([0x01, 0x02]);
  assert.equal(decodeHiveValue('binaryVal', bytes), bytes);
});

test('falls back to the row-oriented encoding when no columns are present', () => {
  const rows = decodeHiveRowSet(
    {
      rows: [
        { colVals: [{ i64Val: { value: new Int64Stub('1') } }, { stringVal: { value: 'a' } }, {}, {}] },
      ],
    },
    [
      { name: 'id', position: 0 },
      { name: 'name', position: 1 },
      { name: 'score', position: 2 },
      { name: 'flag', position: 3 },
    ],
  );

  // An unset union member is how row-oriented mode encodes NULL.
  assert.deepEqual(rows, [{ id: 1, name: 'a', score: null, flag: null }]);
});

test('merges several fetched batches into one row list', () => {
  const batch = (offset, values) => ({
    startRowOffset: offset,
    columns: [
      { i64Val: { values: values.map((value) => new Int64Stub(String(value))), nulls: Buffer.from([0]) } },
      { stringVal: { values: values.map((value) => `n${value}`), nulls: Buffer.from([0]) } },
      { doubleVal: { values: values.map(() => 0), nulls: Buffer.from([0]) } },
      { boolVal: { values: values.map(() => false), nulls: Buffer.from([0]) } },
    ],
  });

  const result = decodeHiveResult(SCHEMA, [batch(0, [1, 2]), batch(2, [3])]);

  assert.deepEqual(
    result.rows.map((row) => row.id),
    [1, 2, 3],
  );
});

test('returns an empty result for a statement without a result set', () => {
  // DDL: HiveServer2 reports no result set, so there is no schema either.
  assert.deepEqual(decodeHiveResult(null, []), { columns: [], rows: [] });
  assert.deepEqual(decodeHiveResult(null, [{}]), { columns: [], rows: [] });
  assert.deepEqual(decodeHiveResult(SCHEMA, []), { columns: ['id', 'name', 'score', 'flag'], rows: [] });
});

test('numbers unnamed columns so two of them cannot collide', () => {
  const result = decodeHiveResult(
    { columns: [primitive('', 0, 7), primitive('', 1, 7)] },
    [
      {
        columns: [
          { stringVal: { values: ['a'], nulls: Buffer.from([0]) } },
          { stringVal: { values: ['b'], nulls: Buffer.from([0]) } },
        ],
      },
    ],
  );

  assert.deepEqual(result.columns, ['column_1', 'column_2']);
  assert.deepEqual(result.rows, [{ column_1: 'a', column_2: 'b' }]);
});
