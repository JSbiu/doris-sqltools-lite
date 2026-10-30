const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');
const { buildPlanReview } = require('../out/executionPlan');

function modeState(mode = 'encrypted') {
  const state = { mode, listeners: new Set(), setMode(mode) {
    state.mode = mode;
    for (const listener of state.listeners) listener(mode);
  } };
  return state;
}

function projection(mode = 'encrypted', rules = { customer_id: 'customer' }) {
  const make = (mode) => ({
    mode, rules, info: { mode, keyId: 'test-key', fields: rules },
    value: (name, value) => mode === 'encrypted' && Object.hasOwn(rules, name) ? 'cipher-customer' : value,
    parameters(values) { return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, this.value(name, value)])); },
    withMode: make,
  });
  return make(mode);
}

function openPanel(options = {}) {
  const calls = { messages: [], writes: [], shown: [], commands: [], feedback: [], clipboardWrites: [], disposedSubscriptions: 0 };
  const state = options.state ?? modeState(options.mode);
  const dataProtection = { getDataMode: () => state.mode,
    onDataModeChange(listener) { state.listeners.add(listener); return { dispose: () => state.listeners.delete(listener) }; } };
  let handler;
  let dispose;
  const uri = (value) => ({ toString: () => value, scheme: 'file', path: new URL(value).pathname, fsPath: path.resolve(new URL(value).pathname) });
  const source = uri('file:///queries.sql');
  const target = uri('file:///queries.feedback.md');
  const planTarget = uri('file:///queries.plan.txt');
  const panel = {
    webview: {
      html: '',
      onDidReceiveMessage: (callback) => { handler = callback; return { dispose() { calls.disposedSubscriptions += 1; } }; },
      postMessage: async (message) => calls.messages.push(message),
    },
    onDidDispose(callback) { dispose = callback; },
    dispose() { dispose(); },
  };
  const vscode = {
    ViewColumn: { Beside: 2 },
    Uri: { joinPath: (base, ...segments) => uri('file://' + path.posix.join(base.path, ...segments)), file: (file) => uri('file://' + file.replace(/\\/g, '/').replace(/^([a-z]:)/i, '/$1')) },
    env: { clipboard: { writeText: async (text) => { calls.clipboard = text; calls.clipboardWrites.push(text); } } },
    commands: { executeCommand: async (command) => {
      calls.commands.push(command);
      state.setMode(state.mode === 'encrypted' ? 'plain' : 'encrypted');
    } },
    workspace: {
      fs: { writeFile: async (target, data) => calls.writes.push({ target, data }) },
      openTextDocument: async (target) => target,
    },
    window: {
      createWebviewPanel: () => panel,
      showSaveDialog: async () => calls.saveTarget,
      showTextDocument: async (document) => calls.shown.push(document),
    },
  };
  const filename = path.resolve(__dirname, '../out/planPanel.js');
  const realRequire = createRequire(filename);
  const actionModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../out/feedbackActions.js'), 'utf8'), {
    module: actionModule, exports: actionModule.exports, Buffer, process,
    require: (id) => id === 'vscode' ? vscode : id === './dataProtection' ? dataProtection : realRequire(id),
  });
  const actions = options.stubFeedback ? {
    copyFeedback: async (record) => { calls.feedback.push({ type: 'copy', record }); return true; },
    saveFeedback: async (record) => { calls.feedback.push({ type: 'save', record }); return true; },
  } : actionModule.exports;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, Buffer,
    require: (id) => id === 'vscode' ? vscode : id === './feedbackActions' ? actions
      : id === './dataProtection' ? dataProtection : realRequire(id),
  });
  const snapshot = {
    name: '<订单>', source: source.toString(), connectionName: 'Spark数仓', databaseType: 'Spark',
    sql: "SELECT '<script>'", explainSql: "EXPLAIN FORMATTED\nSELECT '<script>'", parameters: {},
    plan: '  +- Scan\n</pre><script>bad()</script>', generatedAt: '2026-10-22T00:00:00Z',
    ...options.snapshot,
  };
  const origin = { path: source.fsPath, startLine: 3, endLine: 9, savedAtExecution: true, changedSinceExecution: false };
  const record = options.protection ? { protection: options.protection,
    sourceUri: source, currentSource: () => origin, startedAt: 0, planText: snapshot.plan,
    value: { name: snapshot.name, connectionName: snapshot.connectionName, databaseType: snapshot.databaseType,
      parameters: snapshot.parameters, source: origin, action: 'explain', status: 'success', submitted: true,
      generatedAt: snapshot.generatedAt, durationMs: 0 } } : undefined;
  module.exports.openPlanPanel(snapshot, source, record);
  return { calls, panel, source, target, planTarget, snapshot, record, state, actions, send: (type) => handler({ type }) };
}

test('plan HTML escapes SQL and plan content while retaining text whitespace', () => {
  const h = openPanel();
  assert.ok(h.panel.webview.html.includes('  +- Scan\n&lt;/pre&gt;&lt;script&gt;bad()&lt;/script&gt;'));
  assert.ok(h.panel.webview.html.includes('&lt;订单&gt;'));
  assert.doesNotMatch(h.panel.webview.html, /<script>bad/);
});

test('default copy saves the complete plan separately and copies only short metadata and its path', async () => {
  const h = openPanel();
  h.calls.saveTarget = h.planTarget;
  await h.send('copy');
  assert.equal(h.calls.writes[0].data.toString('utf8'), h.snapshot.plan);
  const data = JSON.parse(/```json\n([^\n]+)/.exec(h.calls.clipboard)[1]);
  assert.equal(data.action, 'explain');
  assert.equal(data.planFile, h.planTarget.fsPath);
  assert.equal(data.source.path, h.source.fsPath);
  assert.ok(!h.calls.clipboard.includes(h.snapshot.sql));
  assert.ok(!h.calls.clipboard.includes(h.snapshot.plan));
  h.calls.saveTarget = h.target;
  await h.send('save');
  assert.equal(h.calls.writes.length, 2);
  assert.equal(h.calls.writes[1].data.toString('utf8'), h.calls.clipboard);
  assert.equal(h.calls.shown.length, 0);
});

test('saving first uses one selected summary path and a separate complete plan companion', async () => {
  const h = openPanel();
  h.calls.saveTarget = h.target;
  await h.send('save');
  assert.equal(h.calls.writes.length, 2);
  assert.equal(h.calls.writes[0].data.toString('utf8'), h.snapshot.plan);
  const summary = h.calls.writes[1].data.toString('utf8');
  const data = JSON.parse(/```json\n([^\n]+)/.exec(summary)[1]);
  assert.equal(data.planFile, h.calls.writes[0].target.fsPath);
  assert.notEqual(data.planFile, h.target.fsPath);
  await h.send('copy');
  assert.equal(h.calls.clipboard, summary);
  assert.equal(h.calls.writes.length, 2);
});

test('full materials are copied only through the explicit complete-copy action', async () => {
  const h = openPanel();
  await h.send('copy-full');
  assert.equal(h.calls.clipboard, buildPlanReview(h.snapshot));
  assert.equal(h.calls.writes.length, 0);
});

test('cancelled saves write nothing and saving over the source SQL is refused', async () => {
  const h = openPanel();
  await h.send('copy');
  assert.equal(h.calls.clipboard, undefined);
  await h.send('save');
  assert.equal(h.calls.writes.length, 0);
  h.calls.saveTarget = h.source;
  await h.send('save');
  assert.equal(h.calls.writes.length, 0);
  assert.match(h.calls.messages.at(-1).status, /不能覆盖原 SQL/);
});

test('plan-file failures do not copy a summary claiming the file was saved', async () => {
  const h = openPanel();
  h.calls.saveTarget = h.target;
  await h.send('copy');
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.calls.clipboard, undefined);
  assert.match(h.calls.messages.at(-1).status, /\.txt/);
});

test('source flags are refreshed when query feedback is copied, including closed sources', async () => {
  const h = openPanel();
  const source = { path: h.source.fsPath, startLine: 7, endLine: 21, savedAtExecution: false, changedSinceExecution: true };
  const record = { sourceUri: h.source, currentSource: () => ({ ...source }), startedAt: 0,
    value: { name: 'query', connectionName: 'Spark数仓', databaseType: 'Spark', parameters: {}, source,
      action: 'query', status: 'success', submitted: true, generatedAt: '2026-10-28T00:00:00Z', durationMs: 12 } };
  await h.actions.copyFeedback(record);
  let data = JSON.parse(/```json\n([^\n]+)/.exec(h.calls.clipboard)[1]);
  assert.equal(data.source.changedSinceExecution, true);
  assert.equal(data.source.savedAtExecution, false);
  source.changedSinceExecution = null;
  await h.actions.copyFeedback(record);
  data = JSON.parse(/```json\n([^\n]+)/.exec(h.calls.clipboard)[1]);
  assert.equal(data.source.changedSinceExecution, null);
  assert.equal(h.calls.writes.length, 0);
});

function pageScript(panel) {
  const elements = new Map([...panel.webview.html.matchAll(/\bid="([^"]+)"/g)].map((match) => [match[1], { listeners: {}, addEventListener(event, callback) { this.listeners[event] = callback; } }]));
  const posted = [];
  let onMessage;
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(panel.webview.html)[1];
  vm.runInNewContext(script, {
    acquireVsCodeApi: () => ({ postMessage: (message) => posted.push(message.type) }),
    document: { getElementById: (id) => elements.get(id) },
    window: { addEventListener: (_event, callback) => { onMessage = callback; } },
  });
  return { elements, posted, onMessage: (event) => onMessage(event) };
}

test('the actual page script sends actions and releases buttons after completion or error', () => {
  const h = openPanel();
  const { elements, posted, onMessage } = pageScript(h.panel);
  elements.get('copy-review').listeners.click();
  assert.deepEqual(posted, ['copy']);
  assert.equal(elements.get('save-review').disabled, true);
  onMessage({ data: { status: '已复制' } });
  assert.equal(elements.get('save-review').disabled, false);
  elements.get('save-review').listeners.click();
  onMessage({ data: { status: '操作失败' } });
  assert.deepEqual(posted, ['copy', 'save']);
  assert.equal(elements.get('action-status').textContent, '操作失败');
  assert.equal(elements.get('copy-review').disabled, false);
});

function protectedPanel(options = {}) {
  return openPanel({ stubFeedback: true, protection: projection('plain'), snapshot: {
    parameters: { customer_id: 'sensitive-customer-951', day: '2026-10-30' },
    sql: "SELECT 'hardcoded-sql-872' WHERE customer_id = 'sensitive-customer-951'",
    explainSql: "EXPLAIN SELECT 'hardcoded-sql-872' WHERE customer_id = 'sensitive-customer-951'",
    plan: "Scan customer_id = sensitive-customer-951; constant = hardcoded-sql-872; plan-detail-317",
  }, ...options });
}

function assertEncrypted(html) {
  for (const value of ['sensitive-customer-951', 'hardcoded-sql-872', 'plan-detail-317']) {
    assert.ok(!html.includes(value), `leaked ${value}`);
  }
  assert.ok(html.includes('cipher-customer'));
  assert.match(html, /加密模式下不展示计划和 SQL 原文/);
}

test('protected plan uses the current global mode and contains only projected parameters and a static plan notice', () => {
  const h = protectedPanel();
  const before = JSON.stringify(h.snapshot);
  assert.equal(h.record.protection.mode, 'plain');
  assertEncrypted(h.panel.webview.html);
  assert.ok(h.panel.webview.html.includes('2026-10-30'));
  assert.match(h.panel.webview.html, /显示模式：加密 · 切换明文/);
  h.state.setMode('plain');
  assert.ok(h.panel.webview.html.includes(h.snapshot.plan));
  assert.ok(h.panel.webview.html.includes('sensitive-customer-951'));
  assert.match(h.panel.webview.html, /显示模式：明文 · 切换加密/);
  h.state.setMode('encrypted');
  assertEncrypted(h.panel.webview.html);
  assert.equal(JSON.stringify(h.snapshot), before);
  assert.equal(h.calls.commands.length, 0);
  assert.equal(h.calls.feedback.length, 0);
  assert.equal(h.calls.writes.length, 0);
});

test('encrypted full-copy refuses without touching the clipboard, and plain mode restores complete materials', async () => {
  const h = protectedPanel();
  await h.send('copy-full');
  assert.equal(h.calls.clipboardWrites.length, 0);
  assert.match(h.calls.messages.at(-1).status, /不能复制完整材料.*明文模式/);
  h.state.setMode('plain');
  await h.send('copy-full');
  assert.equal(h.calls.clipboard, buildPlanReview(h.snapshot));
  h.state.setMode('encrypted');
  await h.send('copy-full');
  assert.equal(h.calls.clipboardWrites.length, 1);
  assert.equal(h.calls.feedback.length, 0);
  assert.equal(h.calls.writes.length, 0);
});

test('protected summary copy and save delegate the original record to feedbackActions without copying plan text', async () => {
  const h = protectedPanel();
  await h.send('copy');
  await h.send('save');
  assert.deepEqual(h.calls.feedback.map((call) => call.type), ['copy', 'save']);
  for (const call of h.calls.feedback) assert.equal(call.record, h.record);
  assert.equal(h.calls.clipboardWrites.length, 0);
  assert.equal(h.calls.writes.length, 0);
  assert.match(h.calls.messages[0].status, /加密模式/);
  assert.match(h.calls.messages[1].status, /已保存加密反馈/);
});

test('mode buttons call only the shared command, redraw all subscribed pages and release subscriptions on dispose', async () => {
  const state = modeState();
  const first = protectedPanel({ state });
  const second = protectedPanel({ state });
  const page = pageScript(first.panel);
  assert.equal(state.listeners.size, 2);
  page.elements.get('toggle-data-mode').listeners.click();
  assert.deepEqual(page.posted, ['toggle-data-mode']);
  assert.equal(page.elements.get('toggle-data-mode').disabled, true);
  await first.send(page.posted[0]);
  assert.deepEqual(first.calls.commands, ['dorisSqlLite.toggleDataMode']);
  for (const h of [first, second]) {
    assert.ok(h.panel.webview.html.includes('plan-detail-317'));
    assert.equal(h.calls.writes.length, 0);
    assert.equal(h.calls.feedback.length, 0);
    assert.equal(h.calls.clipboardWrites.length, 0);
  }
  page.onMessage({ data: first.calls.messages.at(-1) });
  assert.equal(page.elements.get('toggle-data-mode').disabled, false);
  first.panel.dispose();
  const disposedHtml = first.panel.webview.html;
  assert.equal(state.listeners.size, 1);
  state.setMode('encrypted');
  assert.equal(first.panel.webview.html, disposedHtml);
  assertEncrypted(second.panel.webview.html);
  second.panel.dispose();
  assert.equal(state.listeners.size, 0);
  assert.equal(first.calls.disposedSubscriptions, 1);
  assert.equal(second.calls.disposedSubscriptions, 1);
});

test('unconfigured and empty-rule plans keep their original HTML and complete-copy behavior in either global mode', async () => {
  for (const protection of [undefined, projection('encrypted', {})]) {
    const h = openPanel({ protection });
    const html = h.panel.webview.html;
    assert.doesNotMatch(html, /id="toggle-data-mode"/);
    assert.equal(h.state.listeners.size, 0);
    h.state.setMode('plain');
    h.state.setMode('encrypted');
    assert.equal(h.panel.webview.html, html);
    await h.send('copy-full');
    assert.equal(h.calls.clipboard, buildPlanReview(h.snapshot));
  }
});
