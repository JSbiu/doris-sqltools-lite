import type { ConnectionProfile, DatabaseType } from './connectionSecurity';

// Pure draft logic for the connection form. Deliberately free of the `vscode`
// import so it can be unit-tested from plain Node.

export type ConnectionFormMode = 'add' | 'edit';

export interface ConnectionDraft {
  name: string;
  type: DatabaseType;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
  clearSavedPassword: boolean;
}

export type DraftField = 'name' | 'host' | 'port' | 'username';

export interface DraftIssues {
  errors: Partial<Record<DraftField, string>>;
  warnings: string[];
}

export interface ParsedConnectionUrl {
  host?: string;
  port?: string;
  username?: string;
  password?: string;
  database?: string;
  ssl?: boolean;
}

export const DEFAULT_PORTS: Record<DatabaseType, number> = { Doris: 9030, MySQL: 3306 };

export function defaultPortFor(type: DatabaseType): number {
  return DEFAULT_PORTS[type];
}

export function emptyDraft(type: DatabaseType = 'Doris'): ConnectionDraft {
  return {
    name: '',
    type,
    host: '127.0.0.1',
    port: String(DEFAULT_PORTS[type]),
    database: '',
    username: 'root',
    password: '',
    ssl: false,
    clearSavedPassword: false,
  };
}

export function draftFromProfile(profile: ConnectionProfile): ConnectionDraft {
  return {
    name: profile.name,
    type: profile.type,
    host: profile.host,
    port: String(profile.port),
    database: profile.database ?? '',
    username: profile.username,
    // Never pre-filled: the saved password is never read back into the form.
    password: '',
    ssl: profile.ssl === true,
    clearSavedPassword: false,
  };
}

export function validateDraft(
  draft: ConnectionDraft,
  profiles: readonly ConnectionProfile[] = [],
  currentId?: string,
): DraftIssues {
  const errors: Partial<Record<DraftField, string>> = {};
  const warnings: string[] = [];

  if (!isFilled(draft.name)) {
    errors.name = '连接名称不能为空。';
  }
  if (!isFilled(draft.host)) {
    errors.host = '主机不能为空。';
  }
  if (!isFilled(draft.username)) {
    errors.username = '用户名不能为空。';
  }

  const port = Number(draft.port.trim());
  if (!isFilled(draft.port)) {
    errors.port = '端口不能为空。';
  } else if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.port = '端口必须是 1 到 65535 之间的整数。';
  }

  const name = draft.name.trim();
  const host = draft.host.trim();
  const others = profiles.filter((profile) => profile.id !== currentId);
  if (name && others.some((profile) => profile.name.toLowerCase() === name.toLowerCase())) {
    errors.name = '已有同名连接，请换一个名称。';
  }
  if (host && errors.port === undefined) {
    const clash = others.find((profile) => profile.host === host && profile.port === port);
    if (clash) {
      warnings.push(`已有连接「${clash.name}」指向同一个 ${host}:${port}。`);
    }
  }

  return { errors, warnings };
}

function isFilled(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function draftToProfile(draft: ConnectionDraft, id: string): ConnectionProfile | undefined {
  const name = draft.name.trim();
  const host = draft.host.trim();
  const username = draft.username.trim();
  const database = draft.database.trim();
  const port = Number(draft.port.trim());
  if (!name || !host || !username) {
    return undefined;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined;
  }

  const profile: ConnectionProfile = {
    id,
    name,
    type: draft.type,
    host,
    port,
    username,
    ssl: draft.ssl,
  };
  if (database) {
    profile.database = database;
  }
  return profile;
}

export function parseConnectionUrl(input: string): ParsedConnectionUrl | undefined {
  const raw = input.trim();
  if (!raw) {
    return undefined;
  }

  //jdbc: prefix must be rewritten before the scheme check, otherwise
  // `jdbc:mysql://` looks like scheme `jdbc:` with an opaque authority.
  const deJdbc = raw.replace(/^jdbc:(?:mysql|mariadb):\/\//i, 'mysql://');
  const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(deJdbc) ? deJdbc : `mysql://${deJdbc}`;

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return undefined;
  }

  const host = url.hostname;
  if (!host) {
    return undefined;
  }

  const parsed: ParsedConnectionUrl = { host };
  if (url.port) {
    parsed.port = url.port;
  }
  if (url.username) {
    parsed.username = safeDecode(url.username);
  }
  if (url.password) {
    parsed.password = safeDecode(url.password);
  }
  const database = safeDecode(url.pathname.replace(/^\/+/, '').split('/')[0] ?? '');
  if (database) {
    parsed.database = database;
  } else {
    const queryDatabase = url.searchParams.get('database');
    if (queryDatabase) {
      parsed.database = queryDatabase;
    }
  }
  if (url.searchParams.get('useSSL') === 'true' || url.searchParams.get('ssl') === 'true') {
    parsed.ssl = true;
  }
  return parsed;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// ------------------------------------------------------ mysql CLI commands

// `mysql -h HOST -P 3306 -uUSER -pPASS -D DB` is the form people copy out of
// runbooks and chat messages, so the import box accepts it next to URLs.

type TextField = 'host' | 'port' | 'username' | 'password' | 'database';

// `mysql`, `mysql.exe`, or a path to either. A leading wrapper command
// (`docker exec -it db mysql ...`) is skipped by mysqlCommand below.
const MYSQL_BINARY = /^(?:.*[\\/])?(?:mysql|mariadb)(?:\.exe)?$/i;

const LONG_OPTIONS: Record<string, TextField> = {
  host: 'host',
  port: 'port',
  user: 'username',
  password: 'password',
  database: 'database',
  schema: 'database',
};

// Short flags are case sensitive: -P is the port, -p is the password.
const SHORT_OPTIONS: Record<string, TextField> = {
  h: 'host',
  P: 'port',
  u: 'username',
  p: 'password',
  D: 'database',
};

// A bare argument is mysql's default database, but commands also carry values of
// options we ignore (sockets, -e statements). Only identifier-shaped tokens are
// taken as a database name so those never leak into the form.
const DATABASE_NAME = /^[A-Za-z0-9_$.-]+$/;

export function isMysqlCommand(raw: string): boolean {
  return mysqlCommand(raw) !== undefined;
}

export function parseMysqlCommand(raw: string): ParsedConnectionUrl | undefined {
  const command = mysqlCommand(raw);
  return command ? readMysqlOptions(command) : undefined;
}

// Accepts either a URL/JDBC string or a mysql CLI command.
export function parseConnectionInput(raw: string): ParsedConnectionUrl | undefined {
  const command = mysqlCommand(raw);
  if (command) {
    const parsed = readMysqlOptions(command);
    if (parsed) {
      return parsed;
    }
  }
  return parseConnectionUrl(raw);
}

function mysqlCommand(raw: string): { tokens: string[]; start: number } | undefined {
  const tokens = tokenizeCommand(raw);
  if (tokens.length === 0) {
    return undefined;
  }

  const binary = tokens.findIndex((token) => MYSQL_BINARY.test(token));
  if (binary >= 0) {
    return { tokens, start: binary + 1 };
  }
  // A bare option list (`-h host -u root -p...`) is accepted too.
  if (tokens[0].startsWith('-')) {
    return { tokens, start: 0 };
  }
  return undefined;
}

function readMysqlOptions(command: { tokens: string[]; start: number }): ParsedConnectionUrl | undefined {
  const { tokens, start } = command;
  const parsed: ParsedConnectionUrl = {};
  let recognized = false;

  const take = (field: TextField, value: string): void => {
    if (value.length > 0) {
      parsed[field] = value;
      recognized = true;
    }
  };

  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];

    const long = /^--([A-Za-z][A-Za-z-]*)(?:=(.*))?$/.exec(token);
    if (long) {
      const field = LONG_OPTIONS[long[1].toLowerCase()];
      if (field && long[2] !== undefined) {
        take(field, long[2]);
      } else if (field) {
        const value = optionValue(tokens, index + 1);
        if (value !== undefined) {
          take(field, value);
          index += 1;
        }
      }
      // Unknown long options are assumed to take no value, so `--batch db`
      // still leaves `db` as the positional database below.
      continue;
    }

    const short = /^-([A-Za-z])(.*)$/.exec(token);
    if (short) {
      const field = SHORT_OPTIONS[short[1]];
      if (field && short[2].length > 0) {
        take(field, short[2]);
      } else if (field) {
        const value = optionValue(tokens, index + 1);
        if (value !== undefined) {
          take(field, value);
          index += 1;
        }
      }
      continue;
    }

    if (parsed.database === undefined && DATABASE_NAME.test(token)) {
      take('database', token);
    }
  }

  return recognized ? parsed : undefined;
}

// An option value is the next token, unless it is itself a flag (`-p -h host`
// means the password was omitted, matching mysql's own behaviour).
function optionValue(tokens: string[], index: number): string | undefined {
  const value = tokens[index];
  if (value === undefined || value.startsWith('-')) {
    return undefined;
  }
  return value;
}

// Splits a shell-ish command line, honouring quotes so a password with spaces
// survives (`-p"my pass"`).
function tokenizeCommand(raw: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];

    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
        continue;
      }
      if (char === '\\' && quote === '"' && index + 1 < raw.length) {
        index += 1;
        current += raw[index];
        continue;
      }
      current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
    } else {
      current += char;
      started = true;
    }
  }

  if (started) {
    tokens.push(current);
  }
  return tokens;
}
