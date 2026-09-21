'use strict';

// Live check of the streaming query path against a real MySQL server.
//
// `pnpm test` covers the logic with fake streams; this covers what a fake
// cannot: mysql2's actual Query.stream() behaviour, the ResultSetHeader branch
// for non-SELECT statements, whether a cancel leaves the connection clean, and
// the re-run export flow. It is not part of `pnpm test` because it needs a
// server, and it never runs by itself.
//
// Usage:
//   node scripts/check-live-mysql.js --host=127.0.0.1 --port=13306 \
//     --user=e2e --password=secret --database=e2e --seed
//
// --seed creates the two tables it needs and fills them (7 typed rows and
// 30000 plain rows). Without it the tables must already exist. Point this at a
// throwaway database: --seed truncates both tables.

const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');

const { openMysqlSession } = require('../out/mysqlSession.js');
const { createRowCollector } = require('../out/queryResults.js');
const { encodeTsvHeader, encodeTsvRows } = require('../out/exports.js');

const BIG_ROW_COUNT = 30000;
const MAX_KEPT = 1000;

function parseArgs(argv) {
  const options = {
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: '',
    database: 'e2e',
    seed: false,
  };
  for (const arg of argv) {
    if (arg === '--seed') {
      options.seed = true;
      continue;
    }
    const match = /^--([a-zA-Z]+)=(.*)$/.exec(arg);
    if (!match) {
      continue;
    }
    const [, key, value] = match;
    if (key === 'port') {
      options.port = Number(value);
    } else if (key in options) {
      options[key] = value;
    }
  }
  return options;
}

// Executed one statement at a time -- the connection runs with
// multipleStatements disabled, same as the extension.
const SEED_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS types_demo (
     id INT PRIMARY KEY AUTO_INCREMENT,
     label VARCHAR(64),
     big BIGINT,
     amount DECIMAL(18,4),
     ratio DOUBLE,
     flag TINYINT,
     created DATETIME,
     note TEXT,
     payload VARBINARY(64)
   ) ENGINE=InnoDB`,
  'TRUNCATE TABLE types_demo',
  `INSERT INTO types_demo (label, big, amount, ratio, flag, created, note, payload) VALUES
     ('plain', 42, 12.3400, 1.5, 1, '2026-09-21 10:00:00', 'hello', X'DEADBEEF'),
     ('all nulls', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
     ('beyond safe int', 9007199254740993, 12345678901234.5678, 2.5, 0, '2026-01-02 03:04:05', 'wide', NULL),
     (NULL, 1, 0.0001, 0, 1, '2026-01-02 03:04:05', 'tab\\there and\\nnewline', X'00'),
     ('formula at sign', 2, 1.0, 1, 1, '2026-01-02 03:04:05', '=cmd|calc', NULL),
     ('leading plus', 3, 2.0, 1, 1, '2026-01-02 03:04:05', '+123', NULL),
     ('quote inside', 4, 3.0, 1, 1, '2026-01-02 03:04:05', 'say "hi"', NULL)`,
  `CREATE TABLE IF NOT EXISTS big_rows (
     id INT PRIMARY KEY AUTO_INCREMENT,
     name VARCHAR(32),
     value INT
   ) ENGINE=InnoDB`,
  'TRUNCATE TABLE big_rows',
  `SET SESSION cte_max_recursion_depth = ${BIG_ROW_COUNT + 1000}`,
  `INSERT INTO big_rows (name, value)
   WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${BIG_ROW_COUNT})
   SELECT CONCAT('row-', n), n * 7 FROM seq`,
];

function noCancel() {
  return { requested: false, onRequest: () => ({ dispose: () => undefined }) };
}

function cancellable() {
  const listeners = new Set();
  const signal = {
    requested: false,
    onRequest(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  return {
    signal,
    cancel() {
      signal.requested = true;
      for (const listener of [...listeners]) {
        listener();
      }
    },
  };
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === undefined ? '' : `  [${detail}]`}`);
}

async function seed(session) {
  for (const statement of SEED_STATEMENTS) {
    await session.execute(statement, noCancel(), createRowCollector(1));
  }
  console.log('  seeded types_demo and big_rows');
}

async function checkSmallResult(session) {
  const collector = createRowCollector(MAX_KEPT);
  const summary = await session.execute('SELECT * FROM types_demo ORDER BY id', noCancel(), collector);
  const view = collector.toView();

  record('small: every row read', summary.rowsRead === 7 && view.rows.length === 7, summary.rowsRead);
  record(
    'small: column names',
    view.columns.join(',') === 'id,label,big,amount,ratio,flag,created,note,payload',
    view.columns.join(','),
  );
  record('small: not truncated', view.truncated === false);

  const first = view.rows[0];
  const second = view.rows[1];
  const third = view.rows[2];
  record(
    'BIGINT stays an exact string',
    first.big === '42' && third.big === '9007199254740993',
    `${first.big} / ${third.big}`,
  );
  record('NULL comes back as null', second.label === 'all nulls' && second.big === null);
  record('BINARY comes back as a Buffer', Buffer.isBuffer(first.payload), typeof first.payload);
  record('DECIMAL keeps its scale', String(third.amount) === '12345678901234.5678', String(third.amount));
}

async function checkLargeResult(session) {
  const collector = createRowCollector(MAX_KEPT);
  const summary = await session.execute('SELECT * FROM big_rows ORDER BY id', noCancel(), collector);
  const view = collector.toView();

  record('large: every row counted', summary.rowsRead === BIG_ROW_COUNT, summary.rowsRead);
  record('large: only the cap is kept', view.rows.length === MAX_KEPT, view.rows.length);
  record('large: marked truncated', view.truncated === true);
  record('large: first row intact', view.rows[0].name === 'row-1', JSON.stringify(view.rows[0]));
}

async function checkAffectedRows(session) {
  const insert = await session.execute(
    "INSERT INTO types_demo (label, big) VALUES ('inserted', 7), ('inserted2', 8)",
    noCancel(),
    createRowCollector(10),
  );
  record('INSERT: affectedRows from the header packet', insert.affectedRows === 2, insert.affectedRows);
  record('INSERT: reads no rows', insert.rowsRead === 0, insert.rowsRead);

  const update = await session.execute(
    "UPDATE types_demo SET note = 'touched' WHERE label LIKE 'inserted%'",
    noCancel(),
    createRowCollector(10),
  );
  record('UPDATE: affectedRows', update.affectedRows === 2, update.affectedRows);

  const remove = await session.execute(
    "DELETE FROM types_demo WHERE label LIKE 'inserted%'",
    noCancel(),
    createRowCollector(10),
  );
  record('DELETE: affectedRows', remove.affectedRows === 2, remove.affectedRows);

  const create = await session.execute(
    'CREATE TABLE IF NOT EXISTS ddl_probe (id INT)',
    noCancel(),
    createRowCollector(10),
  );
  record('DDL: runs with no result set', create.rowsRead === 0 && create.affectedRows === 0, `${create.rowsRead}/${create.affectedRows}`);
  await session.execute('DROP TABLE IF EXISTS ddl_probe', noCancel(), createRowCollector(10));
}

async function checkErrorPath(session) {
  try {
    await session.execute('SELECT * FROM no_such_table_here', noCancel(), createRowCollector(10));
    record('missing table raises', false, 'no error');
  } catch (error) {
    record('missing table raises', /no_such_table_here/i.test(error.message), error.message.slice(0, 60));
  }

  try {
    await session.execute('SELEC 1', noCancel(), createRowCollector(10));
    record('syntax error raises', false, 'no error');
  } catch (error) {
    record('syntax error raises', /syntax|SELEC/i.test(error.message), error.message.slice(0, 60));
  }

  const collector = createRowCollector(10);
  const summary = await session.execute('SELECT 1 AS ok', noCancel(), collector);
  // `SELECT 1` is typed BIGINT, and the connection sets supportBigNumbers +
  // bigNumberStrings so big integers stay exact -- which stringifies plain
  // integer literals too. Pre-existing behaviour, unrelated to streaming.
  const value = collector.toView().rows[0]?.ok;
  record('session usable after an error', summary.rowsRead === 1 && String(value) === '1', JSON.stringify(value));
}

async function checkCancelKeepsConnectionUsable(session) {
  const control = cancellable();
  const collector = createRowCollector(MAX_KEPT);
  let reached = 0;
  const sink = {
    onColumns: (columns) => collector.onColumns(columns),
    onAffectedRows: (count) => collector.onAffectedRows(count),
    onRow: (row) => {
      collector.onRow(row);
      reached = collector.totalRows();
      if (reached === 2000) {
        control.cancel();
      }
    },
  };

  let cancelled = false;
  try {
    await session.execute(
      'SELECT a.id AS a_id, b.id AS b_id FROM big_rows a, big_rows b LIMIT 5000000',
      control.signal,
      sink,
    );
  } catch (error) {
    cancelled = error.name === 'QueryCancelledError';
    if (!cancelled) {
      record('cancel: unexpected error type', false, `${error.name}: ${error.message.slice(0, 60)}`);
    }
  }
  record('cancel: raises QueryCancelledError', cancelled, `stopped after ${reached} rows`);

  // The half that matters most: the connection has to be clean afterwards, not
  // carrying leftover packets from the statement that was killed.
  try {
    const after = createRowCollector(10);
    const summary = await session.execute('SELECT COUNT(*) AS c FROM big_rows', noCancel(), after);
    const value = after.toView().rows[0]?.c;
    record('cancel: connection still usable', summary.rowsRead === 1 && String(value) === String(BIG_ROW_COUNT), `COUNT=${value}`);
  } catch (error) {
    record('cancel: connection still usable', false, error.message.slice(0, 80));
  }
}

// Mirrors what runForExport does: its own session, the statement run again,
// rows streamed straight to disk without being collected first.
async function checkExportRerun(profile, password) {
  const target = path.join(__dirname, '..', '.local', 'live-export-check.tsv');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const session = await openMysqlSession(profile, password);
  const chunkRows = 5000;
  const out = fs.createWriteStream(target, { encoding: 'utf8' });
  const write = async (text) => {
    if (!out.write(text)) {
      await once(out, 'drain');
    }
  };

  let columns = [];
  let buffer = [];
  let written = 0;
  let headerWritten = false;

  const flush = async () => {
    if (!headerWritten) {
      headerWritten = true;
      await write(encodeTsvHeader(columns, {}));
    }
    written += buffer.length;
    const block = encodeTsvRows(buffer, columns, {});
    buffer = [];
    await write(block);
  };

  try {
    const sink = {
      onColumns: (next) => {
        columns = next;
      },
      onAffectedRows: () => undefined,
      onRow: async (row) => {
        buffer.push(row);
        if (buffer.length >= chunkRows) {
          await flush();
        }
      },
    };
    await session.execute('SELECT id, name, value FROM big_rows ORDER BY id', noCancel(), sink);
    if (buffer.length > 0) {
      await flush();
    }
    await new Promise((resolve) => out.end(resolve));
  } finally {
    await session.close();
  }

  const lines = fs
    .readFileSync(target, 'utf8')
    .split('\r\n')
    .filter((line) => line.length > 0);

  record('rerun export: every row written', written === BIG_ROW_COUNT, written);
  record('rerun export: header + rows', lines.length === BIG_ROW_COUNT + 1, lines.length);
  record('rerun export: header intact', lines[0] === 'id\tname\tvalue', lines[0]);
  record(
    'rerun export: last line correct',
    lines[lines.length - 1] === `${BIG_ROW_COUNT}\trow-${BIG_ROW_COUNT}\t${BIG_ROW_COUNT * 7}`,
    lines[lines.length - 1],
  );

  fs.rmSync(target, { force: true });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const profile = {
    id: 'live-check',
    name: 'live-check',
    type: 'MySQL',
    host: options.host,
    port: options.port,
    database: options.database,
    username: options.user,
  };

  console.log(`live check against ${options.host}:${options.port} (database ${options.database})`);
  const session = await openMysqlSession(profile, options.password);
  try {
    if (options.seed) {
      await seed(session);
    }
    await checkSmallResult(session);
    await checkLargeResult(session);
    await checkAffectedRows(session);
    await checkErrorPath(session);
    await checkCancelKeepsConnectionUsable(session);
  } finally {
    await session.close();
  }
  await checkExportRerun(profile, options.password);

  const failed = results.filter((entry) => !entry.ok);
  console.log(
    failed.length === 0
      ? `\nall good (${results.length} checks)`
      : `\n${failed.length} of ${results.length} check(s) FAILED: ${failed.map((entry) => entry.name).join('; ')}`,
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('harness crashed:', error);
  process.exitCode = 1;
});
