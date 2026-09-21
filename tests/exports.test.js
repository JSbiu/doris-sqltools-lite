const assert = require('node:assert/strict');
const test = require('node:test');

const {
  displayValue,
  isExportFormat,
  needsFormulaEscape,
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

test('classifies the prefixes a spreadsheet would evaluate', () => {
  // `=` and `@` are unambiguous formula triggers.
  assert.equal(needsFormulaEscape('=1+1'), true);
  assert.equal(needsFormulaEscape('@SUM(A1)'), true);
  assert.equal(needsFormulaEscape("=cmd|' /c calc'!A0"), true);
  // `+`/`-` only when what follows is not a plain number, otherwise every
  // negative number would land in the sheet as text.
  assert.equal(needsFormulaEscape('-2+3'), true);
  assert.equal(needsFormulaEscape('+cmd|x'), true);
  assert.equal(needsFormulaEscape('-5'), false);
  assert.equal(needsFormulaEscape('+3.5'), false);
  assert.equal(needsFormulaEscape('-1.2e3'), false);
  // Everything else is untouched.
  assert.equal(needsFormulaEscape('plain'), false);
  assert.equal(needsFormulaEscape(''), false);
  assert.equal(needsFormulaEscape('北京'), false);
});

test('prefixes a formula-shaped cell with the spreadsheet text marker', () => {
  const tsv = toTsv(
    [{ a: '=1+1', b: '@SUM(1)', c: '-2+3', d: 'plain', e: '-5' }],
    ['a', 'b', 'c', 'd', 'e'],
  );

  assert.equal(tsv.split('\r\n')[1], "'=1+1\t'@SUM(1)\t'-2+3\tplain\t-5");
});

test('keeps the marker inside the quotes when the value also needs quoting', () => {
  const row = toTsv([{ a: '=x\ty' }], ['a']).split('\r\n')[1];

  assert.equal(row, `"'=x\ty"`);
});

test('escapes a column name that looks like a formula', () => {
  assert.equal(toTsv([], ['=col']), "'=col");
});

test('can export the stored value verbatim when escaping is turned off', () => {
  const row = toTsv([{ a: '=1+1' }], ['a'], { escapeFormulas: false }).split('\r\n')[1];

  assert.equal(row, '=1+1');
});

test('honours a custom block size together with escaping', () => {
  const rows = [{ a: '=1' }, { a: '=2' }, { a: '=3' }];

  assert.deepEqual([...toTsvBlocks(rows, ['a'], 2, { escapeFormulas: true })], [
    'a\r\n',
    "'=1\r\n'=2\r\n",
    "'=3\r\n",
  ]);
});
