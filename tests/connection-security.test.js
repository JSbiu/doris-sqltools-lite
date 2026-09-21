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

test('redacts a password carried inside the SQL itself', () => {
  const safe = redactErrorMessage("CREATE USER 'app'@'%' IDENTIFIED BY 'hunter2' failed");

  assert.equal(safe.includes('hunter2'), false);
  assert.match(safe, /IDENTIFIED BY \[redacted\]/);
});

test('redacts every password clause MySQL accepts in a statement', () => {
  const cases = [
    {
      message: "ALTER USER 'app'@'%' IDENTIFIED WITH mysql_native_password BY 'hunter2'",
      secret: 'hunter2',
      expected: /IDENTIFIED WITH mysql_native_password BY \[redacted\]/,
    },
    {
      message: "ALTER USER 'app'@'%' IDENTIFIED BY PASSWORD '*A4B6157319038724E3560894F7F932C8886EBFCF'",
      secret: 'A4B6157319038724E3560894F7F932C8886EBFCF',
      expected: /IDENTIFIED BY PASSWORD \[redacted\]/,
    },
    {
      message: "ALTER USER 'app'@'%' IDENTIFIED WITH sha256_password AS '$5$rounds=5000$salt$hash'",
      secret: '$5$rounds=5000$salt$hash',
      expected: /IDENTIFIED WITH sha256_password AS \[redacted\]/,
    },
    {
      message: "SET PASSWORD FOR 'app'@'%' = 'hunter2'",
      secret: 'hunter2',
      expected: /SET PASSWORD FOR 'app'@'%' = \[redacted\]/,
    },
    {
      message: "SET PASSWORD = 'hunter2'",
      secret: 'hunter2',
      expected: /SET PASSWORD = \[redacted\]/,
    },
  ];

  for (const { message, secret, expected } of cases) {
    const safe = redactErrorMessage(message);
    assert.equal(safe.includes(secret), false, message);
    assert.match(safe, expected);
  }
});

test('leaves an ordinary SQL error readable', () => {
  const message = 'You have an error in your SQL syntax near SELECT at line 1';

  assert.equal(redactErrorMessage(message), message);
});
