'use strict';

const assert = require('node:assert/strict');
const vscode = require('vscode');

async function run() {
  const id = process.env.DORIS_SQLTOOLS_EXPECTED_ID;
  const version = process.env.DORIS_SQLTOOLS_EXPECTED_VERSION;
  assert.ok(id && version, 'missing expected installed extension identity');

  const extension = vscode.extensions.getExtension(id);
  assert.ok(extension, `installed extension not found: ${id}`);
  assert.equal(extension.packageJSON.version, version);
  assert.equal(extension.packageJSON.publisher, id.split('.')[0]);
  assert.equal(extension.packageJSON.name, id.slice(id.indexOf('.') + 1));
  assert.equal(extension.packageJSON.main, './dist/extension.js');

  await extension.activate();
  assert.equal(extension.isActive, true);

  const declared = extension.packageJSON.contributes.commands
    .map((command) => command.command)
    .sort();
  const registered = [...await vscode.commands.getCommands(true)]
    .filter((command) => command.startsWith('dorisSqlLite.'))
    .sort();
  assert.deepEqual(registered, declared, 'installed VSIX commands differ from its manifest');
  assert.equal(declared.length, 22);

  const configuration = vscode.workspace.getConfiguration('dorisSqlLite');
  assert.equal(configuration.inspect('maxResultRows')?.defaultValue, 1000);
  assert.equal(extension.packageJSON.contributes.configuration.properties['dorisSqlLite.connections'].scope, 'machine');
}

module.exports = { run };
