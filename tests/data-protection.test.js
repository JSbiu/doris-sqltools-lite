const assert = require('node:assert/strict');
const test = require('node:test');
const { createDataKey, encryptValue, decryptValue } = require('../out/fieldEncryption');
const { DataKeys } = require('../out/dataKeys');
const { createProtection, getDataMode, setDataMode, onDataModeChange, loadParameterKeys, decodeParameter, protectSink } = require('../out/dataProtection');

test('projection preserves raw rows, domains and types while mode snapshots remain independent', () => {
  const key = createDataKey();
  const rules = { user_id: 'user', owner_id: 'user', text: 'contact' };
  const projection = createProtection(rules, ['user_id'], key, () => key, 'encrypted');
  rules.user_id = 'later edit'; key.material.fill(0);
  const row = { user_id: '001', owner_id: '001', text: '中文\n空格 ', count: 7 };
  const encrypted = projection.row(row);
  assert.equal(encrypted.user_id, encrypted.owner_id);
  assert.equal(encrypted.count, 7);
  assert.notEqual(encrypted.user_id, '001');
  assert.deepEqual(projection.withMode('plain').row(row), row);
  assert.equal(row.user_id, '001');
  assert.equal(projection.info.fields.user_id, 'user');
  assert.ok(!JSON.stringify(projection).includes('material'));
  setDataMode('plain');
  assert.equal(projection.row(row).user_id, encrypted.user_id);
  setDataMode('encrypted');
});

test('one global mode change notifies once and disposal releases the listener', () => {
  setDataMode('encrypted');
  let count = 0;
  const subscription = onDataModeChange(() => count++);
  setDataMode('encrypted'); setDataMode('plain');
  assert.equal(getDataMode(), 'plain'); assert.equal(count, 1);
  subscription.dispose(); setDataMode('encrypted'); assert.equal(count, 1);
});

test('explicit fields require columns or actual parameters, defaults may be absent and writes stay successful', () => {
  const key = createDataKey();
  const protection = createProtection({ id: 'id', absentDefault: 'id' }, ['id'], key, () => key);
  protection.validate(['count'], { id: '1' }, true);
  protection.validate([], {}, false);
  assert.throws(() => protection.validate(['count'], {}, true), /未匹配/);
  assert.throws(() => protection.validate(['id', 'id'], {}, true), /重名/);
});

test('declared ciphertext parameters recover exact text without touching undeclared fields or unknown keys', async () => {
  const stored = new Map();
  const keys = new DataKeys({ get: async (key) => stored.get(key), store: async (key, value) => { stored.set(key, value); } });
  const key = await keys.active();
  const restarted = new DataKeys({ get: async (key) => stored.get(key), store: async () => assert.fail('no new key') });
  const empty = encryptValue('', 'user', key);
  const text = encryptValue('00\n$${unchanged}中文', 'user', key);
  await loadParameterKeys({ id: empty, other: 'enc:invalid' }, { id: 'user' }, restarted);
  assert.equal(decodeParameter('id', empty, { id: 'user' }, restarted), '');
  assert.equal(decodeParameter('id', text, { id: 'user' }, restarted), '00\n$${unchanged}中文');
  assert.equal(decodeParameter('other', text, { id: 'user' }, restarted), text);
  assert.throws(() => decodeParameter('id', text, { id: 'space' }, restarted), /逻辑域/);
  const projection = createProtection({ id: 'user' }, [], key, (id) => restarted.lookup(id), 'encrypted');
  assert.equal(projection.parameters({ id: empty }, true).id, empty);
  assert.equal(projection.withMode('plain').parameters({ id: text }, true).id, '00\n$${unchanged}中文');
  assert.equal(decryptValue(projection.parameters({ id: '001' }).id, () => key), '001');
  const literal = 'enc:this-is-original-text';
  const decoded = decodeParameter('id', encryptValue(literal, 'user', key), { id: 'user' }, restarted);
  assert.equal(decryptValue(projection.parameters({ id: decoded }).id, () => key), literal);
  assert.throws(() => decodeParameter('id', encryptValue(Buffer.from([0xff, 0]), 'user', key), { id: 'user' }, restarted), /不能作为 SQL 参数/);
});

test('stream protection defers column errors outside event callbacks and awaits the transformed row sink', async () => {
  const key = createDataKey();
  const projection = createProtection({ id: 'id' }, ['id'], key, () => key);
  const rows = [];
  const target = { onColumns() {}, onAffectedRows() {}, onRow: async (row) => { await Promise.resolve(); rows.push(row); } };
  const failed = protectSink(target, projection, {});
  assert.doesNotThrow(() => failed.sink.onColumns(['other']));
  assert.throws(() => failed.check(), /未匹配/);
  assert.throws(() => failed.sink.onRow({ other: 'sensitive' }), /未匹配/);
  const valid = protectSink(target, projection, {});
  valid.sink.onColumns(['id']);
  await valid.sink.onRow({ id: '001' }); valid.check();
  assert.equal(decryptValue(rows[0].id, () => key), '001');
});
