'use strict';

// Loads dist/extension.js outside VS Code. This is the only local check for
// the failure mode bundling actually introduces: a module that resolves at
// build time but throws when it is evaluated (an optional native dependency
// reached with a bare require, a JSON payload the bundler inlined differently,
// a module left external with nobody to provide it).
//
// The extension host injects `vscode`, so a stub stands in for it. The two
// database drivers are required lazily by the session factory, so activation
// alone does not prove they survived bundling — they get their own probe
// bundle, built with the same settings as the shipped one.
//
// Usage: node scripts/check-bundle.js
// Exits non-zero when something is wrong, so it can gate the test run.

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { EXTERNAL, outfile, projectRoot } = require('./bundle-config');

const probePath = path.join(projectRoot, '.local', '_bundle-probe.js');

const noopDisposable = { dispose() {} };

function createVscodeStub(registeredCommands) {
  class TreeItem {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  }

  class EventEmitter {
    constructor() {
      this.event = () => noopDisposable;
    }
    fire() {}
    dispose() {}
  }

  const configuration = {
    get(_key, fallback) {
      return fallback;
    },
    inspect() {
      return undefined;
    },
    async update() {},
  };

  const statusBar = () => ({
    name: '',
    text: '',
    tooltip: '',
    command: '',
    show() {},
    hide() {},
    dispose() {},
  });

  return {
    window: {
      activeTextEditor: undefined,
      createStatusBarItem: statusBar,
      registerTreeDataProvider: () => noopDisposable,
      registerWebviewPanelSerializer: () => noopDisposable,
      onDidChangeActiveTextEditor: () => noopDisposable,
      showInformationMessage: () => Promise.resolve(undefined),
      showWarningMessage: () => Promise.resolve(undefined),
      showErrorMessage: () => Promise.resolve(undefined),
      showInputBox: () => Promise.resolve(undefined),
      showQuickPick: () => Promise.resolve(undefined),
      showSaveDialog: () => Promise.resolve(undefined),
      withProgress: (_options, task) =>
        task({ report() {} }, {
          isCancellationRequested: false,
          onCancellationRequested: () => noopDisposable,
        }),
    },
    workspace: {
      workspaceFolders: undefined,
      getConfiguration: () => configuration,
      onDidCloseTextDocument: () => noopDisposable,
      onDidChangeConfiguration: () => noopDisposable,
      fs: { async writeFile() {} },
    },
    commands: {
      registerCommand(id) {
        registeredCommands.push(id);
        return noopDisposable;
      },
      executeCommand: () => Promise.resolve(undefined),
    },
    TreeItem,
    EventEmitter,
    ThemeIcon: class {
      constructor(id) {
        this.id = id;
      }
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Active: -1, One: 1 },
    ProgressLocation: { Notification: 15 },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    Uri: {
      file: (fsPath) => ({ scheme: 'file', fsPath, toString: () => `file://${fsPath}` }),
    },
  };
}

function createContext() {
  return {
    subscriptions: [],
    extensionPath: projectRoot,
    secrets: {
      async get() {
        return undefined;
      },
      async store() {},
      async delete() {},
      onDidChange: () => noopDisposable,
    },
    globalState: {
      get: () => undefined,
      async update() {},
      keys: () => [],
    },
    workspaceState: {
      get: () => undefined,
      async update() {},
      keys: () => [],
    },
  };
}

const probeSource = `
const mysql = require('mysql2/promise');
const hive = require('hive-driver');
const tcp = new hive.connections.TcpConnection();
module.exports = {
  createConnection: typeof mysql.createConnection,
  hiveClient: typeof hive.HiveClient,
  hiveUtils: typeof hive.HiveUtils,
  noSasl: typeof hive.auth.NoSaslAuthentication,
  plain: typeof hive.auth.PlainTcpAuthentication,
  tcpName: tcp.constructor.name,
  protocols: Object.keys(hive.thrift.TCLIService_types.TProtocolVersion ?? {}).length,
};
`;

async function checkDrivers() {
  const esbuild = require('esbuild');
  const problems = [];

  await esbuild.build({
    stdin: {
      contents: probeSource,
      resolveDir: projectRoot,
      sourcefile: 'bundle-probe.js',
      loader: 'js',
    },
    outfile: probePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: EXTERNAL,
    logLevel: 'silent',
  });

  let observed;
  try {
    observed = require(probePath);
  } catch (error) {
    return [`loading the bundled drivers threw: ${error.message}`];
  } finally {
    fs.rmSync(probePath, { force: true });
  }

  const expected = [
    ['createConnection', 'function'],
    ['hiveClient', 'function'],
    ['hiveUtils', 'function'],
    ['noSasl', 'function'],
    ['plain', 'function'],
    ['tcpName', 'TcpConnection'],
  ];
  for (const [key, want] of expected) {
    if (observed[key] !== want) {
      problems.push(`bundled ${key} is ${observed[key]}, expected ${want}`);
    }
  }
  if (!(observed.protocols > 0)) {
    problems.push('bundled thrift exposes no TProtocolVersion values');
  }

  return problems;
}

async function main() {
  const problems = [];

  if (!fs.existsSync(outfile)) {
    console.log('  FAIL  dist/extension.js is missing — run: node scripts/build.js');
    process.exitCode = 1;
    return;
  }

  const registeredCommands = [];
  const stub = createVscodeStub(registeredCommands);
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
      return stub;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const extension = require(outfile);
    if (typeof extension.activate !== 'function') {
      problems.push('the bundle does not export activate()');
    } else {
      await extension.activate(createContext());
      if (registeredCommands.length === 0) {
        problems.push('activate() registered no commands');
      }
    }
  } catch (error) {
    problems.push(`loading dist/extension.js threw: ${error.message}`);
  } finally {
    Module._load = originalLoad;
  }

  const activationOk = problems.length === 0;
  console.log(
    `  ${activationOk ? 'ok  ' : 'FAIL'}  dist/extension.js loads and activates (${registeredCommands.length} commands registered)`,
  );

  const driverProblems = await checkDrivers();
  problems.push(...driverProblems);
  console.log(`  ${driverProblems.length === 0 ? 'ok  ' : 'FAIL'}  both drivers resolve inside a bundle`);

  for (const problem of problems) {
    console.log(`        - ${problem}`);
  }
  console.log(problems.length === 0 ? '  all good' : `  ${problems.length} problem(s)`);
  process.exitCode = problems.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
