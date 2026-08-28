import * as vscode from 'vscode';
import mysql from 'mysql2/promise';
import {
  normalizeConnectionProfiles,
  prepareLegacyConnection,
  redactErrorMessage,
  serializeConnectionProfile,
  type ConnectionProfile,
} from './connectionSecurity';

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

  public async saveProfiles(profiles: ConnectionProfile[]): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('dorisSqlLite');
    await configuration.update(
      'connections',
      profiles.map((profile) => serializeConnectionProfile(profile)),
      getConfigurationTarget(configuration, 'connections'),
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
        getConfigurationTarget(configuration, 'connections'),
      );
    }
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

  public async getPassword(profile: ConnectionProfile): Promise<string | undefined> {
    let password = await this.readPassword(profile.id);
    if (password !== undefined) {
      return password;
    }

    password = await vscode.window.showInputBox({
      title: `Password for ${profile.name}`,
      prompt: '首次连接请输入密码；密码只会保存到 VS Code SecretStorage。留空表示空密码。',
      password: true,
      ignoreFocusOut: true,
    });

    if (password === undefined) {
      return undefined;
    }

    await this.savePassword(profile.id, password);
    return password;
  }

  public async open(profile: ConnectionProfile): Promise<mysql.Connection> {
    const password = await this.getPassword(profile);
    if (password === undefined) {
      throw new Error('已取消密码输入。');
    }

    return this.connect(profile, password);
  }

  // Used by the connection form's "test connection" button: never prompts,
  // never persists.
  public async connect(profile: ConnectionProfile, password: string): Promise<mysql.Connection> {
    try {
      return await mysql.createConnection({
        host: profile.host,
        port: profile.port,
        user: profile.username,
        password,
        database: profile.database || undefined,
        ssl: profile.ssl ? {} : undefined,
        connectTimeout: 10_000,
        multipleStatements: false,
        dateStrings: true,
        supportBigNumbers: true,
        bigNumberStrings: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(redactErrorMessage(message, [password]), { cause: error });
    }
  }

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

export function getConfigurationTarget(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
): vscode.ConfigurationTarget {
  const inspected = configuration.inspect<unknown>(key);
  if (inspected?.workspaceFolderValue !== undefined) {
    return vscode.ConfigurationTarget.WorkspaceFolder;
  }
  if (inspected?.workspaceValue !== undefined) {
    return vscode.ConfigurationTarget.Workspace;
  }
  if (inspected?.globalValue !== undefined) {
    return vscode.ConfigurationTarget.Global;
  }
  return vscode.workspace.workspaceFolders
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

export function showError(prefix: string, error: unknown): void {
  const message = redactErrorMessage(error instanceof Error ? error.message : String(error));
  vscode.window.showErrorMessage(`${prefix}：${message}`);
}
