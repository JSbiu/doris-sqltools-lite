'use strict';

const assert = require('node:assert/strict');
const vscode = require('vscode');

const EXTENSION_ID = 'local.doris-sqltools-lite';
const CONNECTION_FORM_VIEW_TYPE = 'dorisSqlLiteConnectionForm';
const LEGACY_WEBVIEW_VIEW_TYPE_PREFIX = 'mainThreadWebview-';
const UI_TIMEOUT_MS = 5_000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(read, description, timeout = UI_TIMEOUT_MS, diagnose = () => '') {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = read();
    if (result) return result;
    await delay(50);
  }
  const details = diagnose();
  throw new Error(`等待超时：${description}${details ? `\n${details}` : ''}`);
}

function tabInputViewType(tab) {
  const input = tab.input;
  if (typeof input?.viewType !== 'string') return undefined;
  return input.viewType.startsWith(LEGACY_WEBVIEW_VIEW_TYPE_PREFIX)
    ? input.viewType.slice(LEGACY_WEBVIEW_VIEW_TYPE_PREFIX.length)
    : input.viewType;
}

function allTabs() {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs);
}

function describeTabs() {
  const tabs = allTabs().map((tab) => ({
    label: tab.label,
    input: tab.input?.constructor?.name,
    viewType: tabInputViewType(tab),
    isActive: tab.isActive,
  }));
  return `当前标签页：${JSON.stringify(tabs)}`;
}

function connectionFormTabs() {
  return allTabs().filter((tab) => tabInputViewType(tab) === CONNECTION_FORM_VIEW_TYPE);
}

async function closeConnectionFormTabs() {
  const tabs = connectionFormTabs();
  if (tabs.length === 0) return;
  const closed = await vscode.window.tabGroups.close(tabs, true);
  assert.equal(closed, true, '连接表单标签页应能关闭');
  await waitFor(
    () => connectionFormTabs().length === 0,
    '连接表单标签页关闭后从 tabGroups 消失',
    UI_TIMEOUT_MS,
    describeTabs,
  );
}

function assertConfiguration(manifest) {
  const properties = manifest.contributes.configuration.properties;
  const connections = properties['dorisSqlLite.connections'];
  assert.equal(connections.type, 'array');
  assert.equal(connections.scope, 'machine');
  assert.deepEqual(connections.items.required, ['id', 'name', 'type', 'host', 'port', 'username']);
  assert.deepEqual(connections.items.properties.type.enum, ['MySQL', 'Doris', 'Spark']);
  assert.equal(connections.items.properties.port.default, 3306);
  assert.equal(connections.items.properties.ssl.default, false);
  assert.equal(connections.items.properties.sslVerify.default, true);
  assert.equal(connections.items.properties.sslCaFile.default, '');
  assert.deepEqual(connections.items.properties.hiveAuth.enum, ['plain', 'nosasl']);

  const expectedSchema = {
    'dorisSqlLite.maxResultRows': { default: 1000, minimum: 1, maximum: 100000 },
    'dorisSqlLite.exportDirectory': { default: '', scope: 'machine-overridable' },
    'dorisSqlLite.exportChunkRows': { default: 5000, minimum: 100, maximum: 100000 },
    'dorisSqlLite.escapeSpreadsheetFormulas': { default: true },
    'dorisSqlLite.sqlParameters': { default: true },
    'dorisSqlLite.readRowLimit': { default: 0 },
    'dorisSqlLite.queryIdleTimeoutMs': { default: 300000, minimum: 0 },
  };
  for (const [key, expected] of Object.entries(expectedSchema)) {
    const actual = properties[key];
    assert.ok(actual, `${key} 应有配置 schema`);
    for (const [field, value] of Object.entries(expected)) {
      assert.equal(actual[field], value, `${key}.${field}`);
    }
  }

  const configuration = vscode.workspace.getConfiguration('dorisSqlLite');
  for (const [qualifiedKey, expected] of Object.entries(expectedSchema)) {
    const key = qualifiedKey.slice('dorisSqlLite.'.length);
    assert.equal(configuration.inspect(key)?.defaultValue, expected.default, `${qualifiedKey} 默认值`);
  }
}

function assertCommands(manifest) {
  const declared = manifest.contributes.commands;
  assert.equal(declared.length, 22);
  const declaredIds = declared.map((command) => command.command);
  assert.equal(new Set(declaredIds).size, declaredIds.length, '命令 ID 应唯一');
  for (const command of declared) {
    assert.match(command.command, /^dorisSqlLite\.[A-Za-z0-9]+$/);
    assert.ok(command.title.startsWith(`${manifest.displayName}: `));
  }
  return declaredIds;
}

async function run() {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `找不到扩展 ${EXTENSION_ID}`);
  await extension.activate();
  assert.equal(extension.isActive, true);

  const manifest = extension.packageJSON;
  assert.equal(manifest.engines.vscode, '^1.90.0');
  assertConfiguration(manifest);
  const declaredCommands = assertCommands(manifest);

  const registered = new Set(await vscode.commands.getCommands(true));
  const missing = declaredCommands.filter((command) => !registered.has(command));
  assert.deepEqual(missing, [], `未注册命令：${missing.join(', ')}`);
  const extensionCommands = [...registered]
    .filter((command) => command.startsWith('dorisSqlLite.'))
    .sort();
  assert.deepEqual(extensionCommands, [...declaredCommands].sort(), '运行中的扩展命令应与 package.json 完全一致');

  await closeConnectionFormTabs();
  try {
    await vscode.commands.executeCommand('dorisSqlLite.addConnection');
    const opened = await waitFor(
      () => connectionFormTabs()[0],
      '执行添加连接命令后打开 Webview',
      UI_TIMEOUT_MS,
      describeTabs,
    );
    assert.equal(opened.label, '添加连接');

    const closed = await vscode.window.tabGroups.close(opened, true);
    assert.equal(closed, true, '连接表单标签页应能关闭');
    await waitFor(
      () => connectionFormTabs().length === 0,
      '连接表单标签页关闭后从 tabGroups 消失',
      UI_TIMEOUT_MS,
      describeTabs,
    );

    await vscode.commands.executeCommand('dorisSqlLite.addConnection');
    const reopened = await waitFor(
      () => connectionFormTabs()[0],
      '关闭后再次执行添加连接命令仍能打开 Webview',
      UI_TIMEOUT_MS,
      describeTabs,
    );
    assert.equal(reopened.label, '添加连接');
  } finally {
    await closeConnectionFormTabs();
  }
}

module.exports = { run };
