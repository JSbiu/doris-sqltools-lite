const assert = require('node:assert/strict');
const test = require('node:test');

const {
  hasSqlParameters,
  parseSqlParameters,
  resolveSqlParameters,
  unescapeDollarPlaceholders,
} = require('../out/sqlParameters.js');

test('finds a plain parameter', () => {
  const sql = "SELECT CAST('${family_created_from}' AS TIMESTAMP)";

  assert.equal(hasSqlParameters(sql), true);
  assert.deepEqual(parseSqlParameters(sql), [
    { name: 'family_created_from', candidates: [], labels: [] },
  ]);
});

test('reports parameters once, in order of first appearance', () => {
  const sql = 'SELECT ${b}, ${a}, ${b} FROM t WHERE x = ${c}';

  assert.deepEqual(
    parseSqlParameters(sql).map((parameter) => parameter.name),
    ['b', 'a', 'c'],
  );
});

test('leaves SQL without parameters alone', () => {
  const sql = 'SELECT 1 AS v';

  assert.equal(hasSqlParameters(sql), false);
  assert.deepEqual(resolveSqlParameters(sql, {}), { sql, missing: [], used: {} });
});

test('reads a single inline value as a default', () => {
  const parameter = parseSqlParameters("where country = '${country=US}'")[0];

  assert.equal(parameter.name, 'country');
  assert.deepEqual(parameter.candidates, ['US']);

  // The default is used when no value is supplied...
  assert.equal(resolveSqlParameters("where c = '${country=US}'", {}).sql, "where c = 'US'");
  assert.deepEqual(resolveSqlParameters("where c = '${country=US}'", {}).missing, []);
  // ...and an explicit value wins over it.
  assert.equal(
    resolveSqlParameters("where c = '${country=US}'", { country: 'CN' }).sql,
    "where c = 'CN'",
  );
});

test('treats a candidate list as a question, not a default', () => {
  const parameter = parseSqlParameters('where c IN (${country=CA, FR, US})')[0];

  assert.deepEqual(parameter.candidates, ['CA', 'FR', 'US']);
  assert.deepEqual(parameter.labels, [undefined, undefined, undefined]);

  // Several candidates mean "choose one" -- there is no default to fall back on.
  const resolution = resolveSqlParameters('where c IN (${country=CA, FR, US})', {});
  assert.deepEqual(resolution.missing, ['country']);
  assert.equal(resolution.sql, 'where c IN (${country=CA, FR, US})');
});

test('reads Hue display labels off candidates', () => {
  const parameter = parseSqlParameters('where c IN (${country=CA(Canada), US(United States)})')[0];

  assert.deepEqual(parameter.candidates, ['CA', 'US']);
  assert.deepEqual(parameter.labels, ['Canada', 'United States']);
});

test('an escaped placeholder is sent literally and never substituted', () => {
  const sql = "SELECT '$${spark.sql.shuffle.partitions}' AS v";

  // Nothing to ask the user about...
  assert.deepEqual(parseSqlParameters(sql), []);
  // ...the escape is unwrapped on the way out, so the server still sees a real
  // placeholder -- which is how a Spark conf reference stays out of our way...
  assert.equal(unescapeDollarPlaceholders(sql), "SELECT '${spark.sql.shuffle.partitions}' AS v");
  assert.equal(resolveSqlParameters(sql, {}).sql, "SELECT '${spark.sql.shuffle.partitions}' AS v");
  // ...and even a value with that exact name must not answer it.
  assert.equal(
    resolveSqlParameters(sql, { 'spark.sql.shuffle.partitions': '2' }).sql,
    "SELECT '${spark.sql.shuffle.partitions}' AS v",
  );
  assert.deepEqual(resolveSqlParameters(sql, {}).missing, []);

  // Escapes and real parameters coexist in one statement.
  assert.equal(resolveSqlParameters('SELECT ${a}, $${b}', { a: '1', b: '2' }).sql, 'SELECT 1, ${b}');

  // The escape also resolves when the statement has no parameters at all.
  assert.equal(resolveSqlParameters('SELECT $${b}', {}).sql, 'SELECT ${b}');
});

test('ignores things that are not parameter names', () => {
  // `${1}` shows up in regex literals; `${}` and an unbalanced brace are typos.
  // None of them may be rewritten, and none may be reported as missing.
  const sql = "SELECT '${1}', '${}', '${a b}', '${unclosed', 'plain $text'";
  const resolution = resolveSqlParameters(sql, { a: 'x' });

  assert.deepEqual(parseSqlParameters(sql), []);
  assert.equal(resolution.sql, sql);
  assert.deepEqual(resolution.missing, []);
});

test('inserts values verbatim, without quoting or escaping', () => {
  // Same contract as Hue: the template owns the quoting. Verifying this matters
  // because it is the reason a text value must be written as '${name}'.
  const resolution = resolveSqlParameters("SELECT '${note}'", { note: "it's\\fine" });

  assert.equal(resolution.sql, "SELECT 'it's\\fine'");
  assert.deepEqual(resolution.used, { note: "it's\\fine" });
});

test('a value may contain characters that would split a statement', () => {
  // Substitution runs after the statement was chosen and split, so this is safe
  // by construction -- but the surrounding text must survive byte for byte.
  const sql = 'SELECT a${gap}b FROM t';
  const resolution = resolveSqlParameters(sql, { gap: ';--\nDROP' });

  assert.equal(resolution.sql, 'SELECT a;--\nDROPb FROM t');
  // Everything outside the placeholder is untouched.
  assert.equal(resolution.sql.replace(';--\nDROP', ''), 'SELECT ab FROM t');
});

test('an empty string falls back to the inline default', () => {
  // The panel posts every field, and a cleared box is '' rather than undefined.
  // Treating that as "no answer" keeps the template's default authoritative.
  assert.equal(resolveSqlParameters('${c=US}', { c: '' }).sql, 'US');
  assert.equal(resolveSqlParameters('${c=US}', { c: '   ' }).sql, '   ');
});

test('a default only has to be written once for repeated names', () => {
  const resolution = resolveSqlParameters("SELECT ${dt=A}, x FROM t WHERE d = '${dt}'", {});

  assert.equal(resolution.sql, "SELECT A, x FROM t WHERE d = 'A'");
  assert.deepEqual(resolution.used, { dt: 'A' });
});

test('reports which values were used, once per name', () => {
  const resolution = resolveSqlParameters('SELECT ${a}, ${a}, ${b}', { a: '1', b: '2' });

  assert.equal(resolution.sql, 'SELECT 1, 1, 2');
  assert.deepEqual(resolution.used, { a: '1', b: '2' });
  assert.deepEqual(resolution.missing, []);
});

test('mixes supplied, defaulted and missing parameters', () => {
  const sql = "SELECT '${given}', '${declared=US}', '${asked}'";
  const resolution = resolveSqlParameters(sql, { given: 'x' });

  // The unanswered one keeps its placeholder so the template stays identifiable.
  assert.equal(resolution.sql, "SELECT 'x', 'US', '${asked}'");
  assert.deepEqual(resolution.used, { given: 'x', declared: 'US' });
  assert.deepEqual(resolution.missing, ['asked']);
});
