const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { AES } = require('@stablelib/aes');
const { SIV } = require('@stablelib/siv');
const {
  createDataKey, encryptValue, decryptValue, isEncryptedValue, encodeDataKey, decodeDataKey,
} = require('../out/fieldEncryption.js');

const lookupFor = (key) => (id) => id === key.id ? key : undefined;
const invalidToken = /^字段密文格式无效或认证失败。$/;
const invalidKey = /^字段加密密钥格式无效。$/;
const invalidValue = /^字段值无法加密：类型、逻辑域或密钥无效。$/;

function fails(action, message, forbidden = []) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, message);
    assert.equal(error.cause, undefined);
    for (const text of forbidden) assert.equal(error.stack.includes(text), false);
    return true;
  });
}

// Deliberately generate authenticated but invalid v1 bodies to exercise the
// parser after SIV verification, rather than only testing authentication failure.
function sealBody(body, domain, key) {
  const encodedDomain = Buffer.from(domain, 'utf8');
  const cipher = new SIV(AES, key.material);
  try {
    const payload = cipher.seal([
      Buffer.from('enc:v1'), Buffer.from(key.id), encodedDomain,
    ], body);
    return `enc:v1:${key.id}:${encodedDomain.toString('base64url')}:${Buffer.from(payload).toString('base64url')}`;
  } finally {
    cipher.clean();
  }
}

function numberBody(tag, number) {
  const body = Buffer.alloc(9);
  body[0] = tag;
  body.writeDoubleBE(number, 1);
  return body;
}

function noncanonicalBase64(text, alphabet) {
  const last = alphabet.indexOf(text.at(-1));
  return text.slice(0, -1) + alphabet[last + 1];
}

test('creates independent UUID data keys with 64 random bytes for AES-256-SIV', () => {
  const first = createDataKey();
  const second = createDataKey();
  for (const key of [first, second]) {
    assert.match(key.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(key.material instanceof Uint8Array);
    assert.equal(key.material.length, 64);
  }
  assert.notEqual(first.id, second.id);
  assert.equal(Buffer.from(first.material).equals(second.material), false);
});

test('StableLib SIV matches the public RFC 5297 A.1 and A.2 vectors', () => {
  // These are PUBLIC algorithm vectors, never application/test-private keys.
  // https://www.rfc-editor.org/rfc/rfc5297.html#appendix-A
  const vectors = [
    {
      key: 'fffefdfcfbfaf9f8f7f6f5f4f3f2f1f0f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff',
      ad: ['101112131415161718191a1b1c1d1e1f2021222324252627'],
      plaintext: '112233445566778899aabbccddee',
      sealed: '85632d07c6e8f37f950acd320a2ecc9340c02b9690c4dc04daef7f6afe5c',
    },
    {
      key: '7f7e7d7c7b7a79787776757473727170404142434445464748494a4b4c4d4e4f',
      ad: [
        '00112233445566778899aabbccddeeffdeaddadadeaddadaffeeddccbbaa99887766554433221100',
        '102030405060708090a0',
        '09f911029d74e35bd84156c5635688c0',
      ],
      plaintext: '7468697320697320736f6d6520706c61696e7465787420746f20656e6372797074207573696e67205349562d414553',
      sealed: '7bdb6e3b432667eb06f4d14bff2fbd0fcb900f2fddbe404326601965c889bf17dba77ceb094fa663b7a3f748ba8af829ea64ad544a272e9c485b62a3fd5c0d',
    },
  ];
  for (const vector of vectors) {
    const cipher = new SIV(AES, Buffer.from(vector.key, 'hex'));
    try {
      const ad = vector.ad.map((hex) => Buffer.from(hex, 'hex'));
      const sealed = cipher.seal(ad, Buffer.from(vector.plaintext, 'hex'));
      assert.equal(Buffer.from(sealed).toString('hex'), vector.sealed);
      assert.equal(Buffer.from(cipher.open(ad, sealed)).toString('hex'), vector.plaintext);
    } finally {
      cipher.clean();
    }
  }
});

test('preserves null and undefined outside the ciphertext format', () => {
  const key = createDataKey();
  assert.equal(encryptValue(null, 'space', key), null);
  assert.equal(encryptValue(undefined, 'space', key), undefined);
  assert.equal(isEncryptedValue(null), false);
  assert.equal(isEncryptedValue(undefined), false);
});

test('roundtrips scalar values without losing type, text, number bits or bytes', () => {
  const key = createDataKey();
  const values = [
    '', '00000000123', '中文\n第二行\r\n\t\0🙂', 'enc:v999:ordinary-string',
    '\ud800', '\udc00', '\ufffd', '\ufeffleading BOM', 'é', 'e\u0301',
    0, -0, 1, -1, 0.1, Math.PI, Number.MIN_VALUE, -Number.MIN_VALUE,
    Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER,
    0n, 1n, -1n, 2n ** 256n, -(10n ** 1000n), false, true,
    new Date(0), new Date('2026-10-30T08:12:34.567Z'),
    new Date(-8640000000000000), new Date(8640000000000000),
    Buffer.alloc(0), Buffer.from(Array.from({ length: 256 }, (_, index) => index)),
  ];
  for (const value of values) {
    const token = encryptValue(value, 'space', key);
    assert.equal(isEncryptedValue(token), true);
    assert.equal(encryptValue(value, 'space', key), token);
    const restored = decryptValue(token, lookupFor(key), 'space');
    if (Buffer.isBuffer(value)) {
      assert.ok(Buffer.isBuffer(restored));
      assert.equal(restored.equals(value), true);
    } else if (value instanceof Date) {
      assert.ok(restored instanceof Date);
      assert.equal(restored.getTime(), value.getTime());
    } else {
      assert.equal(typeof restored, typeof value);
      assert.equal(restored, value);
    }
  }
});

test('different values and types remain distinct under the same key and domain', () => {
  const key = createDataKey();
  const values = [
    '', '0', '00', '1', 'true', 'false', '2026-10-30', '\ud800', '\udc00', '\ufffd',
    0, -0, 1, 0.1, 0n, 1n, false, true, new Date(0), new Date(1),
    Buffer.alloc(0), Buffer.from('0'), Buffer.from('1'),
  ];
  const tokens = values.map((value) => encryptValue(value, 'id', key));
  assert.equal(new Set(tokens).size, values.length);
  for (let i = 0; i < values.length; i++) {
    assert.equal(encryptValue(values[i], 'id', key), tokens[i]);
  }
});

test('uses the complete token envelope and preserves exact UTF-8 domains', () => {
  const key = createDataKey();
  const domains = ['', 'space', 'user', '业务:空/间\n\0🙂', '\ufeffspace', 'é', 'e\u0301'];
  const tokens = domains.map((domain) => encryptValue('same-id', domain, key));
  assert.equal(new Set(tokens).size, domains.length);
  for (let i = 0; i < domains.length; i++) {
    const parts = tokens[i].split(':');
    assert.deepEqual(parts.slice(0, 3), ['enc', 'v1', key.id]);
    assert.equal(parts.length, 5);
    assert.equal(Buffer.from(parts[3], 'base64url').toString('utf8'), domains[i]);
    assert.match(parts[4], /^[A-Za-z0-9_-]+$/);
    assert.equal(decryptValue(tokens[i], lookupFor(key), domains[i]), 'same-id');
    assert.equal(decryptValue(tokens[i], lookupFor(key)), 'same-id');
  }
});

test('retains full long IDs, large integers, long text and binary data', () => {
  const key = createDataKey();
  const prefix = '000' + '1234567890'.repeat(4096);
  const first = encryptValue(prefix + '1', 'space', key);
  const second = encryptValue(prefix + '2', 'space', key);
  assert.notEqual(first, second);
  assert.equal(decryptValue(first, lookupFor(key)), prefix + '1');
  assert.equal(decryptValue(second, lookupFor(key)), prefix + '2');
  assert.equal(Buffer.from(first.split(':')[4], 'base64url').length, 16 + 1 + (prefix.length + 1) * 2);
  const integer = BigInt(prefix + '9');
  assert.equal(decryptValue(encryptValue(integer, 'space', key), lookupFor(key)), integer);
  const text = '中文🙂\n'.repeat(4096);
  assert.equal(decryptValue(encryptValue(text, 'text', key), lookupFor(key)), text);
  const binary = randomBytes(64 * 1024);
  const restored = decryptValue(encryptValue(binary, 'bytes', key), lookupFor(key));
  assert.ok(Buffer.isBuffer(restored));
  assert.equal(restored.equals(binary), true);
});

test('keys, key IDs and domains each separate deterministic ciphertexts', () => {
  const key = createDataKey();
  const other = createDataKey();
  const alias = { id: randomUUID(), material: key.material };
  const token = encryptValue('00123', 'space', key);
  assert.notEqual(encryptValue('00123', 'space', other), token);
  assert.notEqual(encryptValue('00123', 'space', alias), token);
  assert.notEqual(encryptValue('00123', 'user', key), token);
  const parts = token.split(':');
  parts[2] = alias.id;
  fails(() => decryptValue(parts.join(':'), lookupFor(alias)), invalidToken);
  parts[2] = key.id;
  parts[3] = Buffer.from('user').toString('base64url');
  fails(() => decryptValue(parts.join(':'), lookupFor(key)), invalidToken);
});

test('authenticates the envelope context and version with the underlying SIV', () => {
  const key = createDataKey();
  const token = encryptValue('00123', 'space', key);
  const payload = Buffer.from(token.split(':')[4], 'base64url');
  const cipher = new SIV(AES, key.material);
  try {
    assert.ok(cipher.open([Buffer.from('enc:v1'), Buffer.from(key.id), Buffer.from('space')], payload));
    for (const context of ['enc:v2', 'enc:v01', 'v1']) {
      assert.equal(cipher.open([Buffer.from(context), Buffer.from(key.id), Buffer.from('space')], payload), null);
    }
  } finally {
    cipher.clean();
  }
});

test('recognizes every enc: prefix and explicitly refuses unsupported versions', () => {
  for (const value of ['enc:', 'enc:v2:unknown', 'enc:not-a-version']) assert.equal(isEncryptedValue(value), true);
  for (const value of ['', 'ENC:v1:', ' enc:', 'ordinary', 1, false, {}, [], Buffer.from('enc:')]) {
    assert.equal(isEncryptedValue(value), false);
  }
  const key = createDataKey();
  const token = encryptValue('value', 'space', key);
  for (const version of ['v0', 'v2', 'v01', 'V1']) {
    fails(() => decryptValue(token.replace(':v1:', `:${version}:`), () => {
      assert.fail('unsupported versions must not look up a key');
    }), /^不支持此字段密文版本。$/);
  }
});

test('rejects missing or wrong keys, mismatched lookup IDs and expected domains', () => {
  const key = createDataKey();
  const other = createDataKey();
  const token = encryptValue('00123', 'space', key);
  fails(() => decryptValue(token, () => undefined), /^找不到字段密文所需的密钥。$/);
  fails(() => decryptValue(token, () => ({ id: key.id, material: other.material })), invalidToken);
  fails(() => decryptValue(token, () => ({ id: other.id, material: key.material })), invalidToken);
  fails(() => decryptValue(token, lookupFor(key), 'user'), /^字段密文的逻辑域不匹配。$/);
  fails(() => decryptValue(token, lookupFor(key), ''), /^字段密文的逻辑域不匹配。$/);
  const emptyDomainToken = encryptValue('00123', '', key);
  fails(() => decryptValue(emptyDomainToken, lookupFor(key), 'space'), /^字段密文的逻辑域不匹配。$/);
});

test('rejects modified authentication tags, ciphertext, truncation and appended bytes', () => {
  const key = createDataKey();
  const parts = encryptValue('中文\n00123', 'space', key).split(':');
  const original = Buffer.from(parts[4], 'base64url');
  for (const index of [0, 7, 15, 16, original.length - 1]) {
    const changed = Buffer.from(original);
    changed[index] ^= 1;
    parts[4] = changed.toString('base64url');
    fails(() => decryptValue(parts.join(':'), lookupFor(key)), invalidToken);
  }
  for (const changed of [original.subarray(0, 15), original.subarray(0, -1), Buffer.concat([original, Buffer.from([0])])]) {
    parts[4] = changed.toString('base64url');
    fails(() => decryptValue(parts.join(':'), lookupFor(key)), invalidToken);
  }
});

test('rejects malformed envelopes, invalid UTF-8 and noncanonical base64url before key lookup', () => {
  const key = createDataKey();
  const parts = encryptValue('', 'space', key).split(':');
  const withPart = (index, value) => parts.map((part, i) => i === index ? value : part).join(':');
  const urlAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const malformed = [
    '', 'plain', 'ENC:' + parts.slice(1).join(':'), parts.slice(0, 4).join(':'), parts.join(':') + ':extra',
    withPart(2, ''), withPart(2, 'bad:key'), withPart(2, 'bad key'), withPart(2, key.id + '\n'),
    withPart(3, 'A'), withPart(3, '+/'), withPart(3, parts[3] + '='),
    withPart(3, Buffer.from([0xff]).toString('base64url')),
    withPart(3, noncanonicalBase64(parts[3], urlAlphabet)),
    withPart(4, ''), withPart(4, 'A'), withPart(4, '+/'), withPart(4, parts[4] + '='),
    withPart(4, parts[4] + '\n'), withPart(4, noncanonicalBase64(parts[4], urlAlphabet)),
  ];
  for (const token of malformed) {
    let lookups = 0;
    fails(() => decryptValue(token, () => { lookups++; return key; }), invalidToken);
    assert.equal(lookups, 0);
  }
});

test('valid authentication never bypasses type and body validation', () => {
  const key = createDataKey();
  const malformed = [
    Buffer.alloc(0), Buffer.from([0]), Buffer.from([255]), Buffer.from([1, 0]),
    Buffer.from([2]), Buffer.from([2, 0]), numberBody(2, NaN), numberBody(2, Infinity), numberBody(2, -Infinity),
    Buffer.from([4]), Buffer.from([4, 2]), Buffer.from([4, 0, 0]), Buffer.from([5]),
    numberBody(5, NaN), numberBody(5, Infinity), numberBody(5, 0.5), numberBody(5, -0),
    numberBody(5, 8640000000000001), numberBody(5, -8640000000000001),
    ...['', '01', '-0', '+1', '1\n', ' 1', '1.0', '1e2', '0x10', '1n', '中文'].map(
      (text) => Buffer.concat([Buffer.from([3]), Buffer.from(text)]),
    ),
  ];
  for (const body of malformed) {
    const token = sealBody(body, 'space', key);
    fails(() => decryptValue(token, lookupFor(key)), invalidToken);
  }
});

test('unsupported values fail with a static message without invoking object serialization', () => {
  const key = createDataKey();
  const sentinel = 'sensitive-value-marker';
  const object = {
    secret: sentinel,
    toString() { throw new Error(sentinel); },
    toJSON() { throw new Error(sentinel); },
  };
  const cyclic = {}; cyclic.self = cyclic;
  for (const value of [
    object, [sentinel], cyclic, new Map(), new Set(), new Uint8Array([1]), new String(sentinel),
    NaN, Infinity, -Infinity, new Date(NaN), Symbol(sentinel), () => sentinel,
  ]) {
    fails(() => encryptValue(value, 'space', key), invalidValue, [sentinel]);
  }
  for (const domain of [null, 1, {}, '\ud800', '\udc00']) {
    fails(() => encryptValue(sentinel, domain, key), invalidValue, [sentinel]);
  }
});

test('explicit key export/import uses version 1 JSON with canonical 64-byte base64 material', () => {
  const key = createDataKey();
  const exported = encodeDataKey(key);
  const record = JSON.parse(exported);
  assert.deepEqual(Object.keys(record), ['version', 'id', 'material']);
  assert.equal(record.version, 1);
  assert.equal(record.id, key.id);
  assert.equal(record.material.length, 88);
  assert.equal(record.material.endsWith('=='), true);
  const imported = decodeDataKey('\n' + JSON.stringify(record, null, 2) + '\n');
  assert.equal(imported.id, key.id);
  assert.equal(Buffer.from(imported.material).equals(key.material), true);
  const token = encryptValue('000123', 'space', key);
  assert.equal(encryptValue('000123', 'space', imported), token);
  assert.equal(decryptValue(token, lookupFor(imported)), '000123');
  imported.material[0] ^= 1;
  assert.equal(Buffer.from(imported.material).equals(key.material), false);
});

test('strictly rejects malformed, extra, unsupported and wrong-length key JSON without echoing it', () => {
  const key = createDataKey();
  const record = JSON.parse(encodeDataKey(key));
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const encoded = record.material;
  const alias = noncanonicalBase64(encoded.slice(0, -2), alphabet) + '==';
  const malformed = [
    'not-json sensitive-key-marker', '{"material":"' + encoded,
    null, undefined, {}, 'null', '[]', 'true', '1', '"string"', '{}',
    ...[
      { id: key.id, material: encoded }, { ...record, version: '1' }, { ...record, version: 2 },
      { ...record, extra: true }, { ...record, id: '' }, { ...record, id: 'bad:id' },
      { ...record, id: 'bad id' }, { ...record, id: key.id + '\n' }, { ...record, id: 1 },
      { ...record, material: null }, { ...record, material: [] }, { ...record, material: '' },
      { ...record, material: encoded.trimEnd().slice(0, -2) }, { ...record, material: encoded + '\n' },
      { ...record, material: '!' + encoded.slice(1) }, { ...record, material: alias },
      { ...record, material: randomBytes(32).toString('base64') },
      { ...record, material: randomBytes(63).toString('base64') },
      { ...record, material: randomBytes(65).toString('base64') },
    ].map((value) => JSON.stringify(value)),
  ];
  for (const text of malformed) {
    fails(() => decodeDataKey(text), invalidKey, ['sensitive-key-marker', encoded]);
  }
});

test('invalid runtime keys and lookup failures never expose values or key material', () => {
  const key = createDataKey();
  const materialText = Buffer.from(key.material).toString('base64');
  const value = 'sensitive-plaintext-marker';
  const badKeys = [
    null, undefined, {}, { ...key, id: '' }, { ...key, id: 'bad:key' }, { ...key, id: key.id + '\n' },
    { ...key, material: Array.from(key.material) }, { ...key, material: randomBytes(32) },
    { ...key, material: randomBytes(63) }, { ...key, material: randomBytes(65) },
    { get id() { throw new Error(materialText); } },
  ];
  const token = encryptValue(value, 'space', key);
  for (const bad of badKeys) {
    fails(() => encryptValue(value, 'space', bad), invalidValue, [value, materialText]);
    fails(() => encodeDataKey(bad), invalidKey, [value, materialText]);
    if (bad !== undefined) fails(() => decryptValue(token, () => bad), invalidToken, [value, materialText, token]);
  }
  fails(() => decryptValue(token, () => { throw new Error(materialText); }),
    /^无法读取字段密文所需的密钥。$/, [value, materialText, token]);
});

test('cipher cleanup preserves caller-owned keys and returned Buffer values', () => {
  const key = createDataKey();
  const originalKey = Buffer.from(key.material);
  const value = Buffer.from([0, 1, 2, 255]);
  const token = encryptValue(value, 'bytes', key);
  const first = decryptValue(token, lookupFor(key));
  const second = decryptValue(token, lookupFor(key));
  assert.equal(Buffer.from(key.material).equals(originalKey), true);
  assert.equal(first.equals(value), true);
  first[0] = 99;
  assert.equal(second.equals(value), true);
  assert.equal(encryptValue(value, 'bytes', key), token);
});

test('a fresh process restores exported keys and reproduces ciphertext without any value map', () => {
  const key = createDataKey();
  const value = '000' + '1234567890'.repeat(1024) + '中文\n';
  const token = encryptValue(value, 'space', key);
  const child = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const core = require(process.argv[1]);
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const key = core.decodeDataKey(input.key);
    const value = core.decryptValue(input.token, id => id === key.id ? key : undefined, input.domain);
    process.stdout.write(JSON.stringify({ value, sameToken: core.encryptValue(value, input.domain, key) === input.token }));
  `, path.resolve(__dirname, '../out/fieldEncryption.js')], {
    input: JSON.stringify({ key: encodeDataKey(key), token, domain: 'space' }),
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
  assert.equal(child.stderr, '');
  const restored = JSON.parse(child.stdout);
  assert.equal(restored.value === value, true);
  assert.equal(restored.sameToken, true);
});
