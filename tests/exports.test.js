const assert = require('node:assert/strict');
const test = require('node:test');

const {
  displayValue,
  isExportFormat,
  toTsv,
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
