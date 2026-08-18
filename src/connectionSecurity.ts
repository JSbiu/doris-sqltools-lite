export type DatabaseType = 'MySQL' | 'Doris';

export interface ConnectionProfile {
  id: string;
  name: string;
  type: DatabaseType;
  host: string;
  port: number;
  database?: string;
  username: string;
  ssl?: boolean;
}

export interface SqlToolsConnection {
  name?: string;
  driver?: string;
  server?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  askForPassword?: boolean;
  mysqlOptions?: { enableSsl?: string };
}

type RecordValue = Record<string, unknown>;

export interface LegacyConnectionMigration {
  profile: ConnectionProfile;
  hadPasswordField: boolean;
  password?: string;
}

export function normalizeConnectionProfiles(value: unknown): ConnectionProfile[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => normalizeConnectionProfile(item))
    .filter((profile): profile is ConnectionProfile => profile !== undefined);
}

export function normalizeConnectionProfile(value: unknown): ConnectionProfile | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = nonEmptyString(value.id);
  const name = nonEmptyString(value.name);
  const host = nonEmptyString(value.host);
  const username = nonEmptyString(value.username);
  const port = value.port;
  const type = value.type;
  if (
    !id ||
    !name ||
    !host ||
    !username ||
    !isValidPort(port) ||
    (type !== 'MySQL' && type !== 'Doris')
  ) {
    return undefined;
  }

  const profile: ConnectionProfile = {
    id,
    name,
    type,
    host,
    port,
    username,
  };
  if (typeof value.database === 'string' && value.database.trim()) {
    profile.database = value.database;
  }
  if (typeof value.ssl === 'boolean') {
    profile.ssl = value.ssl;
  }
  return profile;
}

export function serializeConnectionProfile(profile: ConnectionProfile): ConnectionProfile {
  const serialized: ConnectionProfile = {
    id: profile.id,
    name: profile.name,
    type: profile.type,
    host: profile.host,
    port: profile.port,
    username: profile.username,
  };
  if (profile.database) {
    serialized.database = profile.database;
  }
  if (profile.ssl !== undefined) {
    serialized.ssl = profile.ssl;
  }
  return serialized;
}

export function prepareLegacyConnection(value: unknown): LegacyConnectionMigration | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const profile = normalizeConnectionProfile(value);
  if (!profile) {
    return undefined;
  }
  return {
    profile,
    hadPasswordField: Object.prototype.hasOwnProperty.call(value, 'password'),
    password: typeof value.password === 'string' ? value.password : undefined,
  };
}

export function isSupportedSqlToolsDriver(driver: unknown): boolean {
  if (typeof driver !== 'string') {
    return false;
  }
  const normalized = driver.trim().toLowerCase();
  return normalized === 'mysql' || normalized === 'mariadb' || normalized === 'tidb';
}

export function stripSupportedSqlToolsPasswords(
  connections: readonly SqlToolsConnection[],
): SqlToolsConnection[] {
  return connections.map((connection) => {
    if (!isSupportedSqlToolsDriver(connection.driver)) {
      return { ...connection };
    }
    const { password: _password, ...cleaned } = connection;
    return cleaned;
  });
}

export function redactErrorMessage(message: string, knownSecrets: readonly string[] = []): string {
  let safeMessage = message;
  for (const secret of knownSecrets) {
    if (secret) {
      safeMessage = safeMessage.split(secret).join('[redacted]');
    }
  }

  return safeMessage
    .replace(/(mysql(?:s)?:\/\/[^:\s/@]+:)[^@\s]+(@)/gi, '$1[redacted]$2')
    .replace(
      /((?:\bpassword\b|\bpasswd\b|\bpwd\b|\btoken\b|\bapi[_-]?key\b)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^,;\s]+)/gi,
      '$1[redacted]',
    );
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}
