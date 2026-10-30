const assert = require('node:assert/strict');
const test = require('node:test');
const { DataKeys } = require('../out/dataKeys.js');
const {
  createDataKey,
  decodeDataKey,
  encodeDataKey,
  encryptValue,
  decryptValue,
} = require('../out/fieldEncryption.js');

const PREFIX = 'dorisSqlLite.dataKeys.';
const ACTIVE = `${PREFIX}active`;
const INDEX = `${PREFIX}ids`;
const keyEntry = (id) => `${PREFIX}key.${id}`;
const INVALID_IMPORT = '字段加密密钥导入内容无效。';
const INVALID_STORED = '保存的字段加密密钥已损坏。';
const CONFLICT = '字段加密密钥 ID 对应的材料冲突。';
const READ_FAILED = '无法读取字段加密密钥存储。';
const WRITE_FAILED = '无法保存字段加密密钥。';

function memoryStorage(initial = []) {
  const values = new Map(initial);
  const storage = {
    values,
    reads: [],
    writes: [],
    async get(key) {
      storage.reads.push(key);
      if (storage.beforeGet) await storage.beforeGet(key);
      return values.get(key);
    },
    async store(key, value) {
      storage.writes.push({ key, value });
      if (storage.beforeStore) await storage.beforeStore(key, value);
      values.set(key, value);
    },
  };
  return storage;
}

function bundle(keys, active = keys[0].id) {
  return JSON.stringify({ version: 1, active, keys: keys.map(encodeDataKey) });
}

function exportedKeys(text) {
  const parsed = JSON.parse(text);
  assert.equal(parsed.version, 1);
  return new Map(parsed.keys.map((entry) => {
    assert.equal(typeof entry, 'string');
    const key = decodeDataKey(entry);
    return [key.id, encodeDataKey(key)];
  }));
}

function decrypt(token, keys, domain = 'business.id') {
  return decryptValue(token, (id) => keys.lookup(id), domain);
}

async function rejectsStatic(action, message) {
  await assert.rejects(action, (error) => {
    assert.equal(error.message, message);
    assert.equal(error.cause, undefined);
    return true;
  });
}

function barrier(parties) {
  let remaining = parties;
  let release;
  const reached = new Promise((resolve) => { release = resolve; });
  return async () => {
    if (--remaining === 0) release();
    await reached;
  };
}

test('fresh storage receives a random UUID and independent 64-byte data key', async () => {
  const stores = [memoryStorage(), memoryStorage()];
  const keys = await Promise.all(stores.map((store) => new DataKeys(store).active()));
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    assert.match(key.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(key.material.length, 64);
    assert.equal(stores[i].values.get(keyEntry(key.id)), encodeDataKey(key));
    assert.equal(stores[i].values.get(ACTIVE), key.id);
    assert.deepEqual(JSON.parse(stores[i].values.get(INDEX)), [key.id]);
  }
  assert.notEqual(keys[0].id, keys[1].id);
  assert.notDeepEqual(keys[0].material, keys[1].material);
});

test('restart reuses the stored active key and produces the same ciphertext without writes', async () => {
  const store = memoryStorage();
  const first = new DataKeys(store);
  const key = await first.active();
  const token = encryptValue('123', 'business.id', key);
  const writes = store.writes.length;
  const restarted = new DataKeys(store);
  assert.equal(restarted.lookup(key.id), undefined);
  const restored = await restarted.active();
  assert.equal(encodeDataKey(restored), encodeDataKey(key));
  assert.equal(encryptValue('123', 'business.id', restored), token);
  assert.equal(decrypt(token, restarted), '123');
  assert.equal(store.writes.length, writes);
});

test('concurrent active calls in one instance generate and save just one key', async () => {
  const store = memoryStorage();
  const keys = new DataKeys(store);
  const active = await Promise.all(Array.from({ length: 32 }, () => keys.active()));
  assert.equal(new Set(active.map(encodeDataKey)).size, 1);
  assert.equal(store.writes.filter(({ key }) => key.startsWith(`${PREFIX}key.`)).length, 1);
});

test('two windows preserve both saved keys even when their index updates race', async () => {
  const values = new Map();
  const bothReadActive = barrier(2);
  const bothReadIndex = barrier(2);
  const writes = [];
  function windowStorage() {
    let firstActive = true;
    return {
      async get(key) {
        const snapshot = values.get(key);
        if (key === ACTIVE && firstActive) {
          firstActive = false;
          await bothReadActive();
        }
        if (key === INDEX) await bothReadIndex();
        return snapshot;
      },
      async store(key, value) {
        writes.push({ key, value });
        values.set(key, value);
      },
    };
  }
  const first = new DataKeys(windowStorage());
  const second = new DataKeys(windowStorage());
  const [a, b] = await Promise.all([first.active(), second.active()]);
  assert.notEqual(a.id, b.id);
  assert.equal(JSON.parse(values.get(INDEX)).length, 1);
  assert.equal(values.get(keyEntry(a.id)), encodeDataKey(a));
  assert.equal(values.get(keyEntry(b.id)), encodeDataKey(b));
  assert.equal(writes.filter(({ key }) => key.startsWith(`${PREFIX}key.`)).length, 2);
  const tokens = [a, b].map((key, i) => encryptValue(`old-${i}`, 'business.id', key));
  const restarted = new DataKeys(memoryStorage(values));
  for (let i = 0; i < tokens.length; i += 1) {
    await restarted.loadToken(tokens[i]);
    assert.equal(decrypt(tokens[i], restarted), `old-${i}`);
  }
  const exported = exportedKeys(await restarted.exportKeys());
  assert.equal(exported.get(a.id), encodeDataKey(a));
  assert.equal(exported.get(b.id), encodeDataKey(b));
});

test('loadToken reads its ID directly despite missing index and broken active pointer', async () => {
  const key = createDataKey();
  const token = encryptValue(123n, 'business.id', key);
  const store = memoryStorage([[keyEntry(key.id), encodeDataKey(key)], [ACTIVE, 'broken:pointer']]);
  const keys = new DataKeys(store);
  await keys.loadToken(token);
  assert.equal(decrypt(token, keys), 123n);
  assert.deepEqual(store.reads, [keyEntry(key.id)]);
  assert.equal(store.writes.length, 0);
});

test('loadToken accepts the core envelope grammar including imported IDs and empty domains', async () => {
  const key = { ...createDataKey(), id: 'legacy_key-1' };
  const store = memoryStorage([[keyEntry(key.id), encodeDataKey(key)]]);
  const keys = new DataKeys(store);
  for (const domain of ['', '客户.编号']) {
    const token = encryptValue('value', domain, key);
    await keys.loadToken(token);
    assert.equal(decrypt(token, keys, domain), 'value');
  }
});

test('malformed tokens fail with a static error before any storage access', async () => {
  const key = createDataKey();
  const valid = encryptValue('private-value', 'business.id', key);
  const parts = valid.split(':');
  const malformed = [
    '', 'private-value', valid.replace('enc:', 'other:'), valid.replace(':v1:', ':v2:'),
    valid + ':extra', parts.slice(0, 4).join(':'),
    ['enc', 'v1', '', parts[3], parts[4]].join(':'),
    ['enc', 'v1', 'bad/id', parts[3], parts[4]].join(':'),
    ['enc', 'v1', key.id, parts[3] + '=', parts[4]].join(':'),
    ['enc', 'v1', key.id, '_w', parts[4]].join(':'), // Invalid UTF-8.
    ['enc', 'v1', key.id, 'Zh', parts[4]].join(':'), // Non-canonical trailing bits.
    ['enc', 'v1', key.id, parts[3], 'AA'].join(':'),
    ['enc', 'v1', key.id, parts[3], parts[4] + '='].join(':'),
    ['enc', 'v1', key.id, parts[3], parts[4] + '\n'].join(':'),
  ];
  const store = memoryStorage();
  const keys = new DataKeys(store);
  for (const token of malformed) {
    await rejectsStatic(() => keys.loadToken(token), '字段密文格式无效。');
  }
  assert.equal(store.reads.length, 0);
  assert.equal(store.writes.length, 0);
});

test('a missing token key fails without generating or caching a replacement', async () => {
  const key = createDataKey();
  const store = memoryStorage();
  const keys = new DataKeys(store);
  await rejectsStatic(
    () => keys.loadToken(encryptValue('private-value', 'business.id', key)),
    '找不到字段密文所需的密钥。',
  );
  assert.equal(keys.lookup(key.id), undefined);
  assert.equal(store.writes.length, 0);
});

test('explicit export/import keeps previous keys and makes every old token decryptable after restart', async () => {
  const store = memoryStorage();
  const target = new DataKeys(store);
  const previous = await target.active();
  const source = new DataKeys(memoryStorage());
  const sourceOld = await source.active();
  const sourceNew = createDataKey();
  await source.importKeys(bundle([sourceNew]));
  const incoming = await source.exportKeys();
  await target.importKeys(incoming);
  assert.equal((await target.active()).id, sourceNew.id);
  const output = await target.exportKeys();
  assert.equal(JSON.parse(output).active, sourceNew.id);
  const exported = exportedKeys(output);
  assert.equal(exported.size, 3);
  const restarted = new DataKeys(store);
  for (const key of [previous, sourceOld, sourceNew]) {
    assert.equal(exported.get(key.id), encodeDataKey(key));
    assert.equal(store.values.get(keyEntry(key.id)), encodeDataKey(key));
    const token = encryptValue(key.id, 'business.id', key);
    await restarted.loadToken(token);
    assert.equal(decrypt(token, restarted), key.id);
  }
});

test('index merging preserves recognizable existing IDs and the previous unindexed active key', async () => {
  const indexed = createDataKey();
  const active = createDataKey();
  const imported = createDataKey();
  const store = memoryStorage([
    [keyEntry(indexed.id), encodeDataKey(indexed)],
    [keyEntry(active.id), encodeDataKey(active)],
    [ACTIVE, active.id],
    [INDEX, JSON.stringify([indexed.id, indexed.id, null, 2, 'bad:id', ''])],
  ]);
  const keys = new DataKeys(store);
  await keys.importKeys(bundle([imported]));
  assert.deepEqual(new Set(JSON.parse(store.values.get(INDEX))), new Set([indexed.id, active.id, imported.id]));
  assert.equal(exportedKeys(await keys.exportKeys()).size, 3);
});

test('a damaged advisory index does not prevent direct loading and can be rebuilt on import', async () => {
  const old = createDataKey();
  const incoming = createDataKey();
  for (const index of ['broken JSON', '{}', 'null']) {
    const store = memoryStorage([
      [keyEntry(old.id), encodeDataKey(old)], [ACTIVE, old.id], [INDEX, index],
    ]);
    const keys = new DataKeys(store);
    await keys.loadToken(encryptValue('old', 'business.id', old));
    await keys.importKeys(bundle([incoming]));
    assert.deepEqual(new Set(JSON.parse(store.values.get(INDEX))), new Set([old.id, incoming.id]));
  }
});

test('identical imported IDs are idempotent and existing key entries are never rewritten', async () => {
  const store = memoryStorage();
  const keys = new DataKeys(store);
  const key = await keys.active();
  const before = store.writes.length;
  await keys.importKeys(bundle([key, key]));
  assert.equal((await keys.active()).id, key.id);
  assert.equal(store.writes.slice(before).filter(({ key }) => key.startsWith(`${PREFIX}key.`)).length, 0);
});

test('a conflict late in an import is rejected before any key or metadata is written', async () => {
  const store = memoryStorage();
  const original = await new DataKeys(store).active();
  const incoming = createDataKey();
  const conflicting = { ...createDataKey(), id: original.id };
  const keys = new DataKeys(store);
  const before = new Map(store.values);
  const writes = store.writes.length;
  await rejectsStatic(() => keys.importKeys(bundle([incoming, conflicting])), CONFLICT);
  assert.deepEqual(store.values, before);
  assert.equal(store.writes.length, writes);
  assert.equal(keys.lookup(incoming.id), undefined);
  assert.equal((await keys.active()).id, original.id);
});

test('conflicting duplicate IDs within an import are rejected without storage access', async () => {
  const key = createDataKey();
  const conflicting = { ...createDataKey(), id: key.id };
  const store = memoryStorage();
  await rejectsStatic(() => new DataKeys(store).importKeys(bundle([key, conflicting])), CONFLICT);
  assert.equal(store.reads.length, 0);
  assert.equal(store.writes.length, 0);
});

test('corrupt imports are completely validated and their errors never contain input or key material', async () => {
  const key = createDataKey();
  const encoded = encodeDataKey(key);
  const entry = JSON.parse(encoded);
  const invalid = [
    encoded.slice(0, -1), 'null', '[]', '{}',
    JSON.stringify({ version: 2, active: key.id, keys: [encoded] }),
    JSON.stringify({ version: 1, active: 'missing', keys: [encoded] }),
    JSON.stringify({ version: 1, active: key.id, keys: [] }),
    JSON.stringify({ version: 1, active: key.id, keys: [entry] }),
    JSON.stringify({ version: 1, active: key.id, keys: [encoded, 'private broken entry'] }),
    JSON.stringify({ version: 1, active: key.id, keys: [JSON.stringify({ ...entry, material: 'AA==' })] }),
    JSON.stringify({ version: 1, active: key.id, keys: [JSON.stringify({ ...entry, material: entry.material + '=' })] }),
  ];
  const store = memoryStorage();
  const keys = new DataKeys(store);
  for (const text of invalid) await rejectsStatic(() => keys.importKeys(text), INVALID_IMPORT);
  assert.equal(store.reads.length, 0);
  assert.equal(store.writes.length, 0);
  assert.equal(keys.lookup(key.id), undefined);
});

test('broken active pointers or stored key entries are not silently replaced', async () => {
  const key = createDataKey();
  const other = createDataKey();
  const fixtures = [
    [[ACTIVE, 'bad:id']],
    [[ACTIVE, key.id]],
    [[ACTIVE, key.id], [keyEntry(key.id), 'private broken key']],
    [[ACTIVE, key.id], [keyEntry(key.id), encodeDataKey(other)]],
  ];
  for (const initial of fixtures) {
    const store = memoryStorage(initial);
    const keys = new DataKeys(store);
    await rejectsStatic(() => keys.active(), INVALID_STORED);
    assert.deepEqual(store.values, new Map(initial));
    assert.equal(store.writes.length, 0);
    assert.equal(keys.lookup(key.id), undefined);
  }
});

test('load and import reject damaged or mismatched per-ID entries without overwriting them', async () => {
  const key = createDataKey();
  for (const damaged of ['private broken key', encodeDataKey(createDataKey())]) {
    const store = memoryStorage([[keyEntry(key.id), damaged]]);
    const keys = new DataKeys(store);
    await rejectsStatic(() => keys.loadToken(encryptValue('old', 'business.id', key)), INVALID_STORED);
    await rejectsStatic(() => keys.importKeys(bundle([key])), INVALID_STORED);
    assert.equal(store.values.get(keyEntry(key.id)), damaged);
    assert.equal(store.writes.length, 0);
    assert.equal(keys.lookup(key.id), undefined);
  }
});

test('export fails on missing or damaged indexed keys instead of returning an incomplete key file', async () => {
  for (const damaged of [undefined, 'private broken key', encodeDataKey(createDataKey())]) {
    const store = memoryStorage();
    const active = await new DataKeys(store).active();
    const old = createDataKey();
    store.values.set(INDEX, JSON.stringify([active.id, old.id]));
    if (damaged !== undefined) store.values.set(keyEntry(old.id), damaged);
    const writes = store.writes.length;
    await rejectsStatic(() => new DataKeys(store).exportKeys(), INVALID_STORED);
    assert.equal(store.writes.length, writes);
  }
});

test('active rejects failure at each write stage and never returns unsaved key material', async () => {
  for (const failAt of [1, 2, 3]) {
    const store = memoryStorage();
    let attempts = 0;
    store.beforeStore = (_key, value) => {
      if (++attempts === failAt) throw new Error(value);
    };
    const keys = new DataKeys(store);
    await rejectsStatic(() => keys.active(), WRITE_FAILED);
    for (const { key: entry, value } of store.writes.filter(({ key }) => key.startsWith(`${PREFIX}key.`))) {
      const key = decodeDataKey(value);
      if (keys.lookup(key.id)) assert.equal(store.values.get(entry), value);
      if (!store.values.has(entry)) assert.equal(keys.lookup(key.id), undefined);
    }
    const saved = new Map(store.values);
    store.beforeStore = undefined;
    const retried = await keys.active();
    assert.equal(store.values.get(keyEntry(retried.id)), encodeDataKey(retried));
    for (const [entry, value] of saved) {
      if (entry.startsWith(`${PREFIX}key.`)) assert.equal(store.values.get(entry), value);
    }
  }
});

test('all concurrent attempts reject while storage writes fail and a later retry can initialize', async () => {
  const store = memoryStorage();
  store.beforeStore = (_key, value) => { throw new Error(value); };
  const keys = new DataKeys(store);
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => keys.active()));
  assert.equal(attempts.every((result) => result.status === 'rejected' && result.reason.message === WRITE_FAILED), true);
  assert.equal(store.values.size, 0);
  for (const { value } of store.writes) assert.equal(keys.lookup(decodeDataKey(value).id), undefined);
  store.beforeStore = undefined;
  const key = await keys.active();
  assert.equal(store.values.get(keyEntry(key.id)), encodeDataKey(key));
});

test('import write failures preserve the old active key and saved keys, with retry supported', async () => {
  for (const failAt of [1, 2, 3]) {
    const store = memoryStorage();
    const keys = new DataKeys(store);
    const old = await keys.active();
    const incoming = createDataKey();
    let attempts = 0;
    store.beforeStore = (_key, value) => {
      if (++attempts === failAt) throw new Error(value);
    };
    await rejectsStatic(() => keys.importKeys(bundle([incoming])), WRITE_FAILED);
    assert.equal(store.values.get(ACTIVE), old.id);
    assert.equal(store.values.get(keyEntry(old.id)), encodeDataKey(old));
    if (keys.lookup(incoming.id)) assert.equal(store.values.get(keyEntry(incoming.id)), encodeDataKey(incoming));
    store.beforeStore = undefined;
    await keys.importKeys(bundle([incoming]));
    assert.equal((await keys.active()).id, incoming.id);
    assert.equal(decrypt(encryptValue('old', 'business.id', old), keys), 'old');
    assert.equal(exportedKeys(await keys.exportKeys()).size, 2);
  }
});

test('read failures from every async API use static errors without leaking storage exceptions', async () => {
  const key = createDataKey();
  const text = bundle([key]);
  const token = encryptValue('private-value', 'business.id', key);
  const store = memoryStorage();
  store.beforeGet = () => { throw new Error(text); };
  const keys = new DataKeys(store);
  for (const operation of [() => keys.active(), () => keys.loadToken(token), () => keys.exportKeys(), () => keys.importKeys(text)]) {
    await rejectsStatic(operation, READ_FAILED);
  }
  assert.equal(store.writes.length, 0);
  assert.equal(keys.lookup(key.id), undefined);
});

test('mutating returned key objects cannot change the cached or persisted key', async () => {
  const store = memoryStorage();
  const keys = new DataKeys(store);
  const active = await keys.active();
  const id = active.id;
  const encoded = encodeDataKey(active);
  active.material.fill(0);
  active.id = 'changed-id';
  const loaded = keys.lookup(id);
  assert.equal(encodeDataKey(loaded), encoded);
  loaded.material.fill(0);
  assert.equal(encodeDataKey(keys.lookup(id)), encoded);
  assert.equal(encodeDataKey(await keys.active()), encoded);
  assert.equal(store.values.get(keyEntry(id)), encoded);
});
