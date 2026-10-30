'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');

const outputRoot = path.resolve(__dirname, '../out');

function loadRenderedModule(name) {
  const filename = path.join(outputRoot, name);
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') {
      return {
        ViewColumn: { Active: 1, Beside: 2 },
        window: {},
        workspace: {},
        commands: {},
        env: {},
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(filename)];
    return require(filename);
  } finally {
    Module._load = originalLoad;
  }
}

test('all Webviews share one hierarchy, focus, responsive and reduced-motion language', () => {
  const { WEBVIEW_BASE_CSS } = require('../out/webviewTheme.js');

  assert.match(WEBVIEW_BASE_CSS, /--ui-surface:/);
  assert.match(WEBVIEW_BASE_CSS, /\.page-header\s*\{/);
  assert.match(WEBVIEW_BASE_CSS, /\.section\s*\{/);
  assert.match(WEBVIEW_BASE_CSS, /\.badge\s*\{/);
  assert.match(WEBVIEW_BASE_CSS, /\.action-bar\s*\{/);
  assert.match(WEBVIEW_BASE_CSS, /\.code-surface\s*\{/);
  assert.match(WEBVIEW_BASE_CSS, /:focus-visible/);
  assert.match(WEBVIEW_BASE_CSS, /@media \(max-width: 680px\)/);
  assert.match(WEBVIEW_BASE_CSS, /prefers-reduced-motion/);
});

test('connection form uses the shared shell, live status regions and stable action labels', () => {
  const { renderConnectionForm } = loadRenderedModule('connectionForm.js');
  const html = renderConnectionForm({
    name: '分析 Doris',
    type: 'Doris',
    host: 'doris.internal',
    port: '9030',
    database: 'analytics',
    username: 'analyst',
    password: '',
    ssl: true,
    sslVerify: true,
    sslCaFile: '',
    hiveAuth: 'plain',
    clearSavedPassword: false,
  }, 'add');

  assert.match(html, /--ui-radius:/);
  assert.match(html, /<header class="page-header">/);
  assert.match(html, /快速导入/);
  assert.match(html, /连接目标/);
  assert.match(html, /传输安全/);
  assert.match(html, /class="action-bar"/);
  assert.match(html, /id="status" class="status-banner" role="status" aria-live="polite"/);
  assert.match(html, /\.inline > button \{ flex: 0 0 auto; white-space: nowrap; \}/);
  assert.match(html, />解析并填充<\/button>/);
  assert.match(html, />测试连接<\/button>/);
  assert.match(html, />保存<\/button>/);
});

test('parameter form uses the shared shell, positive output labels and accessible status', () => {
  const { renderParameterForm } = loadRenderedModule('parameterForm.js');
  const html = renderParameterForm({
    documentLabel: 'orders.sql',
    sql: 'SELECT * FROM orders WHERE owner_id = ${owner_id}',
    parameters: [{ name: 'owner_id', candidates: [], labels: [] }],
    initialValues: {},
    fixedValues: {},
  });

  assert.match(html, /--ui-radius:/);
  assert.match(html, /<header class="page-header">/);
  assert.match(html, /普通输出/);
  assert.match(html, /class="code-surface"/);
  assert.match(html, /id="status" class="status-banner" role="status" aria-live="polite"/);
  assert.match(html, /class="action-bar"/);
  assert.match(html, />原样发送<\/button>/);
  assert.match(html, />执行<\/button>/);
  assert.doesNotMatch(html, /普通模式|加密模式|明文模式/);
});
