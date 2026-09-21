'use strict';
// Spark Thrift Server (HiveServer2) end-to-end check.
//
// Drives the compiled adapter (out/hiveSession.js) against a real Thrift
// endpoint. This is the only way to verify what cannot be read off the driver
// source: protocol version negotiation, the SASL/PLAIN handshake, fetch
// batching, and whether a cancelled statement leaves the session usable.
//
// Not part of `pnpm test` -- it needs a running server.
//
//   node scripts/check-live-spark.js --host=127.0.0.1 --port=10000 --auth=plain
//   node scripts/check-live-spark.js --host=127.0.0.1 --port=10001 --auth=nosasl
//
// `--auth` has to match how the server was started: `--auth none` (HiveServer2's
// default) speaks SASL/PLAIN, `--auth nosasl` speaks raw Thrift. Pointing one at
// the other does not fail fast -- the handshake simply never completes -- which
// is exactly why the adapter carries its own handshake timeout.
//
// The script creates and drops its own tables (`e2e_types`, database `e2e_db`),
// so point it at a scratch server, not at anything you care about.

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const load = (name) => require(path.join(ROOT, 'out', name));

const { openHiveSession } = load('hiveSession.js');
const { createRowCollector } = load('queryResults.js');
const { neverCancelled, QueryCancelledError } = load('querySession.js');
const { classifyDatabaseError } = load('connectionDiagnostics.js');

const argv = new Map();
for (const raw of process.argv.slice(2)) {
  const match = /^--([^=]+)=(.*)$/.exec(raw);
  if (match) {
    argv.set(match[1], match[2]);
  }
}

const HOST = argv.get('host') ?? '127.0.0.1';
const PORT = Number(argv.get('port') ?? 10000);
const USER = argv.get('user') ?? 'hive';
const PASSWORD = argv.get('password') ?? 'ignored';
const AUTH = argv.get('auth') ?? 'plain';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail) {
  const suffix = detail === undefined ? '' : `  [${detail}]`;
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}${suffix}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}${suffix}`);
  }
}

function makeSignal() {
  const listeners = [];
  return {
    requested: false,
    onRequest(listener) {
      listeners.push(listener);
      return { dispose() {} };
    },
    request() {
      this.requested = true;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
const heap = () => {
  global.gc?.();
  return process.memoryUsage().heapUsed;
};

const profile = {
  id: 'e2e-spark',
  name: 'spark-e2e',
  type: 'Spark',
  host: HOST,
  port: PORT,
  username: USER,
  hiveAuth: AUTH,
};

async function query(session, sql, maxRows = 10) {
  const collector = createRowCollector(maxRows);
  const summary = await session.execute(sql, neverCancelled, collector);
  return { summary, view: collector.toView() };
}

async function main() {
  console.log(`\n=== Spark Thrift E2E  ${HOST}:${PORT}  auth=${AUTH} ===\n`);

  // ---------------------------------------------------------- 1. handshake
  console.log('-- connection --');
  const startedAt = Date.now();
  let session;
  try {
    session = await openHiveSession(profile, PASSWORD);
    check(
      'open session: SASL/PLAIN handshake + protocol negotiation',
      true,
      `${Date.now() - startedAt} ms`,
    );
  } catch (error) {
    check('open session', false, String((error && error.message) || error));
    console.log('\ncannot continue without a session');
    process.exit(1);
  }

  // ------------------------------------------------------- 2. scalar types
  console.log('\n-- scalar type decoding --');
  try {
    const { view } = await query(
      session,
      "SELECT CAST(1 AS INT) AS i, CAST(2.5 AS DOUBLE) AS d, 'hi' AS s, true AS b, " +
        'CAST(NULL AS STRING) AS n, CAST(9007199254740993 AS BIGINT) AS big, ' +
        'CAST(1.25 AS DECIMAL(10,2)) AS dec',
    );
    const row = view.rows[0] ?? {};
    check('seven columns announced', view.columns.length === 7, view.columns.join(','));
    check(
      'INT / DOUBLE / STRING / BOOLEAN / NULL decode',
      row.i === 1 && row.d === 2.5 && row.s === 'hi' && row.b === true && row.n === null,
      JSON.stringify(row),
    );
    check(
      'BIGINT past 2^53 stays exact',
      row.big === '9007199254740993',
      `${typeof row.big} ${String(row.big)}`,
    );
    check('DECIMAL arrives as text', String(row.dec) === '1.25', `${typeof row.dec} ${row.dec}`);
  } catch (error) {
    check('scalar types', false, String((error && error.message) || error));
  }

  // ------------------------------------------------------ 3. complex types
  console.log('\n-- complex types --');
  try {
    const { view } = await query(
      session,
      "SELECT array(1,2,3) AS arr, map('a',1,'b',2) AS m, named_struct('x',1,'y','z') AS st",
    );
    const row = view.rows[0] ?? {};
    check(
      'ARRAY / MAP / STRUCT survive as text',
      typeof row.arr === 'string' && row.arr.includes('1') && typeof row.m === 'string' && typeof row.st === 'string',
      JSON.stringify(row),
    );
  } catch (error) {
    check('complex types', false, String((error && error.message) || error));
  }

  // ----------------------------------------------------------- 4. DDL / DML
  console.log('\n-- DDL / DML --');
  try {
    await query(session, 'DROP TABLE IF EXISTS e2e_types', 1);
    await query(session, 'CREATE TABLE e2e_types (i INT, d DOUBLE, s STRING, b BOOLEAN)', 1);
    const insert = await query(
      session,
      "INSERT INTO e2e_types VALUES (1, 1.5, 'a', true), (2, 2.5, NULL, false)",
      1,
    );
    check(
      'CREATE + INSERT accepted, affectedRows numeric',
      Number.isFinite(insert.summary.affectedRows) && insert.summary.affectedRows >= 0,
      `affectedRows=${insert.summary.affectedRows} rowsRead=${insert.summary.rowsRead}`,
    );
    const read = await query(session, 'SELECT * FROM e2e_types ORDER BY i', 10);
    check(
      'table reads back with NULL preserved',
      read.view.totalRows === 2 && read.view.rows[1] && read.view.rows[1].s === null,
      JSON.stringify(read.view.rows),
    );
  } catch (error) {
    check('DDL / DML', false, String((error && error.message) || error));
  }

  // ------------------------------------------------- 5. streaming / memory
  console.log('\n-- large result set (streaming) --');
  const probeSql = "SELECT id, concat('row-', id) AS label, id * 1.5 AS d FROM range(1, 200001)";
  try {
    const beforeCapped = heap();
    const capped = await query(session, probeSql, 1);
    const afterCapped = heap();

    const beforeFull = heap();
    const full = await query(session, probeSql, 200000);
    const afterFull = heap();

    check(
      '200,000 rows counted exactly while keeping 1',
      capped.summary.rowsRead === 200000 && capped.view.rows.length === 1,
      `rowsRead=${capped.summary.rowsRead} kept=${capped.view.rows.length}`,
    );
    check(
      'high cap retains everything (control run)',
      full.view.rows.length === 200000 && full.view.truncated === false,
      `kept=${full.view.rows.length}`,
    );

    const cappedCost = afterCapped - beforeCapped;
    const fullCost = afterFull - beforeCapped - cappedCost;
    check(
      'capped run costs far less memory than full run',
      cappedCost * 4 < fullCost,
      `capped ${mb(cappedCost)} vs full ${mb(fullCost)}`,
    );

    const sample = full.view.rows[999];
    check(
      'row content is correct at batch boundaries',
      sample && sample.id === 1000 && sample.label === 'row-1000',
      JSON.stringify(sample),
    );
  } catch (error) {
    check('large result set', false, String((error && error.message) || error));
  }

  // -------------------------------------------------------- 6. cancellation
  console.log('\n-- cancellation --');
  try {
    const signal = makeSignal();
    let cancelError;
    // Choosing a genuinely slow statement took some digging: `sum(id) FROM
    // range(1, 200000000)` comes back in 89 ms and `count(*)` in 74 ms, because
    // Spark answers aggregates over `range` from statistics without running
    // anything. Even `ORDER BY rand()` over 30M rows finishes in 564 ms. A
    // filtered cross join has to materialise real work, so it is the one that
    // can actually be cancelled.
    const running = session
      .execute(
        'SELECT count(*) AS n FROM range(1, 2000000) a ' +
          'CROSS JOIN range(1, 2000000) b WHERE a.id > b.id',
        signal,
        createRowCollector(10),
      )
      .catch((error) => {
        cancelError = error;
        return undefined;
      });
    setTimeout(() => signal.request(), 1500);
    await running;

    // The server takes a moment to acknowledge CancelOperation, so this asserts
    // the outcome rather than how quickly it arrives.
    check(
      'cancel raises QueryCancelledError',
      cancelError instanceof QueryCancelledError,
      cancelError ? cancelError.name : '(no error thrown)',
    );

    // range(1, 101) yields 1..100, hence 100 rows.
    const revived = await query(session, 'SELECT count(*) AS n FROM range(1, 101)', 10);
    check(
      'session still usable right after a cancel',
      revived.view.rows[0] && Number(revived.view.rows[0].n) === 100,
      JSON.stringify(revived.view.rows[0]),
    );
    check('session not marked broken by the cancel', session.broken === false);
  } catch (error) {
    check('cancellation', false, String((error && error.message) || error));
  }

  // ------------------------------------------------------- 7. error surfacing
  console.log('\n-- error surfacing --');
  try {
    await query(session, 'SELECT * FROM e2e_no_such_table', 1);
    check('missing table raises', false, 'no error thrown');
  } catch (error) {
    const message = String((error && error.message) || error);
    check(
      'missing table raises a real Error with readable text',
      error instanceof Error && message.length > 0 && !message.includes('[object Object]'),
      message.slice(0, 100),
    );
    const advice = classifyDatabaseError(error);
    check(
      'diagnostics classify the failure',
      typeof advice.kind === 'string' && typeof advice.summary === 'string',
      `${advice.kind}: ${advice.summary}`,
    );
  }

  try {
    await query(session, 'SELEC oops', 1);
    check('syntax error raises', false, 'no error thrown');
  } catch (error) {
    const message = String((error && error.message) || error);
    check('syntax error message readable', message.length > 0, message.slice(0, 100));
  }

  // -------------------------------------------------------- 8. USE database
  console.log('\n-- database selection --');
  try {
    await query(session, 'CREATE DATABASE IF NOT EXISTS e2e_db', 1);
    const dbSession = await openHiveSession({ ...profile, database: 'e2e_db' }, PASSWORD);
    try {
      const current = await query(dbSession, 'SELECT current_database() AS db', 10);
      check(
        'USE <database> applied on connect',
        current.view.rows[0] && String(current.view.rows[0].db) === 'e2e_db',
        JSON.stringify(current.view.rows[0]),
      );
    } finally {
      await dbSession.close();
    }
  } catch (error) {
    check('database selection', false, String((error && error.message) || error));
  }

  // --------------------------------------------------- 9. protocol acceptance
  console.log('\n-- protocol version acceptance (raw driver) --');
  try {
    const hive = require(path.join(ROOT, 'node_modules', 'hive-driver'));
    // Must follow --auth: a PLAIN client pointed at a NOSASL server never gets a
    // reply, so the probe would hang forever instead of reporting anything.
    const providerFor = () =>
      AUTH === 'nosasl'
        ? new hive.auth.NoSaslAuthentication()
        : new hive.auth.PlainTcpAuthentication({ username: USER, password: PASSWORD });
    const probeTimeout = (ms) =>
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('probe timeout')), ms));

    const accepted = [];
    for (const version of [10, 9, 8, 7, 6]) {
      const client = new hive.HiveClient(hive.thrift.TCLIService, hive.thrift.TCLIService_types);
      try {
        await Promise.race([
          client.connect({ host: HOST, port: PORT }, new hive.connections.TcpConnection(), providerFor()),
          probeTimeout(8000),
        ]);
        const handle = await Promise.race([
          client.openSession({ client_protocol: version, username: USER, password: PASSWORD }),
          probeTimeout(8000),
        ]);
        accepted.push(version);
        await handle.close().catch(() => undefined);
      } catch {
        // rejected by the server, which is the point of the probe
      } finally {
        try {
          client.close();
        } catch {
          // already gone
        }
      }
    }
    check(
      'the adapter\'s first choice (V10) is accepted without fallback',
      accepted.includes(10),
      `accepted: ${accepted.map((v) => `V${v}`).join(', ') || 'none'}`,
    );
  } catch (error) {
    check('protocol acceptance probe', false, String((error && error.message) || error));
  }

  // ------------------------------------------------ 10. wrong auth mode
  console.log('\n-- authentication mode mismatch --');
  // Declared outside the try, under a deliberately distinct name. A `const`
  // inside the try block is NOT visible from the catch block, and the reference
  // then silently resolves to the outer `startedAt` -- which made `elapsed`
  // measure the whole script's runtime instead of this check's. That mistake
  // hid here for several runs before being spotted.
  const mismatchStartedAt = Date.now();
  try {
    const wrongAuth = AUTH === 'plain' ? 'nosasl' : 'plain';
    await openHiveSession({ ...profile, hiveAuth: wrongAuth }, PASSWORD);
    check('a mismatched auth mode fails fast instead of hanging', false, 'connected unexpectedly');
  } catch (error) {
    const elapsed = Date.now() - mismatchStartedAt;
    const message = String((error && error.message) || error);
    // Either direction is fine as long as it settles: a PLAIN client against a
    // NOSASL server hangs until the handshake timeout fires, while the reverse
    // tends to be rejected outright. What must never happen is a promise that
    // never settles, which is what this guards.
    check(
      'a mismatched auth mode fails instead of hanging',
      elapsed < 60000,
      `${elapsed} ms: ${message.slice(0, 70)}`,
    );
  }

  // ------------------------------------------------ 11. empty credentials
  console.log('\n-- empty credentials --');
  // A blank password must connect. The adapter maps '' to undefined, which makes
  // the driver send its placeholder rather than an empty password; sending the
  // empty string straight through fails with "Error validating the login" even
  // though NONE never checks the value. That distinction is the whole point of
  // this check -- and of the fix it guards.
  {
    const emptyStarted = Date.now();
    let emptyOk = false;
    let emptyMessage = '';
    try {
      const emptySession = await openHiveSession(profile, '');
      try {
        const collector = createRowCollector(5);
        await emptySession.execute('SELECT 1 AS ok', neverCancelled, collector);
        emptyOk = Number(collector.toView().rows[0].ok) === 1;
      } finally {
        await emptySession.close();
      }
    } catch (error) {
      emptyMessage = String((error && error.message) || error);
    }
    check(
      'a blank password connects (mapped to the driver placeholder)',
      emptyOk,
      `${Date.now() - emptyStarted} ms${emptyMessage ? `: ${emptyMessage.slice(0, 70)}` : ''}`,
    );
  }

  {
    const anySession = await openHiveSession(profile, 'x');
    try {
      const collector = createRowCollector(5);
      await anySession.execute('SELECT 1 AS ok', neverCancelled, collector);
      check(
        'any non-empty password also connects',
        Number(collector.toView().rows[0].ok) === 1,
        JSON.stringify(collector.toView().rows[0]),
      );
    } finally {
      await anySession.close();
    }
  }

  // ------------------------------------------------------------ 10. teardown
  console.log('\n-- teardown --');
  await session.close();
  check('close() completes without throwing', true);
  check('closed session reports broken', session.broken === true);

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log(`failed: ${failures.join(' | ')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('harness crashed:', error);
  process.exitCode = 1;
});
