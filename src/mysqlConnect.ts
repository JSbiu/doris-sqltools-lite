import mysql from 'mysql2/promise';
import { readFile } from 'node:fs/promises';
import { redactErrorMessage, type ConnectionProfile } from './connectionSecurity';

// The single place a MySQL/Doris socket is opened. Shared by the session
// adapter, the cancel control connection and the connection form's "测试连接",
// so the option set and the password redaction cannot drift apart.

export interface MysqlConnectOptions {
  // A missing or unreadable default database must not block a KILL, so the
  // cancel path connects without one.
  omitDatabase?: boolean;
}

export interface MysqlTlsOptions {
  rejectUnauthorized: boolean;
  verifyIdentity: boolean;
  ca?: string;
}

export function buildMysqlTlsOptions(
  profile: Pick<ConnectionProfile, 'type' | 'ssl' | 'sslVerify'>,
  ca?: string,
): MysqlTlsOptions | undefined {
  if (profile.type === 'Spark' || profile.ssl !== true) {
    return undefined;
  }
  if (profile.sslVerify === false) {
    return { rejectUnauthorized: false, verifyIdentity: false };
  }
  return {
    rejectUnauthorized: true,
    verifyIdentity: true,
    ...(ca ? { ca } : {}),
  };
}

export async function createMysqlConnection(
  profile: ConnectionProfile,
  password: string,
  options: MysqlConnectOptions = {},
): Promise<mysql.Connection> {
  try {
    const ca = profile.ssl === true && profile.sslVerify !== false && profile.sslCaFile
      ? await readFile(profile.sslCaFile, 'utf8')
      : undefined;
    return await mysql.createConnection({
      host: profile.host,
      port: profile.port,
      user: profile.username,
      password,
      database: options.omitDatabase ? undefined : profile.database || undefined,
      ssl: buildMysqlTlsOptions(profile, ca),
      connectTimeout: 10_000,
      multipleStatements: false,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The driver echoes the credentials it was given back in some failures.
    throw new Error(redactErrorMessage(message, [password]), { cause: error });
  }
}
