const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_PORTS,
  draftFromProfile,
  draftToProfile,
  emptyDraft,
  isMysqlCommand,
  parseConnectionInput,
  parseConnectionUrl,
  parseMysqlCommand,
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

test('parses a mysql command line with separated values', () => {
  assert.deepEqual(parseMysqlCommand('mysql -h xxx -P 3306 -uxxx -pxxx -D xxx'), {
    host: 'xxx',
    port: '3306',
    username: 'xxx',
    password: 'xxx',
    database: 'xxx',
  });
});

test('parses a mysql command line with attached values', () => {
  assert.deepEqual(parseMysqlCommand('mysql -hdb.internal -P3306 -uroot -psecret -Dhue'), {
    host: 'db.internal',
    port: '3306',
    username: 'root',
    password: 'secret',
    database: 'hue',
  });
});

test('parses long options in both =value and spaced forms', () => {
  assert.deepEqual(
    parseMysqlCommand('mysql --host=10.0.0.5 --port=3306 --user=root --password=p@ss --database=app'),
    { host: '10.0.0.5', port: '3306', username: 'root', password: 'p@ss', database: 'app' },
  );
  assert.deepEqual(
    parseMysqlCommand('mysql --host 10.0.0.5 --password "spaced pass" --schema app'),
    { host: '10.0.0.5', password: 'spaced pass', database: 'app' },
  );
});

test('keeps a quoted password intact and honours an attached quote', () => {
  assert.equal(parseMysqlCommand('mysql -u root -p"my pass" -D db').password, 'my pass');
  assert.equal(parseMysqlCommand("mysql -u root --password='my pass'").password, 'my pass');
});

test('leaves the password out when -p carries no value', () => {
  const prompted = parseMysqlCommand('mysql -h host -u root -p');
  assert.equal(prompted.host, 'host');
  assert.equal(prompted.username, 'root');
  assert.equal('password' in prompted, false);

  // `-p -h host` matches mysql: the password was omitted, -h is a flag again.
  const reordered = parseMysqlCommand('mysql -p -h host -u root');
  assert.equal(reordered.host, 'host');
  assert.equal('password' in reordered, false);
});

test('takes a bare argument as the default database', () => {
  assert.equal(parseMysqlCommand('mysql -h host -u root hue').database, 'hue');
});

test('ignores options it does not know without stealing their neighbours', () => {
  const parsed = parseMysqlCommand('mysql --batch -h host -u root db1');
  assert.equal(parsed.host, 'host');
  assert.equal(parsed.username, 'root');
  assert.equal(parsed.database, 'db1');

  // A socket path must never be mistaken for a database name.
  const socket = parseMysqlCommand('mysql -h host -S /tmp/mysql.sock -u root');
  assert.equal(socket.host, 'host');
  assert.equal(socket.username, 'root');
  assert.equal('database' in socket, false);
});

test('accepts a bare option list and a wrapped command', () => {
  assert.deepEqual(parseMysqlCommand('-h host -P 3306 -u root'), {
    host: 'host',
    port: '3306',
    username: 'root',
  });
  assert.equal(parseMysqlCommand('docker exec -it db1 mysql -h host -u root -px').host, 'host');
  assert.equal(parseMysqlCommand('mysql.exe -h host -u root').host, 'host');
});

test('returns undefined when a mysql command carries nothing usable', () => {
  assert.equal(parseMysqlCommand('mysql'), undefined);
  assert.equal(parseMysqlCommand('mysql -x'), undefined);
  assert.equal(parseMysqlCommand(''), undefined);
});

test('recognises mysql commands without swallowing urls or host:port', () => {
  assert.equal(isMysqlCommand('  mysql -h host -u root  '), true);
  assert.equal(isMysqlCommand('-h host'), true);
  assert.equal(isMysqlCommand('mysql://root:secret@db.internal:9030/hue'), false);
  assert.equal(isMysqlCommand('127.0.0.1:9030'), false);
  assert.equal(isMysqlCommand('jdbc:mysql://10.0.0.5:3306/app'), false);
});

test('parseConnectionInput dispatches between urls and mysql commands', () => {
  assert.deepEqual(parseConnectionInput('mysql -h host -P 3306 -u root -psecret -D hue'), {
    host: 'host',
    port: '3306',
    username: 'root',
    password: 'secret',
    database: 'hue',
  });
  assert.deepEqual(parseConnectionInput('mysql://root:secret@db.internal:9030/hue'), {
    host: 'db.internal',
    port: '9030',
    username: 'root',
    password: 'secret',
    database: 'hue',
  });
  assert.deepEqual(parseConnectionInput('127.0.0.1:9030'), { host: '127.0.0.1', port: '9030' });
  assert.equal(parseConnectionInput(''), undefined);
});

test('strips invisible characters that survive a web copy', () => {
  // Zero-width space, joiner and a stray BOM all render as nothing, so the
  // form could never explain why the paste did not match.
  assert.deepEqual(parseConnectionInput('mysql -h 10.0.0.5 -u\u200Broot -psecret -D dw'), {
    host: '10.0.0.5',
    username: 'root',
    password: 'secret',
    database: 'dw',
  });
  assert.equal(parseMysqlCommand('my\u200Bsql -h host -u root').host, 'host');
  assert.equal(parseConnectionInput('mysql -h host\u200D -u root').host, 'host');
  assert.equal(parseConnectionInput('\uFEFFmysql -h host -u root').host, 'host');
});

test('accepts smart quotes, unicode dashes and full-width option letters', () => {
  assert.deepEqual(parseMysqlCommand('mysql -h 10.0.0.5 -uroot -p\u201Cmy pass\u201D -D dw'), {
    host: '10.0.0.5',
    username: 'root',
    password: 'my pass',
    database: 'dw',
  });

  // en dash and full-width hyphen-minus, as substituted by Word and IMEs
  assert.deepEqual(parseMysqlCommand('mysql \u2013h 10.0.0.5 \u2013P 3306 \u2013uroot'), {
    host: '10.0.0.5',
    port: '3306',
    username: 'root',
  });
  assert.deepEqual(parseMysqlCommand('mysql \uFF0Dh host \uFF0DP 3306'), {
    host: 'host',
    port: '3306',
  });

  // A full-width option letter: `-ｕroot`.
  assert.equal(parseMysqlCommand('mysql -h host -\uFF55root').username, 'root');
});

test('converts full-width values but never the password', () => {
  const parsed = parseMysqlCommand(
    'mysql -h 10.0.0.5 -P \uFF13\uFF13\uFF10\uFF16 -u\uFF52oot -p\uFF21\uFF22\uFF23',
  );
  assert.equal(parsed.port, '3306');
  assert.equal(parsed.username, 'root');
  // The password is deliberately left untouched: what the user typed is what
  // gets sent, even when it looks like a full-width character.
  assert.equal(parsed.password, '\uFF21\uFF22\uFF23');
});

test('splits a port smuggled into the host field', () => {
  assert.deepEqual(parseMysqlCommand('mysql -h 10.0.0.5:3306 -uroot -psecret'), {
    host: '10.0.0.5',
    port: '3306',
    username: 'root',
    password: 'secret',
  });

  // IPv6 keeps its brackets, so the split stays unambiguous.
  const v6 = parseMysqlCommand('mysql -h [::1]:9030 -uroot');
  assert.equal(v6.host, '::1');
  assert.equal(v6.port, '9030');

  // A bare IPv6 literal has no unambiguous split and is left whole.
  const bare = parseMysqlCommand('mysql -h ::1 -uroot');
  assert.equal(bare.host, '::1');
  assert.equal('port' in bare, false);

  // An explicit -P wins over the one embedded in the host.
  assert.equal(parseMysqlCommand('mysql -h 10.0.0.5:3306 -P 9030 -uroot').port, '9030');
});

test('keeps url credentials that contain url syntax', () => {
  const host = '10.0.0.5:3306/dw';
  assert.equal(parseConnectionUrl(`mysql://root:pa#ss@${host}`).password, 'pa#ss');
  assert.equal(parseConnectionUrl(`mysql://root:pa/ss@${host}`).password, 'pa/ss');
  assert.equal(parseConnectionUrl(`mysql://root:pa?ss@${host}`).password, 'pa?ss');

  // Without userinfo the fragment and query keep their normal meaning.
  assert.deepEqual(parseConnectionUrl('jdbc:mysql://10.0.0.5:3306/app?useSSL=true'), {
    host: '10.0.0.5',
    port: '3306',
    database: 'app',
    ssl: true,
  });
});

test('reads jdbc user and password query parameters', () => {
  assert.deepEqual(
    parseConnectionUrl('jdbc:mysql://10.0.0.5:3306/app?user=root&password=p%40ss&useSSL=true'),
    {
      host: '10.0.0.5',
      port: '3306',
      username: 'root',
      password: 'p@ss',
      database: 'app',
      ssl: true,
    },
  );

  // Real userinfo still wins when both forms are present.
  assert.equal(parseConnectionUrl('mysql://alice:pw@10.0.0.5:3306/app?user=bob').username, 'alice');
});
