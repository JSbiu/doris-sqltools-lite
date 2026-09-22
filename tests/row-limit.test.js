const assert = require('node:assert/strict');
const test = require('node:test');

const { applyRowLimit } = require('../out/rowLimit.js');

const LIMIT = 1000;

// Every case that must get the cap pushed down, with the exact statement
// expected out. Keeping the expected text literal is the point: a rule that
// silently rewrites the user's SQL has to be pinned down character by character.
const INJECTS = [
  ['plain select', 'SELECT * FROM t', 'SELECT * FROM t LIMIT 1000'],
  ['lowercase verb', 'select * from t', 'select * from t LIMIT 1000'],
  ['mixed-case verb', 'SeLeCt 1', 'SeLeCt 1 LIMIT 1000'],
  ['surrounding whitespace', '  SELECT 1  ', '  SELECT 1 LIMIT 1000  '],
  ['leading line comment', '-- pick one\nSELECT 1', '-- pick one\nSELECT 1 LIMIT 1000'],
  ['leading block comment', '/* c */ SELECT 1', '/* c */ SELECT 1 LIMIT 1000'],
  ['leading hash comment', '# note\nSELECT 1', '# note\nSELECT 1 LIMIT 1000'],
  ['trailing semicolon', 'SELECT 1;', 'SELECT 1 LIMIT 1000;'],
  ['semicolon then newline', 'SELECT 1 ;\n', 'SELECT 1 LIMIT 1000 ;\n'],
  ['ORDER BY', 'SELECT * FROM t ORDER BY v', 'SELECT * FROM t ORDER BY v LIMIT 1000'],
  [
    'LIMIT inside a subquery is not the answer bound',
    'SELECT * FROM t WHERE id IN (SELECT id FROM t2 LIMIT 5)',
    'SELECT * FROM t WHERE id IN (SELECT id FROM t2 LIMIT 5) LIMIT 1000',
  ],
  [
    'LIMIT inside a FROM subquery',
    'SELECT * FROM (SELECT * FROM t LIMIT 5) x',
    'SELECT * FROM (SELECT * FROM t LIMIT 5) x LIMIT 1000',
  ],
  ['the word limit in a string', "SELECT 'limit' FROM t", "SELECT 'limit' FROM t LIMIT 1000"],
  ['a backticked identifier named limit', 'SELECT `limit` FROM t', 'SELECT `limit` FROM t LIMIT 1000'],
  ['LIMIT inside a block comment', 'SELECT 1 /* LIMIT 5 */', 'SELECT 1 /* LIMIT 5 */ LIMIT 1000'],
  ['the word LIMITED is not LIMIT', 'SELECT limited FROM t', 'SELECT limited FROM t LIMIT 1000'],
  [
    'multi-line statement',
    'SELECT a,\n       b\nFROM t\nWHERE a > 1',
    'SELECT a,\n       b\nFROM t\nWHERE a > 1 LIMIT 1000',
  ],
  ['cap of one', 'SELECT 1', 'SELECT 1 LIMIT 1', 1],
];

// A trailing line comment would swallow anything appended on the same line, so
// the cap has to start a new one -- otherwise the statement stays unbounded
// while we believe it is capped.
const LINE_COMMENT_TAIL = [
  ['line comment at the end', 'SELECT 1 -- note', 'SELECT 1 -- note\nLIMIT 1000'],
  ['hash comment at the end', 'SELECT 1 # note', 'SELECT 1 # note\nLIMIT 1000'],
  ['comment then trailing newline', 'SELECT 1 -- note\n', 'SELECT 1 -- note\nLIMIT 1000\n'],
];

const SKIPS = [
  ['CREATE TABLE AS SELECT', 'CREATE TABLE x AS SELECT * FROM t'],
  ['lowercase CTAS', 'create table x as select 1'],
  ['INSERT ... SELECT', 'INSERT INTO x SELECT * FROM t'],
  ['INSERT ... VALUES', 'INSERT INTO x VALUES (1)'],
  ['UPDATE', 'UPDATE t SET a = 1'],
  ['DELETE', 'DELETE FROM t'],
  ['two statements', 'SELECT 1; SELECT 2'],
  ['two statements across lines', 'SELECT 1;\nSELECT 2'],
  ['trailing double terminator', 'SELECT 1;;'],
  ['SHOW', 'SHOW TABLES'],
  ['EXPLAIN', 'EXPLAIN SELECT * FROM t'],
  ['DESCRIBE', 'DESCRIBE t'],
  ['WITH ... SELECT', 'WITH c AS (SELECT 1) SELECT * FROM c'],
  ['a LIMIT the user wrote', 'SELECT * FROM t LIMIT 10'],
  ['a user LIMIT with OFFSET', 'SELECT * FROM t LIMIT 10 OFFSET 5'],
  ['a user LIMIT after a subquery', 'SELECT * FROM t WHERE a = (SELECT 1) LIMIT 3'],
  ['comment only', '-- nothing here'],
  ['empty', ''],
  ['whitespace only', '   \n  '],
];

for (const [name, input, expected, limit] of INJECTS) {
  test(`injects — ${name}`, () => {
    assert.equal(applyRowLimit(input, limit ?? LIMIT), expected);
  });
}

for (const [name, input, expected] of LINE_COMMENT_TAIL) {
  test(`injects on a new line — ${name}`, () => {
    assert.equal(applyRowLimit(input, LIMIT), expected);
  });
}

for (const [name, input] of SKIPS) {
  test(`leaves alone — ${name}`, () => {
    assert.equal(applyRowLimit(input, LIMIT), undefined);
  });
}

test('leaves alone — a cap that is not a positive integer', () => {
  for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(applyRowLimit('SELECT 1', limit), undefined, `limit=${limit}`);
  }
});

test('never appends after the terminator', () => {
  const result = applyRowLimit('SELECT * FROM t;', LIMIT);
  assert.ok(result.endsWith('LIMIT 1000;'), result);
  assert.ok(!result.includes('; LIMIT'), result);
});

test('a skipped statement comes back untouched', () => {
  for (const [name, input] of SKIPS) {
    assert.equal(applyRowLimit(input, LIMIT), undefined, name);
  }
});

test('an injected statement is still a single statement', () => {
  const { hasMultipleStatements } = require('../out/queryResults.js');
  // Only the injected set: SKIPS deliberately contains multi-statement inputs,
  // which must stay multi-statement because they are never rewritten.
  for (const [name, input] of INJECTS.concat(LINE_COMMENT_TAIL)) {
    const result = applyRowLimit(input, LIMIT);
    assert.notEqual(result, undefined, name);
    assert.equal(hasMultipleStatements(result), false, `${name}: ${result}`);
  }
});
