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
  const uri = (value) => ({ toString: () => value, scheme: 'file' });
  const source = uri('file:///queries.sql');
  const target = uri('file:///queries.plan.md');
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
    Uri: { joinPath: (_base, segment) => uri('file:///' + segment) },
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
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, Buffer,
    require: (id) => id === 'vscode' ? vscode : realRequire(id),
  });
  const snapshot = {
    name: '<订单>', source: source.toString(), connectionName: 'Spark数仓', databaseType: 'Spark',
    sql: "SELECT '<script>'", explainSql: "EXPLAIN FORMATTED\nSELECT '<script>'", parameters: {},
    plan: '  +- Scan\n</pre><script>bad()</script>', generatedAt: '2026-10-22T00:00:00Z',
  };
  module.exports.openPlanPanel(snapshot, source);
  return { calls, panel, source, target, snapshot, send: (type) => handler({ type }) };
}

test('plan HTML escapes SQL and plan content while retaining text whitespace', () => {
  const h = openPanel();
  assert.ok(h.panel.webview.html.includes('  +- Scan\n&lt;/pre&gt;&lt;script&gt;bad()&lt;/script&gt;'));
  assert.ok(h.panel.webview.html.includes('&lt;订单&gt;'));
  assert.doesNotMatch(h.panel.webview.html, /<script>bad/);
});

test('copy and save use the same complete review snapshot', async () => {
  const h = openPanel();
  await h.send('copy');
  assert.equal(h.calls.clipboard, buildPlanReview(h.snapshot));
  h.calls.saveTarget = h.target;
  await h.send('save');
  assert.equal(h.calls.writes.length, 1);
  assert.equal(h.calls.writes[0].data.toString('utf8'), h.calls.clipboard);
  assert.equal(h.calls.shown[0], h.target);
});

test('cancelled saves write nothing and saving over the source SQL is refused', async () => {
  const h = openPanel();
  await h.send('save');
  assert.equal(h.calls.writes.length, 0);
  h.calls.saveTarget = h.source;
  await h.send('save');
  assert.equal(h.calls.writes.length, 0);
  assert.match(h.calls.messages.at(-1).status, /不能覆盖原 SQL/);
});

test('the actual page script sends actions and releases buttons after completion or error', () => {
  const h = openPanel();
  const elements = new Map(['copy-review', 'save-review', 'action-status'].map((id) => [id, { listeners: {}, addEventListener(event, callback) { this.listeners[event] = callback; } }]));
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
