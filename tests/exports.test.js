const assert = require('node:assert/strict');
const test = require('node:test');

const {
  displayValue,
  isExportFormat,
  toDelimited,
  toJson,
} = require('../out/exports.js');

test('accepts only supported export formats', () => {
  assert.equal(isExportFormat('csv'), true);
  assert.equal(isExportFormat('json'), true);
  assert.equal(isExportFormat('tsv'), true);
  assert.equal(isExportFormat('xml'), false);
  assert.equal(isExportFormat(undefined), false);
});

test('quotes CSV fields and preserves special characters', () => {
  const csv = toDelimited(
    [{ name: 'a,b', note: 'line1\nline2', quote: 'a"b' }],
    ['name', 'note', 'quote'],
    ',',
  );

  assert.equal(csv, '"name","note","quote"\r\n"a,b","line1\nline2","a""b"');
});

test('quotes only structurally necessary TSV fields', () => {
  const tsv = toDelimited(
    [{ plain: 'a,b', tab: 'x\ty', note: 'line1\nline2', quote: 'a"b' }],
    ['plain', 'tab', 'note', 'quote'],
    '\t',
  );

  assert.equal(tsv, 'plain\ttab\tnote\tquote\r\na,b\t"x\ty"\t"line1\nline2"\t"a""b"');
});

test('serializes JSON and binary values without connection metadata', () => {
  assert.equal(toJson([{ id: 1 }]), '[\n  {\n    "id": 1\n  }\n]');
  assert.equal(toJson([{ id: 1n }]), '[\n  {\n    "id": "1"\n  }\n]');
  assert.equal(displayValue(Buffer.from([0, 255])), '0x00ff');
  assert.equal(displayValue(null), '');
});
