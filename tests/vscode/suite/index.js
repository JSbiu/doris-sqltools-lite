'use strict';

const assert = require('node:assert/strict');
const vscode = require('vscode');

const EXTENSION_ID = 'local.doris-sqltools-lite';
const REQUIRED_COMMANDS = [
  'addConnection',
  'newQuery',
  'setConnection',
  'resetFileSessions',
  'editConnection',
  'runQuery',
  'runQueryToTsv',
  'runBatch',
  'copyLastFeedback',
  'saveLastFeedback',
  'toggleDataMode',
  'exportDataKeys',
  'importDataKeys',
  'decryptSelectedValue',
  'cancelQuery',
  'explainQuery',
  'testConnection',
  'removeConnection',
  'forgetPassword',
  'setExportDirectory',
  'clearExportDirectory',
  'forgetSqlParameters',
].map((name) => `dorisSqlLite.${name}`);

async function run() {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `找不到扩展 ${EXTENSION_ID}`);
  await extension.activate();
  assert.equal(extension.isActive, true);

  const manifest = extension.packageJSON;
  assert.equal(manifest.engines.vscode, '^1.90.0');
  assert.equal(manifest.contributes.commands.length, REQUIRED_COMMANDS.length);
  assert.ok(manifest.contributes.configuration.properties['dorisSqlLite.connections']);
  assert.ok(manifest.contributes.configuration.properties['dorisSqlLite.maxResultRows']);

  const registered = new Set(await vscode.commands.getCommands(true));
  const missing = REQUIRED_COMMANDS.filter((command) => !registered.has(command));
  assert.deepEqual(missing, [], `未注册命令：${missing.join(', ')}`);

  await vscode.commands.executeCommand('dorisSqlLite.addConnection');
}

module.exports = { run };
