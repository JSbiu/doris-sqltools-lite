const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeConnectionProfile,
  prepareLegacyConnection,
  redactErrorMessage,
  serializeConnectionProfile,
} = require('../out/connectionSecurity.js');

test('normalizes connection metadata without carrying a password field', () => {
  const profile = normalizeConnectionProfile({
    id: 'doris-local',
    name: 'Local Doris',
    type: 'Doris',
    host: '127.0.0.1',
    port: 9030,
    username: 'root',
    database: 'demo',
    password: '',
    unexpected: 'discarded',
  });

  assert.deepEqual(profile, {
    id: 'doris-local',
    name: 'Local Doris',
    type: 'Doris',
    host: '127.0.0.1',
    port: 9030,
    username: 'root',
    database: 'demo',
  });
  assert.equal(normalizeConnectionProfile({ ...profile, port: 0 }), undefined);
});

test('prepares a legacy profile password for SecretStorage migration', () => {
  const migration = prepareLegacyConnection({
    id: 'mysql-local',
    name: 'Local MySQL',
    type: 'MySQL',
    host: '127.0.0.1',
    port: 3306,
    username: 'root',
    password: '',
  });

  assert.equal(migration.hadPasswordField, true);
  assert.equal(migration.password, '');
  assert.equal(Object.prototype.hasOwnProperty.call(migration.profile, 'password'), false);
});

test('serializes only supported connection metadata fields', () => {
  const serialized = serializeConnectionProfile({
    id: 'mysql-local',
    name: 'Local MySQL',
    type: 'MySQL',
    host: '127.0.0.1',
    port: 3306,
    username: 'root',
    password: '',
  });

  assert.equal(Object.prototype.hasOwnProperty.call(serialized, 'password'), false);
});

test('omits an empty database from connection metadata', () => {
  const profile = normalizeConnectionProfile({
    id: 'doris-local',
    name: 'Local Doris',
    type: 'Doris',
    host: '127.0.0.1',
    port: 9030,
    username: 'root',
    database: '   ',
  });

  assert.ok(profile);
  assert.equal(profile.database, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(serializeConnectionProfile(profile), 'database'), false);
});

test('redacts credential-shaped error text', () => {
  const safe = redactErrorMessage(
    'connect failed: password=VALUE; mysql://root:VALUE@127.0.0.1:3306/demo',
    ['VALUE'],
  );

  assert.equal(safe.includes('VALUE'), false);
  assert.match(safe, /password=\[redacted\]/);
  assert.match(safe, /mysql:\/\/root:\[redacted\]@/);
});

test('keeps an explicit ssl flag in connection metadata', () => {
  const withSsl = normalizeConnectionProfile({
    id: 'doris-ssl',
    name: 'SSL Doris',
    type: 'Doris',
    host: '127.0.0.1',
    port: 9030,
    username: 'root',
    ssl: true,
  });

  assert.ok(withSsl);
  assert.equal(withSsl.ssl, true);
  assert.equal(serializeConnectionProfile(withSsl).ssl, true);
});

test('omits ssl from metadata when it is not explicitly set', () => {
  const plain = normalizeConnectionProfile({
    id: 'mysql-plain',
    name: 'Plain MySQL',
    type: 'MySQL',
    host: '127.0.0.1',
    port: 3306,
    username: 'root',
  });

  assert.ok(plain);
  assert.equal(plain.ssl, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(serializeConnectionProfile(plain), 'ssl'), false);
});
