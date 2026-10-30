const assert = require('node:assert/strict');
const test = require('node:test');
const manifest = require('../package.json');

test('declares limited workspace support so script execution follows VS Code trust', () => {
  assert.equal(manifest.capabilities.untrustedWorkspaces.supported, 'limited');
  assert.match(manifest.capabilities.untrustedWorkspaces.description, /受信任工作区/);
  assert.equal(manifest.capabilities.virtualWorkspaces.supported, 'limited');
  assert.match(manifest.capabilities.virtualWorkspaces.description, /本地文件系统/);
});

test('declares TLS settings only for the MySQL-protocol connections', () => {
  const connection = manifest.contributes.configuration.properties['dorisSqlLite.connections'];
  const fields = connection.items.properties;

  assert.equal(fields.ssl.type, 'boolean');
  assert.equal(fields.sslVerify.type, 'boolean');
  assert.equal(fields.sslVerify.default, true);
  assert.equal(fields.sslCaFile.type, 'string');
  assert.match(fields.ssl.description, /MySQL \/ Doris/);
  assert.match(fields.ssl.description, /Spark Thrift/);
});

test('pins both the VS Code engine and its type definitions to the tested minimum', () => {
  assert.equal(manifest.engines.vscode, '^1.90.0');
  assert.equal(manifest.devDependencies['@types/vscode'], '1.90.0');
});

test('uses the display name, Chinese command titles and namespaced command IDs consistently', () => {
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].title, manifest.displayName);
  assert.equal(manifest.contributes.configuration.title, manifest.displayName);

  for (const command of manifest.contributes.commands) {
    assert.match(command.command, /^dorisSqlLite\.[A-Za-z0-9]+$/);
    assert.ok(command.title.startsWith(`${manifest.displayName}: `));
    assert.match(command.title, /: [\u3400-\u9fff]/);
  }
});
