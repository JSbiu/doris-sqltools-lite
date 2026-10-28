const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');
const { buildPlanReview } = require('../out/executionPlan');

function openPanel() {
  const calls = { messages: [], writes: [], shown: [] };
  let handler;
  const uri = (value) => ({ toString: () => value, scheme: 'file', path: new URL(value).pathname, fsPath: path.resolve(new URL(value).pathname) });
  const source = uri('file:///queries.sql');
  const target = uri('file:///queries.feedback.md');
  const planTarget = uri('file:///queries.plan.txt');
  const panel = {
    webview: {
      html: '',
      onDidReceiveMessage: (callback) => { handler = callback; return { dispose() {} }; },
      postMessage: async (message) => calls.messages.push(message),
    },
    onDidDispose() {},
  };
  const vscode = {
    ViewColumn: { Beside: 2 },
    Uri: { joinPath: (base, ...segments) => uri('file://' + path.posix.join(base.path, ...segments)), file: (file) => uri('file://' + file.replace(/\\/g, '/').replace(/^([a-z]:)/i, '/$1')) },
    env: { clipboard: { writeText: async (text) => { calls.clipboard = text; } } },
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
    require: (id) => id === 'vscode' ? vscode : realRequire(id),
  });
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, Buffer,
    require: (id) => id === 'vscode' ? vscode : id === './feedbackActions' ? actionModule.exports : realRequire(id),
  });
  const snapshot = {
    name: '<订单>', source: source.toString(), connectionName: 'Spark数仓', databaseType: 'Spark',
    sql: "SELECT '<script>'", explainSql: "EXPLAIN FORMATTED\nSELECT '<script>'", parameters: {},
    plan: '  +- Scan\n</pre><script>bad()</script>', generatedAt: '2026-10-22T00:00:00Z',
  };
  module.exports.openPlanPanel(snapshot, source);
  return { calls, panel, source, target, planTarget, snapshot, actions: actionModule.exports, send: (type) => handler({ type }) };
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

test('the actual page script sends actions and releases buttons after completion or error', () => {
  const h = openPanel();
  const elements = new Map(['copy-review', 'save-review', 'copy-full', 'action-status'].map((id) => [id, { listeners: {}, addEventListener(event, callback) { this.listeners[event] = callback; } }]));
  const posted = [];
  let onMessage;
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(h.panel.webview.html)[1];
  vm.runInNewContext(script, {
    acquireVsCodeApi: () => ({ postMessage: (message) => posted.push(message.type) }),
    document: { getElementById: (id) => elements.get(id) },
    window: { addEventListener: (_event, callback) => { onMessage = callback; } },
  });
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
