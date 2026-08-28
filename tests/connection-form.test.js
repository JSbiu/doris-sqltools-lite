const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_PORTS,
  draftFromProfile,
  draftToProfile,
  emptyDraft,
  parseConnectionUrl,
  validateDraft,
} = require('../out/connectionDraft.js');

const profile = (overrides) => ({
  id: 'doris-local',
  name: 'Local Doris',
  type: 'Doris',
  host: '127.0.0.1',
  port: 9030,
  username: 'root',
  ssl: false,
  ...overrides,
});

const draft = (overrides) => ({
  name: 'Local Doris',
  type: 'Doris',
  host: '127.0.0.1',
  port: '9030',
  database: '',
  username: 'root',
  password: '',
  ssl: false,
  clearSavedPassword: false,
  ...overrides,
});

test('rejects an empty required field', () => {
  const issues = validateDraft(draft({ name: '', host: '  ', username: '' }));
  assert.equal(issues.errors.name, '连接名称不能为空。');
  assert.equal(issues.errors.host, '主机不能为空。');
  assert.equal(issues.errors.username, '用户名不能为空。');
});

test('rejects an out-of-range or blank port', () => {
  assert.match(validateDraft(draft({ port: '' })).errors.port, /不能为空/);
  assert.match(validateDraft(draft({ port: '0' })).errors.port, /1 到 65535/);
  assert.match(validateDraft(draft({ port: '65536' })).errors.port, /1 到 65535/);
  assert.match(validateDraft(draft({ port: '90.3' })).errors.port, /1 到 65535/);
  assert.match(validateDraft(draft({ port: 'abc' })).errors.port, /1 到 65535/);
  assert.equal(validateDraft(draft({ port: '3306' })).errors.port, undefined);
});

test('rejects a duplicate name but tolerates the edited profile itself', () => {
  const existing = [profile({ id: 'a', name: 'Local Doris' })];
  assert.match(validateDraft(draft(), existing, 'b').errors.name, /已有同名连接/);

  const self = validateDraft(draft(), existing, 'a');
  assert.equal(self.errors.name, undefined);
});

test('warns about a second connection pointing at the same host and port', () => {
  const existing = [profile({ id: 'a', name: 'Primary' })];
  const issues = validateDraft(draft({ name: 'Copy' }), existing, 'b');
  assert.equal(Object.keys(issues.errors).length, 0);
  assert.deepEqual(issues.warnings, ['已有连接「Primary」指向同一个 127.0.0.1:9030。']);

  assert.deepEqual(
    validateDraft(draft({ name: 'Copy', host: '10.0.0.9' }), existing, 'b').warnings,
    [],
  );
});

test('converts a draft into a profile and drops an empty database', () => {
  assert.deepEqual(draftToProfile(draft({ database: '' }), 'new-id'), {
    id: 'new-id',
    name: 'Local Doris',
    type: 'Doris',
    host: '127.0.0.1',
    port: 9030,
    username: 'root',
    ssl: false,
  });
  assert.equal(draftToProfile(draft({ database: 'hue' }), 'new-id').database, 'hue');
});

test('refuses to convert a draft with an invalid port', () => {
  assert.equal(draftToProfile(draft({ port: '70000' }), 'id'), undefined);
  assert.equal(draftToProfile(draft({ port: '' }), 'id'), undefined);
  assert.equal(draftToProfile(draft({ name: '' }), 'id'), undefined);
});

test('starts a new draft with type-specific defaults', () => {
  assert.equal(emptyDraft().port, '9030');
  assert.equal(emptyDraft('MySQL').port, '3306');
  assert.equal(emptyDraft().password, '');
  assert.deepEqual(DEFAULT_PORTS, { Doris: 9030, MySQL: 3306 });
});

test('never pre-fills the saved password when editing', () => {
  const result = draftFromProfile(profile({ database: 'hue', ssl: true }));
  assert.equal(result.password, '');
  assert.equal(result.port, '9030');
  assert.equal(result.database, 'hue');
  assert.equal(result.ssl, true);
  assert.equal(result.clearSavedPassword, false);
});

test('parses a mysql:// connection string', () => {
  assert.deepEqual(parseConnectionUrl('mysql://root:secret@db.internal:9030/hue'), {
    host: 'db.internal',
    port: '9030',
    username: 'root',
    password: 'secret',
    database: 'hue',
  });
});

test('parses a jdbc url and its ssl flag', () => {
  assert.deepEqual(parseConnectionUrl('jdbc:mysql://10.0.0.5:3306/app?useSSL=true'), {
    host: '10.0.0.5',
    port: '3306',
    database: 'app',
    ssl: true,
  });
});

test('decodes percent-encoded credentials', () => {
  const parsed = parseConnectionUrl('mysql://root:p%40ss%2Fword@db.internal:3306');
  assert.equal(parsed.username, 'root');
  assert.equal(parsed.password, 'p@ss/word');
  assert.equal(parsed.database, undefined);
});

test('accepts a bare host:port or user@host string', () => {
  assert.deepEqual(parseConnectionUrl('127.0.0.1:9030'), { host: '127.0.0.1', port: '9030' });
  assert.deepEqual(parseConnectionUrl('root@10.0.0.1'), { host: '10.0.0.1', username: 'root' });
});

test('returns undefined for an unparseable connection string', () => {
  assert.equal(parseConnectionUrl(''), undefined);
  assert.equal(parseConnectionUrl('   '), undefined);
  assert.equal(parseConnectionUrl('mysql://'), undefined);
});
