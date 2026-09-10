const assert = require('node:assert/strict');
const test = require('node:test');

const { buildExportFileName, normalizeExportDirectory } = require('../out/exportPath.js');

test('treats missing, blank, and non-string directories as not configured', () => {
  assert.equal(normalizeExportDirectory(undefined), undefined);
  assert.equal(normalizeExportDirectory(null), undefined);
  assert.equal(normalizeExportDirectory(''), undefined);
  assert.equal(normalizeExportDirectory('   '), undefined);
  assert.equal(normalizeExportDirectory(42), undefined);
  assert.equal(normalizeExportDirectory({}), undefined);
});

test('trims a configured export directory', () => {
  assert.equal(normalizeExportDirectory('  D:\\export  '), 'D:\\export');
  assert.equal(normalizeExportDirectory('/tmp/out'), '/tmp/out');
});

test('builds a timestamped file name from the connection title', () => {
  const now = new Date('2026-09-10T03:04:05.678Z');

  assert.equal(buildExportFileName('doris_prod', 'tsv', now), 'query_doris_prod_2026-09-10T03-04-05-678Z.tsv');
});

test('sanitizes separators that cannot appear in a file name', () => {
  const now = new Date('2026-09-10T03:04:05.678Z');

  assert.equal(buildExportFileName('prod/main db', 'tsv', now), 'query_prod_main_db_2026-09-10T03-04-05-678Z.tsv');
});
