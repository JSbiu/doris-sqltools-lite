const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { DataKeys } = require('../out/dataKeys');
const { encryptValue } = require('../out/fieldEncryption');
const { getDataMode, setDataMode } = require('../out/dataProtection');

function fixture(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sqltools-key-ui-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir())); fs.rmSync(folder, { recursive: true, force: true }); });
  const state = new Map(); const commands = new Map(); const notices = []; const clipboard = []; const documents = [];
  const keys = new DataKeys({ get: async (id) => state.get(id), store: async (id, value) => { state.set(id, value); } });
  const choices = {};
  const context = { subscriptions: [] };
  const disposable = { dispose() {} };
  const status = { show() {}, dispose() {} };
  const vscode = {
    StatusBarAlignment: { Right: 2 },
    commands: { registerCommand(id, callback) { commands.set(id, callback); return disposable; } },
    window: {
      createStatusBarItem: () => status,
      showSaveDialog: async () => choices.target,
      showOpenDialog: async () => choices.target && [choices.target],
      showQuickPick: async () => choices.output,
      showInputBox: async () => choices.token,
      showTextDocument: async (document) => documents.push(document),
      showErrorMessage: async (message) => notices.push(message),
      showInformationMessage: async (message) => notices.push(message),
    },
    workspace: { openTextDocument: async (value) => value },
    env: { clipboard: { writeText: async (value) => clipboard.push(value) } },
  };
  const filename = path.resolve(__dirname, '../out/dataCommands.js'); const realRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, Buffer,
    require: (id) => id === 'vscode' ? vscode : realRequire(id) });
  module.exports.registerDataCommands(context, keys);
  t.after(() => context.subscriptions.forEach((value) => value.dispose()));
  return { keys, choices, folder, state, notices, clipboard, documents, status,
    command: (name) => commands.get(`dorisSqlLite.${name}`)(),
    target: (name) => ({ scheme: 'file', fsPath: path.join(folder, name) }) };
}

test('registering and toggling mode do not create data keys', async (t) => {
  setDataMode('encrypted'); const h = fixture(t);
  assert.equal(h.state.size, 0);
  await h.command('toggleDataMode'); assert.equal(getDataMode(), 'plain'); assert.match(h.status.text, /字段原文/);
  await h.command('toggleDataMode'); assert.equal(getDataMode(), 'encrypted'); assert.match(h.status.text, /字段密文/);
  await h.command('toggleDataMode'); assert.equal(h.state.size, 0);
});

test('explicit key export refuses overwrite and import retains pre-existing keys', async (t) => {
  const h = fixture(t); h.choices.target = h.target('keys.json');
  await h.command('exportDataKeys');
  const exported = fs.readFileSync(h.choices.target.fsPath, 'utf8');
  assert.equal(JSON.parse(exported).version, 1);
  await h.command('exportDataKeys'); assert.equal(fs.readFileSync(h.choices.target.fsPath, 'utf8'), exported);
  await h.command('importDataKeys');
  assert.ok(!JSON.stringify(h.notices).includes(JSON.parse(exported).keys[0]));
  assert.equal(h.clipboard.length, 0);
});

test('decrypt shows or copies only after the explicit output choice and never prints raw values in notices', async (t) => {
  const h = fixture(t); const key = await h.keys.active();
  h.choices.token = encryptValue('001中文', 'user', key);
  await h.command('decryptSelectedValue'); assert.equal(h.documents.length, 0); assert.equal(h.clipboard.length, 0);
  h.choices.output = '在本机查看明文'; await h.command('decryptSelectedValue'); assert.equal(h.documents[0].content, '001中文');
  h.choices.output = '复制明文'; await h.command('decryptSelectedValue'); assert.equal(h.clipboard[0], '001中文');
  assert.ok(!JSON.stringify(h.notices).includes('001中文'));
  h.choices.token = 'enc:secret-malformed'; await h.command('decryptSelectedValue');
  assert.ok(!JSON.stringify(h.notices).includes('secret-malformed'));
});
