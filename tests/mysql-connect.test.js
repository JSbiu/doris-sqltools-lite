const assert = require('node:assert/strict');
const test = require('node:test');

const { buildMysqlTlsOptions } = require('../out/mysqlConnect.js');

test('constructs explicit verified TLS options for MySQL and Doris', () => {
  assert.deepEqual(
    buildMysqlTlsOptions({ type: 'Doris', ssl: true, sslVerify: true }, '-----BEGIN CERTIFICATE-----\nca\n'),
    {
      rejectUnauthorized: true,
      verifyIdentity: true,
      ca: '-----BEGIN CERTIFICATE-----\nca\n',
    },
  );
  assert.deepEqual(
    buildMysqlTlsOptions({ type: 'MySQL', ssl: true }),
    { rejectUnauthorized: true, verifyIdentity: true },
  );
});

test('constructs an explicit accepted-certificate mode only when requested', () => {
  assert.deepEqual(
    buildMysqlTlsOptions({ type: 'MySQL', ssl: true, sslVerify: false }, 'ignored CA'),
    { rejectUnauthorized: false, verifyIdentity: false },
  );
});

test('leaves TLS disabled for plain connections and Spark Thrift', () => {
  assert.equal(buildMysqlTlsOptions({ type: 'Doris', ssl: false, sslVerify: true }), undefined);
  assert.equal(buildMysqlTlsOptions({ type: 'Spark', ssl: true, sslVerify: true }), undefined);
});
