const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');

// Exercise the real runner with fake database sessions: no network or VS Code
// host is needed, and a mistakenly executed original SQL is observable here.
function harness(sql, options = {}) {
  const calls = { executed: [], opened: [], forms: [], plans: [], results: [], notices: [] };
  const profiles = [
    { id: 'spark', name: 'Spark数仓', type: 'Spark' },
    { id: 'mysql', name: 'MySQL业务库', type: 'MySQL' },
  ];
  const disposable = () => ({ dispose() {} });
  class CancellationTokenSource {
    token = { isCancellationRequested: false, onCancellationRequested: disposable };
    cancel() { this.token.isCancellationRequested = true; }
    dispose() {}
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
      showWarningMessage: async (text) => { calls.notices.push(text); },
      withProgress: async (_config, task) => task({ report() {} }, new CancellationTokenSource().token),
      showQuickPick: async () => { throw new Error('unexpected connection picker'); },
    },
    workspace: { getConfiguration: () => ({ get: (key, fallback) => ({ maxResultRows: 2, readRowLimit: 0, ...options.settings })[key] ?? fallback }) },
  };
  const filename = path.resolve(__dirname, '../out/extension.js');
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  const sandbox = {
    module, exports: module.exports, console, Buffer, process, setTimeout, clearTimeout,
    require: (id) => {
      if (id === 'vscode') return vscode;
      if (id === './connectionManager') return { showError: (_label, error) => { throw error; } };
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
  const session = {
    broken: false, close: async () => {},
    execute: async (statement, signal, sink) => {
      calls.executed.push(statement);
      sink.onColumns(['plan']);
      for (let i = 0; i < (options.rowCount ?? 1); i++) await sink.onRow({ plan: `  +- node ${i}` });
      return { rowsRead: options.rowCount ?? 1, affectedRows: 0 };
    },
  };
  const manager = {
    getProfiles: () => profiles,
    open: async (profile) => { calls.opened.push(profile.id); return session; },
  };
  const state = { documentConnections: new Map(), liveConnections: new Map(), runningDocuments: new Set(), cancellationSources: new Map() };
  return { calls, hooks, editor, manager, state, session, run: (explain = false) => hooks.runQuery(manager, state, undefined, undefined, explain) };
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
  h.state.liveConnections.set('file:///queries.sql', { profileId: 'spark', session: h.session });
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
  h.state.liveConnections.set('file:///queries.sql', { profileId: 'spark', session: h.session });
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
