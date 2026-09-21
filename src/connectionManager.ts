import * as vscode from 'vscode';
import {
  classifyDatabaseError,
  formatDatabaseError,
} from './connectionDiagnostics';
import {
  normalizeConnectionProfiles,
  prepareLegacyConnection,
  serializeConnectionProfile,
  type ConnectionProfile,
} from './connectionSecurity';
import type { QuerySession } from './querySession';
import { openQuerySession } from './sessionFactory';

// Shared connection-domain helpers. Kept in its own module so that
// extension.ts and connectionForm.ts can both use it without a cycle.

export class ConnectionManager {
  private readonly secretPrefix = 'dorisSqlLite.password.';

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public getProfiles(): ConnectionProfile[] {
    const raw = vscode.workspace
      .getConfiguration('dorisSqlLite')
      .get<unknown>('connections', []);

    return normalizeConnectionProfiles(raw);
  }

  // Connection metadata lives in user settings (`scope: machine` in
  // package.json). Writing it into a project's `.vscode/settings.json` would
  // leak internal host names and account names into whatever repository
  // happened to be open, so the target is always Global.
  public async saveProfiles(profiles: ConnectionProfile[]): Promise<void> {
    await vscode.workspace
      .getConfiguration('dorisSqlLite')
      .update(
        'connections',
        profiles.map((profile) => serializeConnectionProfile(profile)),
        vscode.ConfigurationTarget.Global,
      );
  }

  public async migrateLegacyPasswords(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('dorisSqlLite');
    const raw = configuration.get<unknown>('connections', []);
    if (!Array.isArray(raw)) {
      return;
    }

    let changed = false;
    const cleaned: unknown[] = [];
    for (const item of raw) {
      const migration = prepareLegacyConnection(item);
      if (!migration || !migration.hadPasswordField) {
        cleaned.push(item);
        continue;
      }

      if (migration.password !== undefined) {
        const existing = await this.context.secrets.get(this.secretKey(migration.profile.id));
        if (existing === undefined) {
          await this.savePassword(migration.profile.id, migration.password);
        }
      }
      cleaned.push(serializeConnectionProfile(migration.profile));
      changed = true;
    }

    if (changed) {
      await configuration.update(
        'connections',
        cleaned,
        vscode.ConfigurationTarget.Global,
      );
    }
  }

  // Connection metadata is user-scoped (`scope: machine` in package.json). An
  // older build could have written it into a workspace or folder settings file
  // instead. VS Code neither applies those values nor lets a machine-scoped
  // setting be written at those scopes (not even deleted -- it rejects the
  // update outright), so the only thing possible here is to rescue entries the
  // user would otherwise stop seeing. The stale key stays behind in the project
  // file, where the settings editor flags it; README tells the user to remove
  // it. Runs before migrateLegacyPasswords so passwords are lifted too.
  public async migrateConnectionScope(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('dorisSqlLite');
    const inspected = configuration.inspect<unknown>('connections');
    if (!inspected) {
      return;
    }

    const stranded = [
      ...normalizeConnectionProfiles(inspected.workspaceFolderValue),
      ...normalizeConnectionProfiles(inspected.workspaceValue),
    ];
    if (stranded.length === 0) {
      return;
    }

    // User settings are what actually applies now, so they win; the narrower
    // scopes only get to add ids that would otherwise disappear.
    const merged = normalizeConnectionProfiles(inspected.globalValue);
    const seen = new Set(merged.map((profile) => profile.id));
    for (const profile of stranded) {
      if (seen.has(profile.id)) {
        continue;
      }
      seen.add(profile.id);
      merged.push(profile);
    }

    await configuration.update(
      'connections',
      merged.map((profile) => serializeConnectionProfile(profile)),
      vscode.ConfigurationTarget.Global,
    );
  }

  public async savePassword(id: string, password: string): Promise<void> {
    await this.context.secrets.store(this.secretKey(id), password);
  }

  public async deletePassword(id: string): Promise<void> {
    await this.context.secrets.delete(this.secretKey(id));
  }

  // Reads without ever prompting, so callers can tell "no password stored"
  // apart from "empty password stored".
  public async readPassword(id: string): Promise<string | undefined> {
    return this.context.secrets.get(this.secretKey(id));
  }

  // Opens a session, asking for the password only when nothing is stored. A
  // wrong stored password is dropped and re-asked once, and a typed password is
  // only persisted after the handshake actually succeeded. Which wire protocol
  // is used is the session factory's business, not this class's.
  public async open(profile: ConnectionProfile): Promise<QuerySession> {
    const stored = await this.readPassword(profile.id);
    if (stored !== undefined) {
      try {
        return await openQuerySession(profile, stored);
      } catch (error) {
        if (classifyDatabaseError(error).kind !== 'auth') {
          throw error;
        }
        await this.deletePassword(profile.id);
        vscode.window.showWarningMessage(
          `连接“${profile.name}”已保存的密码认证失败，已清除，请重新输入密码。`,
        );
      }
    }

    return this.promptAndOpen(profile);
  }

  private async promptAndOpen(profile: ConnectionProfile): Promise<QuerySession> {
    const password = await vscode.window.showInputBox({
      title: `Password for ${profile.name}`,
      prompt:
        '首次连接请输入密码；连接成功后才会保存到 VS Code SecretStorage，密码输错不会被记住。留空表示空密码。',
      password: true,
      ignoreFocusOut: true,
    });

    if (password === undefined) {
      throw new Error('已取消密码输入。');
    }

    // Connect first, persist second: a rejected password must never be stored.
    const session = await openQuerySession(profile, password);
    try {
      await this.savePassword(profile.id, password);
    } catch (error) {
      await session.close();
      throw error;
    }
    return session;
  }

  // Both the raw connection options and the cancel control connection now live
  // in the driver adapters (mysqlConnect.ts / mysqlSession.ts); the manager only
  // deals in passwords and profiles.

  private secretKey(id: string): string {
    return `${this.secretPrefix}${id}`;
  }
}

export function sameConnectionTarget(a: ConnectionProfile, b: ConnectionProfile): boolean {
  return (
    a.type === b.type &&
    a.host === b.host &&
    a.port === b.port &&
    a.username === b.username &&
    (a.database ?? '') === (b.database ?? '') &&
    (a.ssl ?? false) === (b.ssl ?? false)
  );
}

export function showError(prefix: string, error: unknown): void {
  vscode.window.showErrorMessage(`${prefix}：${formatDatabaseError(error)}`);
}
