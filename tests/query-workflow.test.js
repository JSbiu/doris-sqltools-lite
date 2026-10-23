const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');
const os = require('node:os');
const { DocumentSessions } = require('../out/documentSessions');

// Exercise the real runner with fake database sessions: no network or VS Code
// host is needed, and a mistakenly executed original SQL is observable here.
function harness(sql, options = {}) {
  const calls = { executed: [], opened: [], closed: [], forms: [], plans: [], results: [], notices: [], writes: [] };
  const profiles = [
    { id: 'spark', name: 'Spark数仓', type: 'Spark' },
    { id: 'mysql', name: 'MySQL业务库', type: 'MySQL' },
  ];
  const disposable = () => ({ dispose() {} });
  class CancellationTokenSource {
    listeners = new Set();
    token = { isCancellationRequested: false, onCancellationRequested: (listener) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    } };
    cancel() {
      if (this.token.isCancellationRequested) return;
      this.token.isCancellationRequested = true;
      for (const listener of [...this.listeners]) listener();
    }
    dispose() { this.listeners.clear(); }
  }
  const editor = {
    document: {
      languageId: 'sql', fileName: '/queries.sql',
      uri: { scheme: 'file', toString: () => 'file:///queries.sql' },
      getText: () => sql, offsetAt: (position) => position,
    },
    selection: { isEmpty: true, start: options.offset ?? 0, end: options.offset ?? 0 },
  };
  const vscode = {
    TreeItem: class {}, CancellationTokenSource,
    ProgressLocation: { Notification: 15 },
    window: {
      activeTextEditor: editor,
      showInformationMessage: async (text) => { calls.notices.push(text); },
      showWarningMessage: async (text, ...buttons) => { calls.notices.push(text); return buttons.includes('继续导出') ? '继续导出' : undefined; },
      showSaveDialog: async () => { calls.saveDialogs = (calls.saveDialogs ?? 0) + 1; return options.saveDialog ? options.saveDialog() : options.target; },
      withProgress: async (_config, task) => task({ report() {} }, new CancellationTokenSource().token),
      showQuickPick: async () => { throw new Error('unexpected connection picker'); },
    },
    workspace: {
      fs: { writeFile: async (uri, bytes) => calls.writes.push({ uri, text: bytes.toString('utf8') }) },
      getConfiguration: () => ({ get: (key, fallback) => ({ maxResultRows: 2, readRowLimit: 0, ...options.settings })[key] ?? fallback }),
    },
    Uri: { file: (fsPath) => ({ scheme: 'file', fsPath }) },
  };
  const filename = path.resolve(__dirname, '../out/extension.js');
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  const sandbox = {
    module, exports: module.exports, console, Buffer, process, setTimeout, clearTimeout, setImmediate,
    require: (id) => {
      if (id === 'vscode') return vscode;
      if (id === './connectionManager') return {
        showError: (_label, error) => { throw error; },
        sameConnectionTarget: (a, b) => a.type === b.type && a.host === b.host && a.database === b.database,
      };
      if (id === './connectionForm') return {};
      if (id === './parameterForm') return { openParameterForm: async (inputs) => {
        calls.forms.push(inputs);
        return options.decision;
      } };
      if (id === './planPanel') return { openPlanPanel: (snapshot) => calls.plans.push(snapshot) };
      return realRequire(id);
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.hooks = { runQuery, prepareStatementSql, ResultPanel, setParameterState: (state) => { parameterState = state; } };', sandbox);
  const hooks = module.exports.hooks;
  hooks.ResultPanel.open = (result, metadata) => calls.results.push({ result, metadata });
  const makeSession = (id) => ({
    broken: false, close: async () => { calls.closed.push(id); },
    execute: async (statement, signal, sink) => {
      calls.executed.push(statement);
      sink.onColumns(['plan']);
      for (let i = 0; i < (options.rowCount ?? 1); i++) await sink.onRow({ plan: `  +- node ${i}` });
      return { rowsRead: options.rowCount ?? 1, affectedRows: 0 };
    },
  });
  const session = makeSession('spark');
  const profileSessions = new Map([['spark', session], ['mysql', makeSession('mysql')]]);
  const manager = {
    getProfiles: () => profiles,
    open: async (profile) => { calls.opened.push(profile.id); return profileSessions.get(profile.id); },
  };
  const state = { documentConnections: new Map(), sessions: new DocumentSessions(), runningDocuments: new Set(), cancellationSources: new Map() };
  const seed = async (id = 'spark') => {
    const operation = state.sessions.begin(editor.document.uri.toString(), () => {});
    const entry = await state.sessions.open(operation, id, async () => profileSessions.get(id));
    operation.finish();
    return entry;
  };
  const panelFor = (index = calls.results.length - 1) => {
    const panel = new hooks.ResultPanel({});
    panel.result = calls.results[index].result;
    panel.metadata = calls.results[index].metadata;
    return panel;
  };
  return { calls, hooks, editor, manager, state, session, profileSessions, profiles, options, seed, panelFor, run: (explain = false) => hooks.runQuery(manager, state, undefined, undefined, explain) };
}

test('normal execution routes each statement, substitutes comment parameters and displays its name', async () => {
  const sql = "-- @default-connection: Spark数仓\n-- @default-param: day = 2026-10-21\n-- @name: 订单\nSELECT '${day}';\n-- @connection: MySQL业务库\n-- @param: day = 2026-10-20\n-- @name: 支付\nSELECT '${day}';";
  const h = harness(sql, { offset: sql.indexOf('SELECT') });
  await h.run();
  h.editor.selection.start = h.editor.selection.end = sql.lastIndexOf('SELECT');
  await h.run();
  assert.deepEqual(h.calls.opened, ['spark', 'mysql']);
  assert.ok(h.calls.executed[0].includes("SELECT '2026-10-21'"));
  assert.ok(h.calls.executed[1].includes("SELECT '2026-10-20'"));
  assert.equal(h.calls.results[0].metadata.statementName, '订单');
  assert.equal(h.calls.results[1].metadata.statementName, '支付');
  assert.equal(h.calls.forms.length, 0);
  assert.equal(h.state.runningDocuments.size, 0);
});

test('explain reuses the file session, reads the full plan and never runs original SQL or applies preview limits', async () => {
  const sql = "-- @connection: Spark数仓\n-- @param: day = 2026-10-21\n-- @name: 订单\nSELECT * FROM orders WHERE dt='${day}';";
  const h = harness(sql, { offset: sql.indexOf('SELECT'), rowCount: 1200 });
  await h.seed();
  await h.run(true);
  assert.deepEqual(h.calls.opened, []);
  assert.equal(h.calls.executed.length, 1);
  assert.match(h.calls.executed[0], /^EXPLAIN FORMATTED\n/);
  assert.doesNotMatch(h.calls.executed[0], /LIMIT/);
  assert.equal(h.calls.results.length, 0);
  assert.equal(h.calls.plans[0].name, '订单');
  assert.ok(h.calls.plans[0].plan.endsWith('  +- node 1199'));
  assert.equal(h.calls.plans[0].parameters.day, '2026-10-21');
  assert.equal(h.state.cancellationSources.size, 0);
});

test('a selection containing only SQL still uses its preceding connection and parameters', async () => {
  const sql = '-- @connection: MySQL业务库\n-- @param: id = 42\nSELECT ${id};';
  const h = harness(sql);
  h.editor.selection = { isEmpty: false, start: sql.indexOf('SELECT'), end: sql.length };
  await h.run();
  assert.deepEqual(h.calls.opened, ['mysql']);
  assert.ok(h.calls.executed[0].includes('SELECT 42'));
});

test('invalid connections and already-explained SQL fail before opening a session', async () => {
  for (const sql of ['-- @connection: missing\nSELECT 1;', '-- @connection: Spark数仓\nEXPLAIN ANALYZE SELECT 1;']) {
    const h = harness(sql);
    await assert.rejects(h.run(true));
    assert.equal(h.calls.opened.length, 0);
    assert.equal(h.calls.executed.length, 0);
  }
});

test('only missing values need a form; comments override remembered or posted values', async () => {
  const h = harness('', { decision: { action: 'execute', values: { id: 'wrong', day: '2026-10-21' } } });
  const result = await h.hooks.prepareStatementSql("SELECT ${id}, '${day}';", 'file:///queries.sql', 'queries.sql', { id: '42' });
  assert.equal(h.calls.forms.length, 1);
  assert.equal(h.calls.forms[0].fixedValues.id, '42');
  assert.equal(result.sql, "SELECT 42, '2026-10-21';");
});

test('inline defaults run directly, while disabled substitution preserves literal placeholders', async () => {
  const h = harness('');
  const resolved = await h.hooks.prepareStatementSql('SELECT ${id=42};', 'file:///queries.sql', 'queries.sql');
  assert.equal(resolved.sql, 'SELECT 42;');
  assert.equal(h.calls.forms.length, 0);
  const disabled = harness('', { settings: { sqlParameters: false } });
  const raw = await disabled.hooks.prepareStatementSql('SELECT ${id}, $${conf};', 'file:///queries.sql', 'queries.sql', { id: '42' });
  assert.equal(raw.sql, 'SELECT ${id}, ${conf};');
  assert.equal(disabled.calls.forms.length, 0);
});

test('an undeclared prototype-shaped parameter cannot silently bypass the missing-value form', async () => {
  const h = harness('');
  const result = await h.hooks.prepareStatementSql('SELECT ${constructor};', 'file:///queries.sql', 'queries.sql');
  assert.equal(result, undefined);
  assert.equal(h.calls.forms.length, 1);
});

test('invalid routing does not fall back to a remembered active connection', async () => {
  const h = harness('-- @connection: missing\nSELECT 1;');
  h.state.documentConnections.set('file:///queries.sql', 'spark');
  await h.seed();
  await assert.rejects(h.run());
  assert.equal(h.calls.executed.length, 0);
});

test('repeated shortcuts cannot start a second query while parameters or connection opening are pending', async () => {
  const h = harness('-- @connection: Spark数仓\nSELECT 1;');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  h.manager.open = async () => { h.calls.opened.push('spark'); await gate; return h.session; };
  const first = h.run();
  await h.run(true);
  release();
  await first;
  assert.equal(h.calls.opened.length, 1);
  assert.equal(h.calls.executed.length, 1);
  assert.equal(h.calls.plans.length, 0);
  // The reservation is released after completion, including for Explain.
  await h.run(true);
  assert.equal(h.calls.plans.length, 1);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const memoryTarget = { scheme: 'memory', toString: () => 'memory:/result.tsv' };

test('switching A → B → A preserves both sessions and their separate state', async () => {
  const sql = '-- @connection: Spark数仓\nUSE analytics;\n-- @connection: MySQL业务库\nSELECT 1;\n-- @connection: Spark数仓\nSELECT 2;';
  const h = harness(sql);
  const original = h.session.execute;
  h.session.execute = async (statement, signal, sink) => {
    if (/^USE/.test(statement)) h.session.database = 'analytics';
    else assert.equal(h.session.database, 'analytics');
    return original(statement, signal, sink);
  };
  await h.run();
  h.editor.selection.start = h.editor.selection.end = sql.indexOf('SELECT 1');
  await h.run();
  h.editor.selection.start = h.editor.selection.end = sql.indexOf('SELECT 2');
  await h.run();
  assert.deepEqual(h.calls.opened, ['spark', 'mysql']);
  assert.deepEqual(h.calls.closed, []);
});

test('full export reuses the original session without LIMIT, stays reusable after success, and keeps the session open', async () => {
  const h = harness('-- @connection: Spark数仓\nSELECT 1;', { rowCount: 3, target: memoryTarget });
  await h.run();
  const panel = h.panelFor();
  assert.equal(await panel.export('tsv'), true);
  assert.equal(await panel.export('tsv'), true);
  assert.deepEqual(h.calls.opened, ['spark']);
  assert.deepEqual(h.calls.closed, []);
  assert.equal(h.calls.executed[1], 'SELECT 1;');
  assert.equal(h.calls.writes[0].text, 'plan\r\n  +- node 0\r\n  +- node 1\r\n  +- node 2\r\n');
  assert.equal(h.state.cancellationSources.size, 0);
});

test('executing EXPLAIN on the same source expires the old rerun without opening a file or connection', async () => {
  const h = harness('-- @connection: Spark数仓\nSELECT 1;', { rowCount: 3, target: memoryTarget });
  await h.run();
  const panel = h.panelFor();
  await h.run(true);
  await assert.rejects(panel.export('tsv'), /会话已失效或执行过其他语句/);
  assert.equal(h.calls.executed.length, 2);
  assert.equal(h.calls.saveDialogs, undefined);
  assert.equal(h.calls.writes.length, 0);
});

test('closing the source file expires rerun exports but complete in-memory results can still be exported', async () => {
  for (const rowCount of [1, 3]) {
    const h = harness('-- @connection: Spark数仓\nSELECT 1;', { rowCount, target: memoryTarget });
    await h.run();
    const panel = h.panelFor();
    await h.state.sessions.closeDocument('file:///queries.sql');
    if (rowCount === 3) await assert.rejects(panel.export('tsv'), /会话已失效/);
    else assert.equal(await panel.export('tsv'), true);
    assert.deepEqual(h.calls.opened, ['spark']);
  }
});

test('export blocks another operation in the same file while another file can still run', async () => {
  const h = harness('-- @connection: Spark数仓\nSELECT 1;', { rowCount: 3, target: memoryTarget });
  await h.run();
  const started = deferred();
  const gate = deferred();
  const originalExecute = h.session.execute;
  h.session.execute = async (...args) => { started.resolve(); await gate.promise; return originalExecute(...args); };
  const exporting = h.panelFor().export('tsv');
  await started.promise;
  await h.run(true);
  assert.equal(h.calls.plans.length, 0);
  assert.ok(h.calls.notices.some((text) => text.includes('已有查询、计划或导出')));
  h.editor.document.uri = { scheme: 'file', toString: () => 'file:///other.sql' };
  h.manager.open = async () => ({ broken: false, close: async () => {}, execute: originalExecute });
  await h.run();
  assert.equal(h.calls.results.length, 2);
  gate.resolve();
  assert.equal(await exporting, true);
});

test('cancelling an export retains a healthy session; closing the file cancels then releases it', async () => {
  for (const closeFile of [false, true]) {
    const h = harness('-- @connection: Spark数仓\nSELECT 1;', { rowCount: 3, target: memoryTarget });
    await h.run();
    const started = deferred();
    h.session.execute = async (_sql, signal) => {
      started.resolve();
      await new Promise((resolve) => signal.onRequest(resolve));
      const { QueryCancelledError } = require('../out/querySession');
      throw new QueryCancelledError();
    };
    const exporting = h.panelFor().export('tsv');
    await started.promise;
    const closing = closeFile ? h.state.sessions.closeDocument('file:///queries.sql') : undefined;
    if (!closeFile) h.state.cancellationSources.get('file:///queries.sql').cancel();
    assert.equal(await exporting, false);
    await closing;
    assert.equal(h.calls.writes.length, 0);
    assert.deepEqual(h.calls.closed, closeFile ? ['spark'] : []);
    assert.equal(h.state.cancellationSources.size, 0);
  }
});

test('reset cancels a pending save dialog without waiting for a path or starting a database rerun', async () => {
  const prompt = deferred();
  const displayed = deferred();
  const h = harness('-- @connection: Spark数仓\nSELECT 1;', {
    rowCount: 3, saveDialog: () => { displayed.resolve(); return prompt.promise; },
  });
  await h.run();
  const exporting = h.panelFor().export('tsv');
  await displayed.promise;
  const closing = h.state.sessions.closeDocument('file:///queries.sql');
  assert.equal(await exporting, false);
  await closing;
  prompt.resolve(memoryTarget);
  assert.equal(h.calls.executed.length, 1);
  assert.equal(h.calls.writes.length, 0);
});

test('a database failure under the default export directory is not retried as a path failure', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sqltools-session-export-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const h = harness('-- @connection: Spark数仓\nSELECT 1;', { rowCount: 3, target: memoryTarget, settings: { exportDirectory: directory } });
  await h.run();
  h.session.execute = async () => { throw new Error('test database failure'); };
  await assert.rejects(h.panelFor().export('tsv'), /test database failure/);
  assert.equal(h.calls.saveDialogs, undefined);
  assert.deepEqual(fs.readdirSync(directory), []);
});
