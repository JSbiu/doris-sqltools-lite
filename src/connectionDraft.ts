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
