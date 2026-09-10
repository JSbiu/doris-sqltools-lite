const assert = require('node:assert/strict');
const test = require('node:test');

const {
  displayValue,
  isExportFormat,
  toTsv,
  toTsvBlocks,
} = require('../out/exports.js');

test('accepts only supported export formats', () => {
  assert.equal(isExportFormat('csv'), false);
  assert.equal(isExportFormat('json'), false);
  assert.equal(isExportFormat('tsv'), true);
  assert.equal(isExportFormat('xml'), false);
  assert.equal(isExportFormat(undefined), false);
});

test('quotes only structurally necessary TSV fields for export and clipboard', () => {
  const tsv = toTsv(
    [{ plain: 'a,b', tab: 'x\ty', note: 'line1\nline2', quote: 'a"b' }],
    ['plain', 'tab', 'note', 'quote'],
  );

  assert.equal(tsv, 'plain\ttab\tnote\tquote\r\na,b\t"x\ty"\t"line1\nline2"\t"a""b"');
});

test('formats TSV with headers', () => {
  assert.equal(toTsv([{ id: 1, name: 'Alice' }], ['id', 'name']), 'id\tname\r\n1\tAlice');
});

test('serializes binary values without connection metadata', () => {
  assert.equal(displayValue(Buffer.from([0, 255])), '0x00ff');
  assert.equal(displayValue(null), '');
});

test('streams TSV as a header block plus bounded row blocks', () => {
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const blocks = [...toTsvBlocks(rows, ['id'], 2)];

  assert.deepEqual(blocks, ['id\r\n', '1\r\n2\r\n', '3\r\n']);
});

test('empty result still emits the header block only', () => {
  assert.deepEqual([...toTsvBlocks([], ['id'], 2)], ['id\r\n']);
});

test('reassembled blocks equal the clipboard payload plus a trailing separator', () => {
  const rows = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }];
  const columns = ['id', 'name'];

  const streamed = [...toTsvBlocks(rows, columns, 1)].join('');

  assert.equal(streamed, `${toTsv(rows, columns)}\r\n`);
});

test('block quoting matches the non-streaming encoder', () => {
  const rows = [{ note: 'x\ty\nz', quote: 'a"b' }];
  const columns = ['note', 'quote'];

  assert.equal([...toTsvBlocks(rows, columns)].join(''), `${toTsv(rows, columns)}\r\n`);
});
