'use strict';

// Renders the actual compiled Webview HTML into a temporary directory for
// visual checks in a normal Chromium window. The extension host is replaced
// only at its boundary, so layout drift in the real templates remains visible.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { createRequire } = require('node:module');

const projectRoot = path.resolve(__dirname, '..');
const outputRoot = path.join(projectRoot, 'out');
if (!fs.existsSync(path.join(outputRoot, 'extension.js'))) {
  throw new Error('out/ is missing; run: pnpm run compile');
}

const noopDisposable = { dispose() {} };

class TreeItemStub {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class EventEmitterStub {
  constructor() {
    this.event = () => noopDisposable;
  }

  fire() {}
  dispose() {}
}

const vscodeStub = {
  TreeItem: TreeItemStub,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  EventEmitter: EventEmitterStub,
  ThemeIcon: class ThemeIconStub {
    constructor(id) {
      this.id = id;
    }
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1, One: 1, Beside: 2 },
  ProgressLocation: { Notification: 15 },
  Uri: {
    file(fsPath) {
      return { scheme: 'file', fsPath, path: fsPath, toString: () => `file://${fsPath}` };
    },
    joinPath(uri, ...parts) {
      return vscodeStub.Uri.file(path.join(uri.fsPath, ...parts));
    },
  },
  env: {
    clipboard: { async writeText() {} },
  },
  commands: {
    registerCommand: () => noopDisposable,
    executeCommand: async () => undefined,
  },
  workspace: {
    isTrusted: true,
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    onDidChangeConfiguration: () => noopDisposable,
    onDidCloseTextDocument: () => noopDisposable,
    fs: { async writeFile() {} },
  },
  window: {
    activeTextEditor: undefined,
    createWebviewPanel(_viewType, title) {
      return {
        title,
        viewColumn: vscodeStub.ViewColumn.Beside,
        webview: {
          html: '',
          postMessage: async () => true,
          onDidReceiveMessage: () => noopDisposable,
        },
        reveal() {},
        onDidDispose() {},
        dispose() {},
      };
    },
    createStatusBarItem: () => ({
      text: '',
      tooltip: '',
      command: '',
      show() {},
      hide() {},
      dispose() {},
    }),
    onDidChangeActiveTextEditor: () => noopDisposable,
    registerTreeDataProvider: () => noopDisposable,
    showSaveDialog: async () => undefined,
    showOpenDialog: async () => undefined,
  },
};

const extensionRequire = createRequire(path.join(outputRoot, 'extension.js'));

function withVscode(callback) {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscodeStub;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return callback();
  } finally {
    Module._load = originalLoad;
  }
}

function renderConnectionPreview() {
  return withVscode(() => {
    const { renderConnectionForm } = require(path.join(outputRoot, 'connectionForm.js'));
    return renderConnectionForm({
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
  });
}

function renderParameterPreview() {
  return withVscode(() => {
    const { renderParameterForm } = require(path.join(outputRoot, 'parameterForm.js'));
    const html = renderParameterForm({
      documentLabel: 'orders_2026-10-30.sql',
      sql: "SELECT * FROM orders WHERE dt = '${biz_date}' AND owner_id = '${owner_id}'",
      parameters: [
        { name: 'biz_date', candidates: ['2026-10-30'], labels: [undefined] },
        { name: 'owner_id', candidates: [], labels: [] },
      ],
      initialValues: { owner_id: '00042' },
      fixedValues: {},
    });
    return html.replace(
      /(<pre id="preview"[^>]*>)[\s\S]*?(<\/pre>)/,
      '$1SELECT *\nFROM orders\nWHERE dt = \'2026-10-30\'\n  AND owner_id = \'00042\'$2',
    );
  });
}

function renderPlanPreview() {
  return withVscode(() => {
    const { openPlanPanel } = require(path.join(outputRoot, 'planPanel.js'));
    let captured = '';
    const originalCreate = vscodeStub.window.createWebviewPanel;
    vscodeStub.window.createWebviewPanel = (_viewType, title) => {
      const panel = {
        title,
        viewColumn: vscodeStub.ViewColumn.Beside,
        webview: {
          get html() { return captured; },
          set html(value) { captured = value; },
          postMessage: async () => true,
          onDidReceiveMessage: () => noopDisposable,
        },
        reveal() {},
        onDidDispose() {},
        dispose() {},
      };
      return panel;
    };
    try {
      openPlanPanel({
        name: '订单日汇总',
        source: 'D:\\queries\\orders.sql:12-24',
        connectionName: '分析 Doris',
        databaseType: 'Doris',
        parameters: { biz_date: '2026-10-30' },
        sql: "SELECT dt, COUNT(*) FROM orders WHERE dt = '2026-10-30' GROUP BY dt",
        explainSql: 'EXPLAIN VERBOSE\nSELECT dt, COUNT(*) FROM orders GROUP BY dt',
        plan:
          'PLAN FRAGMENT 0\n  OUTPUT EXPRS: dt | count(*)\n  PARTITION: HASH_PARTITIONED\n\n' +
          '  1:AGGREGATE (update finalize)\n     |  output: count(*)\n     |  group by: dt\n\n' +
          '  0:OlapScanNode\n     TABLE: orders\n     PREDICATES: dt = \'2026-10-30\'\n     PREAGGREGATION: ON\n',
        generatedAt: '2026-10-30T08:00:00.000Z',
      }, vscodeStub.Uri.file('D:\\queries\\orders.sql'));
    } finally {
      vscodeStub.window.createWebviewPanel = originalCreate;
    }
    return captured;
  });
}

function renderResultPreview() {
  const extensionPath = path.join(outputRoot, 'extension.js');
  const source = `${fs.readFileSync(extensionPath, 'utf8')}\nmodule.exports.__preview = { ResultPanel };\n`;
  const module = { exports: {} };
  const context = {
    module,
    exports: module.exports,
    require: (id) => (id === 'vscode' ? vscodeStub : extensionRequire(id)),
    __filename: extensionPath,
    __dirname: path.dirname(extensionPath),
    console,
    process,
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    URL,
    TextEncoder,
    TextDecoder,
  };
  context.global = context;
  vm.createContext(context);
  withVscode(() => vm.runInContext(source, context, { filename: extensionPath }));

  let captured = '';
  const panel = new context.module.exports.__preview.ResultPanel({
    title: '',
    webview: {
      get html() { return captured; },
      set html(value) { captured = value; },
      postMessage: async () => true,
      onDidReceiveMessage: () => noopDisposable,
    },
    reveal() {},
    onDidDispose() {},
  });
  panel.update({
    rows: [
      { order_id: '100031', dt: '2026-10-30', amount: 128.5, status: 'paid' },
      { order_id: '100032', dt: '2026-10-30', amount: 0, status: 'refunded' },
      { order_id: '100033', dt: '2026-10-30', amount: 88, status: 'paid' },
      { order_id: '100034', dt: '2026-10-30', amount: null, status: 'pending' },
      { order_id: '100035', dt: '2026-10-30', amount: 36.2, status: 'paid' },
    ],
    columns: ['order_id', 'dt', 'amount', 'status'],
    affectedRows: 0,
    truncated: true,
    totalRows: 12840,
  }, {
    connectionName: '分析 Doris',
    databaseType: 'Doris',
    statementName: '订单明细',
    database: 'analytics',
    durationMs: 842,
    maxRows: 5,
    readComplete: true,
    parameters: { biz_date: '2026-10-30' },
  });
  return captured;
}

const PREVIEW_PALETTE = `
<style>
  :root {
    color-scheme: dark;
    --vscode-font-family: "Segoe UI Variable Text", "Segoe UI", sans-serif;
    --vscode-editor-font-family: "Cascadia Code", Consolas, monospace;
    --vscode-editor-font-size: 12px;
    --vscode-foreground: #d7dae0;
    --vscode-descriptionForeground: #9da3ad;
    --vscode-editor-background: #181a1f;
    --vscode-editor-foreground: #d7dae0;
    --vscode-editorWidget-background: #20232a;
    --vscode-panel-border: #343841;
    --vscode-focusBorder: #4ea1ff;
    --vscode-button-background: #1769aa;
    --vscode-button-foreground: #ffffff;
    --vscode-button-hoverBackground: #1f7ac2;
    --vscode-button-secondaryBackground: #30343d;
    --vscode-button-secondaryForeground: #f0f2f5;
    --vscode-button-secondaryHoverBackground: #3a3f49;
    --vscode-input-background: #252932;
    --vscode-input-foreground: #e1e4e8;
    --vscode-input-border: #3a3f49;
    --vscode-input-placeholderForeground: #7f8792;
    --vscode-testing-iconPassed: #75be7a;
    --vscode-editorWarning-foreground: #e2b84b;
    --vscode-errorForeground: #f07b72;
    --vscode-textCodeBlock-background: #111318;
    --vscode-list-hoverBackground: #262b33;
    --vscode-list-activeSelectionBackground: #194f78;
    --vscode-list-activeSelectionForeground: #ffffff;
    --vscode-editorGroupHeader-tabsBackground: #20232a;
    --vscode-badge-background: #4b5260;
  }
</style>`;

function withPalette(html) {
  return html.replace('<head>', `<head>${PREVIEW_PALETTE}`);
}

const target = fs.mkdtempSync(path.join(os.tmpdir(), 'doris-sqltools-webviews-'));
const previews = {
  connection: withPalette(renderConnectionPreview()),
  parameters: withPalette(renderParameterPreview()),
  plan: withPalette(renderPlanPreview()),
  results: withPalette(renderResultPreview()),
};

const files = {};
for (const [name, html] of Object.entries(previews)) {
  const file = path.join(target, `${name}.html`);
  fs.writeFileSync(file, html, 'utf8');
  files[name] = file;
}

console.log(JSON.stringify({ target, files }, null, 2));
