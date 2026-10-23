const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const test = require('node:test');

function source() {
  const listeners = new Set();
  const token = { isCancellationRequested: false, onCancellationRequested(listener) {
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
  } };
  return { token, cancel() { token.isCancellationRequested = true; for (const listener of [...listeners]) listener(); } };
}

function load(name, dependencies) {
  const filename = path.resolve(__dirname, `../out/${name}.js`);
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports,
    require: (id) => dependencies[id] ?? realRequire(id),
  });
  return module.exports;
}

test('cancelling the password dialog ends opening without starting a connection', async () => {
  const cancellation = source();
  let prompted;
  const prompt = new Promise((resolve) => { prompted = resolve; });
  let connects = 0;
  const { ConnectionManager } = load('connectionManager', {
    vscode: { window: { showInputBox: (_options, token) => {
      assert.equal(token, cancellation.token);
      prompted();
      return new Promise((resolve) => token.onCancellationRequested(() => resolve(undefined)));
    } } },
    './sessionFactory': { openQuerySession: async () => { connects += 1; } },
  });
  const manager = new ConnectionManager({ secrets: { get: async () => undefined } });
  const opening = manager.open({ id: 'A', name: 'A', type: 'Spark' }, undefined, cancellation.token);
  const rejected = assert.rejects(opening, /取消/);
  await prompt;
  cancellation.cancel();
  await rejected;
  assert.equal(connects, 0);
});

test('cancelling during authentication closes the late session instead of returning it', async () => {
  const cancellation = source();
  let connecting;
  const connected = new Promise((resolve) => { connecting = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let closed = 0;
  const { ConnectionManager } = load('connectionManager', {
    vscode: { window: {} },
    './sessionFactory': { openQuerySession: async () => { connecting(); await gate; return { close: async () => { closed += 1; } }; } },
  });
  const manager = new ConnectionManager({ secrets: { get: async () => randomUUID() } });
  const opening = manager.open({ id: 'A', name: 'A', type: 'Spark' }, undefined, cancellation.token);
  const rejected = assert.rejects(opening, /取消/);
  await connected;
  cancellation.cancel();
  release();
  await rejected;
  assert.equal(closed, 1);
});

test('cancelling a parameter form disposes it, resolves preparation and allows the next form', async () => {
  const cancellation = source();
  const panels = [];
  const { openParameterForm } = load('parameterForm', {
    vscode: {
      ViewColumn: { Active: 1 },
      window: { createWebviewPanel() {
        const callbacks = [];
        const panel = {
          webview: { onDidReceiveMessage() {}, html: '' }, disposed: false,
          onDidDispose(callback) { callbacks.push(callback); },
          dispose() { this.disposed = true; callbacks.forEach((callback) => callback()); },
        };
        panels.push(panel);
        return panel;
      } },
    },
  });
  const inputs = { documentLabel: 'query.sql', sql: 'SELECT 1;', parameters: [], initialValues: {} };
  const first = openParameterForm({ ...inputs, cancellationToken: cancellation.token });
  cancellation.cancel();
  assert.equal(await first, undefined);
  assert.equal(panels[0].disposed, true);
  const second = openParameterForm(inputs);
  assert.equal(panels.length, 2);
  panels[1].dispose();
  assert.equal(await second, undefined);
});
