import mysql from 'mysql2/promise';
import { redactErrorMessage, type ConnectionProfile } from './connectionSecurity';

// The single place a MySQL/Doris socket is opened. Shared by the session
// adapter, the cancel control connection and the connection form's "测试连接",
// so the option set and the password redaction cannot drift apart.

export interface MysqlConnectOptions {
  // A missing or unreadable default database must not block a KILL, so the
  // cancel path connects without one.
  omitDatabase?: boolean;
}

export async function createMysqlConnection(
  profile: ConnectionProfile,
  password: string,
  options: MysqlConnectOptions = {},
): Promise<mysql.Connection> {
  try {
    return await mysql.createConnection({
      host: profile.host,
      port: profile.port,
      user: profile.username,
      password,
      database: options.omitDatabase ? undefined : profile.database || undefined,
      ssl: profile.ssl ? {} : undefined,
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
