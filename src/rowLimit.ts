import { hasMultipleStatements } from './queryResults';

// Pushes the row cap into the statement itself, so the server knows the bound
// while it is still planning instead of finding out when the client stops
// reading.
//
// Measured against real servers, 1000-row cap on 2M-row tables:
//
//   Spark 3.2.0   scan 804 -> 64 ms     ORDER BY 1784 -> 358 ms
//   Doris 2.0.9   scan  98 -> 15 ms     ORDER BY  244 ->  33 ms
//   MySQL 8.4.9                         ORDER BY 1218 -> 436 ms
//
// The gain is in the plan, not the transfer: Spark turns `Sort -> Exchange`
// into `TakeOrderedAndProject` (the shuffle disappears), Doris switches to its
// TopN path, MySQL to a top-N filesort. Interrupting the statement once enough
// rows have arrived cannot reach any of that -- on Spark it is worth about 0.2%
// because the answer is already materialised before the first row is sent.
//
// This rewrites the user's SQL, so the guards below are deliberately strict. A
// statement this cannot handle safely falls through to the interrupt path,
// which every protocol already has.
export function applyRowLimit(sql: string, limit: number): string | undefined {
  if (!Number.isInteger(limit) || limit < 1) {
    return undefined;
  }
  // More than one statement: the cap would only bind the first, and the split is
  // already done elsewhere -- not worth guessing here.
  if (hasMultipleStatements(sql)) {
    return undefined;
  }

  const split = splitTrailingTerminator(sql);
  if (!split) {
    return undefined;
  }

  // `SELECT`-first is what keeps every writing form out of reach: `CREATE TABLE
  // AS SELECT ...` and `INSERT INTO ... SELECT ...` start with their own verb,
  // so they are never touched. `WITH` is excluded on purpose -- MySQL 8 allows
  // `WITH ... DELETE`, and telling that apart from `WITH ... SELECT` needs a
  // real parser, not a scan. Those statements still work; they just lose the
  // optimisation and fall back to interrupting.
  const start = skipLeadingNoise(split.body);
  if (!/^select\b/i.test(split.body.slice(start))) {
    return undefined;
  }

  if (hasUnsafeTailClause(split.body)) {
    return undefined;
  }

  // A cap of our own would collide with the user's: `... LIMIT 10 LIMIT 1000` is
  // a syntax error, and silently rewriting a LIMIT the user wrote is worse.
  if (hasTopLevelLimit(split.body)) {
    return undefined;
  }

  // A trailing `-- note` would swallow the clause we append, leaving the
  // statement unbounded while we believe it is capped. Starting a new line costs
  // nothing and keeps the comment intact.
  const separator = endsInsideLineComment(split.body) ? '\n' : ' ';
  return `${split.body}${separator}LIMIT ${limit}${split.tail}`;
}

// True when the body's last line is still open as a `--`/`#` comment.
function endsInsideLineComment(sql: string): boolean {
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];

    if (character === '-' && next === '-' && startsLineComment(sql, index)) {
      const newline = sql.indexOf('\n', index);
      if (newline < 0) {
        return true;
      }
      index = newline + 1;
      continue;
    }
    if (character === '#') {
      const newline = sql.indexOf('\n', index);
      if (newline < 0) {
        return true;
      }
      index = newline + 1;
      continue;
    }
    if (character === '/' && next === '*') {
      const close = sql.indexOf('*/', index + 2);
      index = close < 0 ? sql.length : close + 2;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      index = skipQuoted(sql, index, character);
      continue;
    }
    index += 1;
  }
  return false;
}

interface SplitStatement {
  body: string;
  tail: string;
}

// Separates the part we may append to from whatever has to stay at the very end.
// Statements come from the editor, so they routinely carry a trailing semicolon
// and newline -- appending after those yields `SELECT 1; LIMIT 1000`, which no
// server accepts. Returns undefined when there is nothing left to append to.
function splitTrailingTerminator(sql: string): SplitStatement | undefined {
  let end = sql.length;
  let semicolons = 0;

  while (end > 0) {
    const character = sql[end - 1];
    if (/\s/.test(character)) {
      end -= 1;
      continue;
    }
    if (character === ';') {
      semicolons += 1;
      // Two terminators means the split above did not see this as one
      // statement after all; leave it alone rather than guess.
      if (semicolons > 1) {
        return undefined;
      }
      end -= 1;
      continue;
    }
    break;
  }

  if (end === 0) {
    return undefined;
  }
  return { body: sql.slice(0, end), tail: sql.slice(end) };
}

// Index of the first character that is neither whitespace nor a leading comment.
// A statement pasted with `-- explain` above it is still the same statement.
function skipLeadingNoise(sql: string): number {
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];

    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '-' && next === '-' && startsLineComment(sql, index)) {
      index = endOfLine(sql, index);
      continue;
    }
    if (character === '#') {
      index = endOfLine(sql, index);
      continue;
    }
    if (character === '/' && next === '*') {
      const close = sql.indexOf('*/', index + 2);
      index = close < 0 ? sql.length : close + 2;
      continue;
    }
    break;
  }
  return index;
}

// MySQL only treats `--` as a comment when whitespace (or the end) follows, so
// `a--b` stays an expression. Mirrors the same rule in queryResults.ts.
function startsLineComment(sql: string, index: number): boolean {
  return index + 2 >= sql.length || /\s/.test(sql[index + 2]);
}

function endOfLine(sql: string, index: number): number {
  const newline = sql.indexOf('\n', index);
  return newline < 0 ? sql.length : newline + 1;
}

// Some SELECT variants place syntax after the point where a normal LIMIT is
// accepted. Their plans still benefit from the interrupt path, so keep the
// rewrite conservative rather than changing the statement into a syntax error.
function hasUnsafeTailClause(sql: string): boolean {
  const words = topLevelWords(sql);
  const has = (word: string): boolean => words.includes(word);
  const sequence = (...expected: string[]): boolean =>
    words.some((_, start) => expected.every((word, index) => words[start + index] === word));

  return has('INTO') || has('PROCEDURE')
    || sequence('FOR', 'UPDATE') || sequence('FOR', 'SHARE')
    || sequence('LOCK', 'IN', 'SHARE', 'MODE')
    || sequence('DISTRIBUTE', 'BY') || sequence('SORT', 'BY') || sequence('CLUSTER', 'BY');
}

// Only depth 0 counts: `WHERE id IN (SELECT id FROM t LIMIT 5)` has a LIMIT that
// bounds the subquery rather than the answer. Strings and comments are skipped,
// so words in them cannot disable or trigger the rewrite.
function topLevelWords(sql: string): string[] {
  let depth = 0;
  let index = 0;
  const words: string[] = [];

  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];

    if (character === '-' && next === '-' && startsLineComment(sql, index)) {
      index = endOfLine(sql, index);
      continue;
    }
    if (character === '#') {
      index = endOfLine(sql, index);
      continue;
    }
    if (character === '/' && next === '*') {
      const close = sql.indexOf('*/', index + 2);
      index = close < 0 ? sql.length : close + 2;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      index = skipQuoted(sql, index, character);
      continue;
    }
    if (character === '(') {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === ')') {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    if (depth === 0 && /[A-Za-z_]/.test(character)) {
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end])) end += 1;
      words.push(sql.slice(index, end).toUpperCase());
      index = end;
      continue;
    }
    index += 1;
  }

  return words;
}

function hasTopLevelLimit(sql: string): boolean {
  return topLevelWords(sql).includes('LIMIT');
}

// Returns the index just past the closing quote. Doubled quotes (`''`) and
// backslash escapes both continue the literal.
function skipQuoted(sql: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < sql.length) {
    const character = sql[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === quote) {
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}
