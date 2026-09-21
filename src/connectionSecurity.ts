export type DatabaseType = 'MySQL' | 'Doris' | 'Spark';

export function isDatabaseType(value: unknown): value is DatabaseType {
  return value === 'MySQL' || value === 'Doris' || value === 'Spark';
}

// Spark Thrift Server authenticates through HiveServer2. Its `none` (plain SASL)
// and `ldap` settings share one code path, while `nosasl` is a raw Thrift
// socket. Kerberos is deliberately absent: it needs a native module that cannot
// be shipped inside a VSIX.
export type HiveAuthMode = 'plain' | 'nosasl';

export const HIVE_AUTH_MODES: readonly HiveAuthMode[] = ['plain', 'nosasl'];

export function isHiveAuthMode(value: unknown): value is HiveAuthMode {
  return value === 'plain' || value === 'nosasl';
}

export interface ConnectionProfile {
  id: string;
  name: string;
  type: DatabaseType;
  host: string;
  port: number;
  database?: string;
  username: string;
  ssl?: boolean;
  // Only meaningful for Spark; the MySQL/Doris path ignores it.
  hiveAuth?: HiveAuthMode;
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
    // Must accept every driver type, otherwise a Spark profile is silently
    // dropped from the connection list.
    !isDatabaseType(type)
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
  // Anything else -- including a Kerberos-ish value an edited settings file
  // might carry -- is dropped rather than passed to the driver.
  if (isHiveAuthMode(value.hiveAuth)) {
    profile.hiveAuth = value.hiveAuth;
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
  // Must be listed here too, otherwise the setting round-trip silently drops the
  // chosen authentication mode. Note this whitelist is what keeps `password` out
  // of settings.json -- never widen it to a spread.
  if (profile.hiveAuth !== undefined) {
    serialized.hiveAuth = profile.hiveAuth;
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

export function redactErrorMessage(message: string, knownSecrets: readonly string[] = []): string {
  let safeMessage = message;
  for (const secret of knownSecrets) {
    if (secret) {
      safeMessage = safeMessage.split(secret).join('[redacted]');
    }
  }

  return safeMessage
    .replace(/(mysql(?:s)?:\/\/[^:\s/@]+:)[^@\s]+(@)/gi, '$1[redacted]$2')
    // A password written into the statement itself never travels through the
    // connection options, so nothing else knows its value. Covers
    // `IDENTIFIED BY 'x'`, `IDENTIFIED BY PASSWORD 'hash'`,
    // `IDENTIFIED WITH mysql_native_password BY 'x'` and the `AS 'hash'` form.
    .replace(
      /(\bIDENTIFIED\s+(?:WITH\s+[A-Za-z0-9_]+\s+)?(?:BY\s+(?:PASSWORD\s+)?|AS\s+))(?:"[^"]*"|'[^']*'|`[^`]*`|\S+)/gi,
      '$1[redacted]',
    )
    // `SET PASSWORD = 'x'` and `SET PASSWORD FOR 'u'@'h' = 'x'`.
    .replace(
      /(\bSET\s+PASSWORD\s*(?:FOR\s+(?:'[^']*'|"[^"]*"|\S+)\s*)?=\s*)(?:"[^"]*"|'[^']*'|`[^`]*`|\S+)/gi,
      '$1[redacted]',
    )
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
