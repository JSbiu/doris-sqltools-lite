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
  const raw = stripInvisible(input).trim();
  if (!raw) {
    return undefined;
  }

  //jdbc: prefix must be rewritten before the scheme check, otherwise
  // `jdbc:mysql://` looks like scheme `jdbc:` with an opaque authority.
  const deJdbc = raw.replace(/^jdbc:(?:mysql|mariadb):\/\//i, 'mysql://');
  const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(deJdbc) ? deJdbc : `mysql://${deJdbc}`;

  let url: URL;
  try {
    url = new URL(encodeUrlCredentials(normalized));
  } catch {
    return undefined;
  }

  const host = halfWidth(url.hostname);
  if (!host) {
    return undefined;
  }

  const parsed: ParsedConnectionUrl = { host };
  if (url.port) {
    parsed.port = halfWidth(url.port);
  }
  if (url.username) {
    parsed.username = halfWidth(safeDecode(url.username));
  }
  if (url.password) {
    parsed.password = safeDecode(url.password);
  }
  const database = halfWidth(safeDecode(url.pathname.replace(/^\/+/, '').split('/')[0] ?? ''));
  if (database) {
    parsed.database = database;
  } else {
    const queryDatabase = url.searchParams.get('database');
    if (queryDatabase) {
      parsed.database = queryDatabase;
    }
  }
  // JDBC tooling emits `?user=...&password=...` instead of userinfo, so accept
  // that form too. Real userinfo wins when both are present.
  if (!parsed.username) {
    const queryUser = url.searchParams.get('user') ?? url.searchParams.get('username');
    if (queryUser) {
      parsed.username = halfWidth(queryUser);
    }
  }
  if (!parsed.password) {
    const queryPassword = url.searchParams.get('password') ?? url.searchParams.get('pwd');
    if (queryPassword) {
      parsed.password = queryPassword;
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

// Characters that survive a copy from a web page or a chat client but are
// invisible, so nothing in the form can explain why the paste did not match.
const INVISIBLE = /[\u180E\u200B-\u200D\u2060\uFEFF]/g;

// Word and Chinese IMEs happily substitute these for the ASCII hyphen that
// every option starts with.
const DASH_LIKE = /^[\u2010-\u2015\u2212\uFF0D]/;

// Smart quotes are what you get when a command is copied out of a document.
const SMART_QUOTES: Record<string, '"' | "'" | undefined> = {
  '\u201C': '"',
  '\u201D': '"',
  '\u201E': '"',
  '\u2018': "'",
  '\u2019': "'",
  '\u201A': "'",
};

function stripInvisible(raw: string): string {
  return raw.replace(INVISIBLE, '');
}

// Full-width ASCII (U+FF01–U+FF5E) back to its half-width form. Applied to
// every field except the password, where the user's characters are sacred.
function halfWidth(value: string): string {
  return value.replace(/[\uFF01-\uFF5E]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xfee0),
  );
}

// `new URL` reads `#` and `?` as the start of the fragment or query, so a
// password like `pa#ss` silently truncates the whole string and the parse
// fails. A legal userinfo never carries `/`, `#` or `?`, so any of those
// before the last `@` can only be part of the credentials — encode them.
function encodeUrlCredentials(value: string): string {
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(value);
  if (!scheme) {
    return value;
  }
  const rest = value.slice(scheme[0].length);
  const at = rest.lastIndexOf('@');
  if (at <= 0) {
    return value;
  }
  const userinfo = rest.slice(0, at);
  if (!/[/#?]/.test(userinfo)) {
    return value;
  }
  const encoded = userinfo.replace(
    /[/#?]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return scheme[0] + encoded + rest.slice(at);
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
  const tokens = tokenizeCommand(stripInvisible(raw));
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
    let text = field === 'password' ? value : halfWidth(value);
    if (field === 'host') {
      const split = splitHostPort(text);
      if (split) {
        text = split.host;
        if (parsed.port === undefined) {
          parsed.port = halfWidth(split.port);
        }
      }
    }
    if (text.length > 0) {
      parsed[field] = text;
      recognized = true;
    }
  };

  for (let index = start; index < tokens.length; index += 1) {
    const token = normalizeOptionToken(tokens[index]);

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
  if (value === undefined || normalizeOptionToken(value).startsWith('-')) {
    return undefined;
  }
  return value;
}

// Rewrites only the marker at the head of an option word: a Unicode dash
// becomes `-`, a full-width option letter becomes its ASCII form. Values are
// never touched, so a password keeps exactly what the user typed.
function normalizeOptionToken(token: string): string {
  const dashed = DASH_LIKE.test(token) ? `-${token.slice(1)}` : token;
  if (!dashed.startsWith('-') || dashed.length < 2) {
    return dashed;
  }
  return halfWidth(dashed.slice(0, 2)) + dashed.slice(2);
}

// `-h 10.0.0.5:3306` is a common shorthand. A bracketed IPv6 host keeps its
// brackets; a bare IPv6 literal has no unambiguous split and is left alone.
function splitHostPort(value: string): { host: string; port: string } | undefined {
  const bracketed = /^\[([^\]]+)\]:(\d{1,5})$/.exec(value);
  if (bracketed) {
    return { host: bracketed[1], port: bracketed[2] };
  }
  const plain = /^([^:\s]+):(\d{1,5})$/.exec(value);
  return plain ? { host: plain[1], port: plain[2] } : undefined;
}

// Splits a shell-ish command line, honouring quotes so a password with spaces
// survives (`-p"my pass"`). Smart quotes count as quotes too — documents and
// chat clients swap `"` for `“`/`”` without telling anyone.
function tokenizeCommand(raw: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const quoteMark = char === '"' || char === "'" ? char : SMART_QUOTES[char];

    if (quote !== undefined) {
      if (quoteMark === quote) {
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

    if (quoteMark !== undefined) {
      quote = quoteMark;
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
