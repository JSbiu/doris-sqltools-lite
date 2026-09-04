const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifyDatabaseError,
  formatDatabaseError,
  isAuthFailure,
} = require('../out/connectionDiagnostics.js');

const errorWithCode = (code, message) => Object.assign(new Error(message), { code });

test('密码错误归类为 auth，可据此清除已保存的密码', () => {
  const error = errorWithCode(
    'ER_ACCESS_DENIED_ERROR',
    "Access denied for user 'root'@'10.0.0.5' (using password: YES)",
  );

  assert.equal(classifyDatabaseError(error).kind, 'auth');
  assert.equal(isAuthFailure(error), true);
});

test('只有消息没有 code 时也能识别 access denied', () => {
  const error = new Error("Access denied for user 'root'@'localhost'");

  assert.equal(classifyDatabaseError(error).kind, 'auth');
});

test('认证插件不支持归为 server，不会误清密码', () => {
  const error = errorWithCode(
    'ER_NOT_SUPPORTED_AUTH_MODE',
    'Client does not support authentication protocol requested by server',
  );

  assert.equal(classifyDatabaseError(error).kind, 'server');
  assert.equal(isAuthFailure(error), false);
});

test('来源 IP 未授权归为 permission，不会误清密码', () => {
  const error = errorWithCode('ER_HOST_NOT_PRIVILEGED', "Host '10.0.0.5' is not allowed to connect");

  assert.equal(classifyDatabaseError(error).kind, 'permission');
  assert.equal(isAuthFailure(error), false);
});

test('网络类错误按 code 给出不同说明', () => {
  const cases = [
    ['ECONNREFUSED', 'network', /端口/],
    ['ETIMEDOUT', 'network', /超时/],
    ['ENOTFOUND', 'network', /解析/],
    ['EHOSTUNREACH', 'network', /不可达/],
    ['ECONNRESET', 'network', /重置/],
    ['PROTOCOL_CONNECTION_LOST', 'network', /断开/],
  ];

  for (const [code, kind, pattern] of cases) {
    const advice = classifyDatabaseError(errorWithCode(code, `boom ${code}`));
    assert.equal(advice.kind, kind, `${code} 应归为 ${kind}`);
    assert.match(advice.summary, pattern, `${code} 的中文说明应命中 ${pattern}`);
  }
});

test('database 与表的问题分开归类', () => {
  assert.equal(
    classifyDatabaseError(errorWithCode('ER_BAD_DB_ERROR', "Unknown database 'hue'")).kind,
    'database',
  );
  assert.equal(
    classifyDatabaseError(new Error('No database selected')).kind,
    'database',
  );
  assert.equal(
    classifyDatabaseError(errorWithCode('ER_NO_SUCH_TABLE', "Table 'hue.t' doesn't exist")).kind,
    'sql',
  );
});

test('Doris 的 errCode 报错归为 sql', () => {
  const error = new Error(
    'errCode = 2, detailMessage = Key columns should be a ordered prefix of the schema',
  );

  assert.equal(classifyDatabaseError(error).kind, 'sql');
  assert.match(classifyDatabaseError(error).hint, /detailMessage/);
});

test('TLS 握手失败归为 ssl', () => {
  const error = errorWithCode('ERR_SSL_WRONG_VERSION_NUMBER', 'wrong version number');

  assert.equal(classifyDatabaseError(error).kind, 'ssl');
});

test('查询被中断归为 interrupt', () => {
  const error = errorWithCode('ER_QUERY_INTERRUPTED', 'Query execution was interrupted');

  assert.equal(classifyDatabaseError(error).kind, 'interrupt');
});

test('未收录的错误保持 unknown 且不带中文说明', () => {
  const advice = classifyDatabaseError(new Error('something else entirely'));

  assert.equal(advice.kind, 'unknown');
  assert.equal(advice.summary, undefined);
  assert.equal(advice.hint, undefined);
});

test('格式化的错误信息包含中文说明、原始信息与建议', () => {
  const error = errorWithCode(
    'ER_ACCESS_DENIED_ERROR',
    "Access denied for user 'root'@'10.0.0.5' (using password: YES)",
  );

  const text = formatDatabaseError(error);

  assert.match(text, /^用户名或密码错误。/);
  assert.match(text, /Access denied for user/);
  assert.match(text, /建议：/);
  assert.match(text, /（ER_ACCESS_DENIED_ERROR）$/);
});

test('消息里已有的 code 不重复追加', () => {
  const text = formatDatabaseError(errorWithCode('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:9030'));

  assert.equal(text.match(/ECONNREFUSED/g).length, 1);
});

test('格式化时脱敏密码', () => {
  const error = new Error("connect failed with password: super-secret for user root");

  const text = formatDatabaseError(error, ['super-secret']);

  assert.doesNotMatch(text, /super-secret/);
  assert.match(text, /\[redacted\]/);
});

test('我们自己抛出的中文错误原样返回', () => {
  assert.equal(formatDatabaseError(new Error('已取消密码输入。')), '已取消密码输入。');
});

test('认证失败的建议里指向 Forget Saved Password', () => {
  const advice = classifyDatabaseError(errorWithCode('ER_ACCESS_DENIED_ERROR', 'Access denied'));

  assert.match(advice.hint, /Forget Saved Password/);
});
