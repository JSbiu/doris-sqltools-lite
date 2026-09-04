import { redactErrorMessage } from './connectionSecurity';

// Pure error-diagnostics helpers: no `vscode` import, so they can be
// exercised directly by the node test runner.

export type DatabaseErrorKind =
  | 'auth'
  | 'network'
  | 'database'
  | 'permission'
  | 'ssl'
  | 'server'
  | 'sql'
  | 'interrupt'
  | 'unknown';

export interface DatabaseErrorAdvice {
  kind: DatabaseErrorKind;
  summary?: string;
  hint?: string;
}

interface DiagnosticRule {
  kind: DatabaseErrorKind;
  summary?: string;
  hint?: string;
  codes?: readonly string[];
  patterns?: readonly RegExp[];
}

const CJK_PATTERN = /[一-鿿]/;

// More specific rules first: the first match wins.
const RULES: readonly DiagnosticRule[] = [
  {
    kind: 'interrupt',
    codes: ['ER_QUERY_INTERRUPTED'],
    patterns: [/query execution was interrupted/i],
    summary: '查询已被服务端中断。',
  },
  {
    kind: 'permission',
    codes: ['ER_HOST_NOT_PRIVILEGED', 'ER_HOST_IS_BLOCKED'],
    summary: '服务端拒绝来自这台机器的连接：该账号没有授权当前来源 IP。',
    hint: '联系 DBA 给账号授权当前出口 IP，或改用跳板机。',
  },
  {
    kind: 'auth',
    codes: ['ER_ACCESS_DENIED_ERROR', 'ER_ACCESS_DENIED_NO_PASSWORD_ERROR'],
    patterns: [/access denied for user/i],
    summary: '用户名或密码错误。',
    hint: '执行 Doris SQL Lite: Forget Saved Password 清除已保存的密码后重新输入。',
  },
  {
    kind: 'server',
    codes: ['ER_NOT_SUPPORTED_AUTH_MODE'],
    patterns: [/authentication plugin/i, /caching_sha2|sha256_password/i, /client does not support authentication/i],
    summary: '服务端使用了本客户端不支持的认证方式（如 caching_sha2_password）。',
    hint: '让 DBA 把账号改回 mysql_native_password，或升级扩展依赖的数据库驱动。',
  },
  {
    kind: 'database',
    codes: ['ER_BAD_DB_ERROR'],
    patterns: [/unknown database/i],
    summary: 'database 不存在，或当前账号看不到它。',
    hint: '检查连接配置里的 database 拼写，或留空后手动执行 USE。',
  },
  {
    kind: 'database',
    codes: ['ER_NO_DB_ERROR'],
    patterns: [/no database selected/i],
    summary: '没有选中 database。',
    hint: '在连接配置里填 database，或先执行 USE。',
  },
  {
    kind: 'permission',
    codes: ['ER_DBACCESS_DENIED_ERROR', 'ER_TABLEACCESS_DENIED_ERROR', 'ER_COLUMNACCESS_DENIED_ERROR'],
    summary: '当前账号没有访问该对象的权限。',
    hint: '联系 DBA 授权，或换一个有权限的账号。',
  },
  {
    kind: 'network',
    codes: ['ECONNREFUSED'],
    summary: '连接被拒绝：主机能连通，但端口上没有服务在监听。',
    hint: '确认端口（Doris 默认 9030，MySQL 默认 3306）和服务是否已启动。',
  },
  {
    kind: 'network',
    codes: ['ETIMEDOUT'],
    summary: '连接超时：10 秒内没能连上。',
    hint: '确认主机地址与端口，检查防火墙或安全组是否放行。',
  },
  {
    kind: 'network',
    codes: ['EHOSTUNREACH', 'ENETUNREACH'],
    summary: '主机不可达。',
    hint: '确认主机地址是否正确，以及本机到该主机的路由是否通畅。',
  },
  {
    kind: 'network',
    codes: ['ENOTFOUND', 'EAI_AGAIN'],
    summary: '主机名无法解析。',
    hint: '检查主机地址拼写，或改用 IP。',
  },
  {
    kind: 'network',
    codes: ['ECONNRESET', 'EPIPE'],
    summary: '连接被对端重置。',
    hint: '可能是服务端踢掉了空闲连接或网络抖动，重跑一次即可。',
  },
  {
    kind: 'network',
    codes: [
      'PROTOCOL_CONNECTION_LOST',
      'PROTOCOL_ENQUEUE_AFTER_QUIT',
      'PROTOCOL_ENQUEUE_AFTER_DESTROY',
      'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
      'PROTOCOL_SEQUENCE_TIMEOUT',
    ],
    summary: '连接在执行过程中断开。',
    hint: '重跑一次即可；频繁出现可检查服务端的 wait_timeout。',
  },
  {
    kind: 'ssl',
    patterns: [/ssl connection error/i],
    summary: 'SSL 握手失败。',
    hint: '服务端可能未启用 SSL：在连接配置里取消勾选 SSL 后重试。本扩展启用 SSL 后不校验证书链。',
  },
  {
    kind: 'server',
    codes: ['ER_CON_COUNT_ERROR'],
    patterns: [/too many connections/i],
    summary: '服务端连接数已满。',
    hint: '稍后重试，或让 DBA 清理空闲连接。',
  },
  {
    kind: 'sql',
    codes: ['ER_PARSE_ERROR'],
    summary: 'SQL 语法错误。',
    hint: '检查分号、引号与括号是否配对。',
  },
  {
    kind: 'sql',
    codes: ['ER_NO_SUCH_TABLE', 'ER_UNKNOWN_TABLE'],
    patterns: [/table .* doesn't exist/i, /unknown table/i],
    summary: '表不存在。',
    hint: '确认 database 是否选对，可先执行 SELECT DATABASE()。',
  },
  {
    kind: 'sql',
    codes: ['ER_BAD_FIELD_ERROR'],
    patterns: [/unknown column/i],
    summary: '列不存在。',
    hint: '确认表结构与列名，注意大小写。',
  },
  {
    kind: 'sql',
    patterns: [/errCode\s*=/i],
    summary: 'Doris 返回错误。',
    hint: '看 detailMessage 里的具体原因。',
  },
];

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code ? code : undefined;
}

function rawErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function classifyDatabaseError(error: unknown): DatabaseErrorAdvice {
  const code = errorCode(error);
  const message = rawErrorMessage(error);

  for (const rule of RULES) {
    if (code && rule.codes?.includes(code)) {
      return { kind: rule.kind, summary: rule.summary, hint: rule.hint };
    }
    if (rule.patterns?.some((pattern) => pattern.test(message))) {
      return { kind: rule.kind, summary: rule.summary, hint: rule.hint };
    }
  }

  // Node TLS failures surface as code like ERR_SSL_WRONG_VERSION_NUMBER.
  if (code && /SSL|TLS|CERT/i.test(code)) {
    return {
      kind: 'ssl',
      summary: 'SSL 握手失败。',
      hint: '服务端可能未启用 SSL：在连接配置里取消勾选 SSL 后重试。本扩展启用 SSL 后不校验证书链。',
    };
  }

  return { kind: 'unknown' };
}

export function isAuthFailure(error: unknown): boolean {
  return classifyDatabaseError(error).kind === 'auth';
}

// Renders a human-readable, secret-safe message for the VS Code UI. Messages
// that already contain CJK text are assumed to be authored by us and returned
// untouched.
export function formatDatabaseError(error: unknown, extraSecrets: readonly string[] = []): string {
  const safe = redactErrorMessage(rawErrorMessage(error), extraSecrets);
  if (CJK_PATTERN.test(safe)) {
    return safe;
  }

  const advice = classifyDatabaseError(error);
  const parts: string[] = [];
  if (advice.summary) {
    parts.push(advice.summary);
  }
  parts.push(safe);
  if (advice.hint) {
    parts.push(`建议：${advice.hint}`);
  }

  const text = parts.join(' ');
  const code = errorCode(error);
  return code && !safe.includes(code) ? `${text}（${code}）` : text;
}
