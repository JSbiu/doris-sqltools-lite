import type { ConnectionProfile } from './connectionSecurity';
import { openHiveSession } from './hiveSession';
import { openMysqlSession } from './mysqlSession';
import { createRowCollector } from './queryResults';
import { neverCancelled, type QuerySession } from './querySession';

// The one place that maps a connection's declared type to a wire protocol.
// Anything above this line (the tree view, the query runner, the result panel)
// stays driver-agnostic.

export async function openQuerySession(
  profile: ConnectionProfile,
  password: string,
): Promise<QuerySession> {
  return profile.type === 'Spark'
    ? openHiveSession(profile, password)
    : openMysqlSession(profile, password);
}

// Opening a session plus one trivial statement, which is what the connection
// form's "测试连接" needs to prove. The session is always closed again so a
// failed test cannot leave a socket behind.
export async function testQuerySession(
  profile: ConnectionProfile,
  password: string,
): Promise<void> {
  const session = await openQuerySession(profile, password);
  try {
    // Only connectivity matters, so keep a single row instead of buffering.
    await session.execute('SELECT 1', neverCancelled, createRowCollector(1));
  } finally {
    await session.close();
  }
}
