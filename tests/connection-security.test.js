const assert = require('node:assert/strict');
const test = require('node:test');

const {
  connectionProfileKey,
  normalizeConnectionProfile,
  prepareLegacyConnection,
  redactErrorMessage,
  serializeConnectionProfile,
  stripSupportedSqlToolsPasswords,
} = require('../out/connectionSecurity.js');

test('builds a stable identity for repeated connection imports', () => {
  const base = {
    id: 'one',
    name: 'Local MySQL',
    type: 'MySQL',
    host: '127.0.0.1',
    port: 3306,
    username: 'root',
  };

  assert.equal(connectionProfileKey(base), connectionProfileKey({ ...base, id: 'two' }));
  assert.notEqual(connectionProfileKey(base), connectionProfileKey({ ...base, name: 'Another name' }));
});

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

test('only strips passwords from supported SQLTools drivers', () => {
  const cleaned = stripSupportedSqlToolsPasswords([
    { driver: 'mysql', name: 'MySQL', password: '' },
    { driver: 'postgresql', name: 'PostgreSQL', password: '' },
  ]);

  assert.equal(Object.prototype.hasOwnProperty.call(cleaned[0], 'password'), false);
  assert.equal(cleaned[1].password, '');
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

test('redacts credential-shaped error text', () => {
  const safe = redactErrorMessage(
    'connect failed: password=VALUE; mysql://root:VALUE@127.0.0.1:3306/demo',
    ['VALUE'],
  );

  assert.equal(safe.includes('VALUE'), false);
  assert.match(safe, /password=\[redacted\]/);
  assert.match(safe, /mysql:\/\/root:\[redacted\]@/);
});
