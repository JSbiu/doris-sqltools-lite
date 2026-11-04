'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const manifest = require('../package.json');

// 1.0 freezes the externally visible identifiers and data formats. Adding a
// command or setting is compatible; renaming, deleting or changing a default
// or stored version requires a deliberate update here and a migration note.
const COMMAND_IDS = [
  'dorisSqlLite.addConnection',
  'dorisSqlLite.newQuery',
  'dorisSqlLite.setConnection',
  'dorisSqlLite.resetFileSessions',
  'dorisSqlLite.editConnection',
  'dorisSqlLite.runQuery',
  'dorisSqlLite.runQueryToTsv',
  'dorisSqlLite.runBatch',
  'dorisSqlLite.copyLastFeedback',
  'dorisSqlLite.saveLastFeedback',
  'dorisSqlLite.toggleDataMode',
  'dorisSqlLite.exportDataKeys',
  'dorisSqlLite.importDataKeys',
  'dorisSqlLite.decryptSelectedValue',
  'dorisSqlLite.cancelQuery',
  'dorisSqlLite.explainQuery',
  'dorisSqlLite.testConnection',
  'dorisSqlLite.removeConnection',
  'dorisSqlLite.forgetPassword',
  'dorisSqlLite.setExportDirectory',
  'dorisSqlLite.clearExportDirectory',
  'dorisSqlLite.forgetSqlParameters',
];

const CONFIGURATION_DEFAULTS = {
  'dorisSqlLite.maxResultRows': 1000,
  'dorisSqlLite.exportDirectory': '',
  'dorisSqlLite.exportChunkRows': 5000,
  'dorisSqlLite.escapeSpreadsheetFormulas': true,
  'dorisSqlLite.sqlParameters': true,
  'dorisSqlLite.readRowLimit': 0,
  'dorisSqlLite.queryIdleTimeoutMs': 300000,
};

test('frozen 1.0 command and setting contracts remain intact', () => {
  const commands = manifest.contributes.commands.map((command) => command.command);
  assert.deepEqual(commands, COMMAND_IDS);
  assert.equal(new Set(commands).size, commands.length);

  const properties = manifest.contributes.configuration.properties;
  assert.deepEqual(Object.keys(properties).sort(), [
    'dorisSqlLite.connections',
    ...Object.keys(CONFIGURATION_DEFAULTS),
  ].sort());
  for (const [key, value] of Object.entries(CONFIGURATION_DEFAULTS)) {
    assert.deepEqual(properties[key].default, value, `${key} default`);
  }
  // The connection array has no manifest default: its empty state comes from
  // getConfiguration(..., []), so a default here would change migration behavior.
  assert.equal(properties['dorisSqlLite.connections'].default, undefined);
  assert.equal(properties['dorisSqlLite.connections'].scope, 'machine');
  assert.equal(properties['dorisSqlLite.exportDirectory'].scope, 'machine-overridable');
});

test('frozen extension and transport contracts remain intact', () => {
  assert.equal(manifest.name, 'doris-sqltools-lite');
  assert.equal(manifest.publisher, 'local');
  assert.equal(manifest.main, './dist/extension.js');
  assert.equal(manifest.engines.vscode, '^1.90.0');
  assert.equal(manifest.capabilities.untrustedWorkspaces.supported, 'limited');
  assert.equal(manifest.capabilities.virtualWorkspaces.supported, 'limited');
  assert.equal(manifest.activationEvents.length, 1);
  assert.equal(manifest.activationEvents[0], 'onLanguage:sql');
  assert.deepEqual(manifest.contributes.keybindings.map((binding) => binding.key), [
    'ctrl+alt+enter',
    'ctrl+enter',
  ]);

  const fields = manifest.contributes.configuration.properties['dorisSqlLite.connections'].items.properties;
  assert.deepEqual(fields.type.enum, ['MySQL', 'Doris', 'Spark']);
  assert.deepEqual(fields.hiveAuth.enum, ['plain', 'nosasl']);
  assert.equal(fields.ssl.default, false);
  assert.equal(fields.sslVerify.default, true);
  assert.equal(fields.sslCaFile.default, '');
});

test('frozen feedback and field-encryption data versions remain intact', () => {
  const { FEEDBACK_SCHEMA_VERSION } = require('../out/sqlFeedback.js');
  const { createDataKey, encryptValue, decryptValue } = require('../out/fieldEncryption.js');
  const { DataKeys } = require('../out/dataKeys.js');

  assert.equal(FEEDBACK_SCHEMA_VERSION, 1);

  const root = path.resolve(__dirname, '..');
  const feedback = fs.readFileSync(
    path.join(root, 'docs/feedback-schema.md'),
    'utf8',
  );
  assert.match(feedback, /`schemaVersion`：当前固定为 `1`/);
  assert.match(fs.readFileSync(path.join(root, 'src/fieldEncryption.ts'), 'utf8'), /const VERSION = 'v1'/);

  const key = createDataKey();
  const token = encryptValue('00042', 'user', key);
  assert.match(token, /^enc:v1:/);
  assert.equal(decryptValue(token, () => key, 'user'), '00042');

  // The key file is another on-disk contract: existing users must be able to
  // import a v1 export from 1.0 and later builds.
  const stored = new Map();
  const storage = {
    async get(name) { return stored.get(name); },
    async store(name, value) { stored.set(name, value); },
  };
  return new DataKeys(storage).exportKeys().then((text) => {
    const record = JSON.parse(text);
    assert.equal(record.version, 1);
    assert.equal(typeof record.active, 'string');
    assert.equal(record.keys.length, 1);
    assert.deepEqual(JSON.parse(record.keys[0]).version, 1);
  });
});
