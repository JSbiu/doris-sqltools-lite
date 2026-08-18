import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import {
  normalizeConnectionProfiles,
  prepareLegacyConnection,
  redactErrorMessage,
  serializeConnectionProfile,
  type ConnectionProfile,
  type DatabaseType,
} from './connectionSecurity';
import { displayValue, isExportFormat, toClipboard, toDelimited, toJson, type ExportFormat } from './exports';
import { createQueryResultView, hasMultipleStatements, type Row } from './queryResults';

class ConnectionManager {
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

  public async getPassword(profile: ConnectionProfile): Promise<string | undefined> {
    let password = await this.context.secrets.get(this.secretKey(profile.id));
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
      throw new Error(redactErrorMessage(message, [password]));
    }
  }

  private secretKey(id: string): string {
    return `${this.secretPrefix}${id}`;
  }
}

class ConnectionItem extends vscode.TreeItem {
  public readonly contextValue = 'dorisSqlLite.connection';

  public constructor(public readonly profile: ConnectionProfile) {
    super(profile.name, vscode.TreeItemCollapsibleState.None);
    this.description = `${profile.type} · ${profile.host}:${profile.port}`;
    this.tooltip = `${profile.name}\n${profile.username}@${profile.host}:${profile.port}${
      profile.database ? `/${profile.database}` : ''
    }`;
    this.iconPath = new vscode.ThemeIcon('database');
    this.command = {
      command: 'dorisSqlLite.newQuery',
      title: 'New SQL Query',
      arguments: [profile.id],
    };
  }
}

class ConnectionProvider implements vscode.TreeDataProvider<ConnectionItem> {
  private readonly changeEmitter = new vscode.EventEmitter<ConnectionItem | undefined>();
  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public constructor(private readonly manager: ConnectionManager) {}

  public refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  public getTreeItem(item: ConnectionItem): vscode.TreeItem {
    return item;
  }

  public getChildren(): ConnectionItem[] {
    return this.manager.getProfiles().map((profile) => new ConnectionItem(profile));
  }
}

class ResultPanel {
  private static readonly panels = new Set<ResultPanel>();

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly rows: Row[],
    private readonly columns: string[],
    private readonly title: string,
  ) {}

  public static open(rows: Row[], columns: string[], title: string): void {
    const panel = vscode.window.createWebviewPanel(
      'dorisSqlLiteResults',
      `Results · ${title}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    const resultPanel = new ResultPanel(panel, rows, columns, title);
    ResultPanel.panels.add(resultPanel);
    resultPanel.render();
    panel.onDidDispose(() => ResultPanel.panels.delete(resultPanel));
    panel.webview.onDidReceiveMessage(async (message: { type?: unknown; format?: unknown }) => {
      if (message.type === 'copy') {
        try {
          await resultPanel.copyToClipboard();
        } catch (error) {
          showError('复制失败', error);
        }
        return;
      }
      if (message.type === 'export' && isExportFormat(message.format)) {
        try {
          await resultPanel.export(message.format);
        } catch (error) {
          showError('导出失败', error);
        }
      }
    });
  }

  private render(): void {
    const scriptNonce = nonce();
    const shownRows = this.rows.map((row) =>
      this.columns.map((column) => escapeHtml(displayValue(row[column]))),
    );
    const header = this.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('');
    const body = shownRows
      .map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
      .join('');

    this.panel.webview.html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}';" />
  <style>
    :root { color-scheme: light dark; }
    body { padding: 12px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
    .toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
    .summary { margin-right: auto; opacity: .8; }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 5px 10px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .table-wrap { overflow: auto; max-height: calc(100vh - 80px); border: 1px solid var(--vscode-panel-border); }
    table { border-collapse: collapse; min-width: 100%; white-space: nowrap; }
    th, td { border-bottom: 1px solid var(--vscode-panel-border); border-right: 1px solid var(--vscode-panel-border); padding: 5px 8px; text-align: left; vertical-align: top; }
    th { position: sticky; top: 0; background: var(--vscode-editorGroupHeader-tabsBackground); }
    td { max-width: 560px; overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <div class="toolbar">
    <span class="summary">${this.rows.length} rows · ${this.columns.length} columns</span>
    <button data-format="csv">Export CSV</button>
    <button data-format="json">Export JSON</button>
    <button data-format="tsv">Export TSV</button>
    <button data-action="copy">Copy to Clipboard</button>
  </div>
  <div class="table-wrap"><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>
  <script nonce="${scriptNonce}">
    const api = acquireVsCodeApi();
    document.querySelector('button[data-action="copy"]')?.addEventListener('click', () => {
      api.postMessage({ type: 'copy' });
    });
    document.querySelectorAll('button[data-format]').forEach((button) => {
      button.addEventListener('click', () => api.postMessage({ type: 'export', format: button.dataset.format }));
    });
  </script>
</body>
</html>`;
  }

  private async export(format: ExportFormat): Promise<void> {
    const extension = format;
    const defaultName = `${this.title.replace(/[^a-z0-9_-]+/gi, '_')}.${extension}`;
    const defaultUri = vscode.workspace.workspaceFolders?.[0]
      ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, defaultName)
      : undefined;
    const uri = await vscode.window.showSaveDialog({
      title: `Export ${this.title}`,
      saveLabel: 'Export',
      filters: { [format.toUpperCase()]: [extension] },
      defaultUri,
    });
    if (!uri) {
      return;
    }

    const content = format === 'json'
      ? toJson(this.rows)
      : toDelimited(this.rows, this.columns, format === 'csv' ? ',' : '\t');
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    vscode.window.showInformationMessage(`已导出 ${this.rows.length} 行到 ${uri.fsPath}`);
  }

  public async copyToClipboard(): Promise<void> {
    await vscode.env.clipboard.writeText(toClipboard(this.rows, this.columns));
    vscode.window.showInformationMessage(`已复制 ${this.rows.length} 行结果到剪贴板（TSV）。`);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const manager = new ConnectionManager(context);
  const provider = new ConnectionProvider(manager);
  const documentConnections = new Map<string, string>();

  try {
    await manager.migrateLegacyPasswords();
  } catch (error) {
    showError('迁移旧连接密码失败', error);
  }

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('dorisSqlLiteExplorer', provider),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('dorisSqlLite.connections')) {
        provider.refresh();
      }
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      documentConnections.delete(document.uri.toString());
    }),
    vscode.commands.registerCommand('dorisSqlLite.addConnection', async () => {
      await addConnection(manager, provider);
    }),
    vscode.commands.registerCommand('dorisSqlLite.newQuery', async (connectionId?: string) => {
      const profile = await chooseProfile(manager, connectionId);
      if (!profile) {
        return;
      }
      const document = await vscode.workspace.openTextDocument({
        language: 'sql',
        content: `-- Doris SQL Lite connection: ${profile.id}\n\nSELECT 1;\n`,
      });
      documentConnections.set(document.uri.toString(), profile.id);
      await vscode.window.showTextDocument(document, vscode.ViewColumn.Active);
    }),
    vscode.commands.registerCommand('dorisSqlLite.runQuery', async (connectionId?: string) => {
      await runQuery(manager, documentConnections, connectionId);
    }),
    vscode.commands.registerCommand('dorisSqlLite.testConnection', async (item?: ConnectionItem) => {
      const profile = await chooseProfile(manager, item?.profile.id);
      if (!profile) {
        return;
      }
      let connection: mysql.Connection | undefined;
      try {
        connection = await manager.open(profile);
        await connection.query('SELECT 1');
        vscode.window.showInformationMessage(`连接成功：${profile.name}`);
      } catch (error) {
        showError('连接失败', error);
      } finally {
        await connection?.end().catch(() => undefined);
      }
    }),
    vscode.commands.registerCommand('dorisSqlLite.removeConnection', async (item?: ConnectionItem) => {
      if (!item) {
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        `删除连接“${item.profile.name}”？同时删除本机 SecretStorage 中保存的密码。`,
        { modal: true },
        '删除',
      );
      if (answer !== '删除') {
        return;
      }
      const profiles = manager.getProfiles().filter((profile) => profile.id !== item.profile.id);
      await manager.saveProfiles(profiles);
      await manager.deletePassword(item.profile.id);
      provider.refresh();
    }),
    vscode.commands.registerCommand('dorisSqlLite.forgetPassword', async (item?: ConnectionItem) => {
      if (!item) {
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        `清除连接“${item.profile.name}”已保存的密码？下次连接时需要重新输入。`,
        { modal: true },
        '清除密码',
      );
      if (answer !== '清除密码') {
        return;
      }
      await manager.deletePassword(item.profile.id);
      vscode.window.showInformationMessage(`已清除连接“${item.profile.name}”的已保存密码。`);
    }),
  );
}

async function addConnection(manager: ConnectionManager, provider: ConnectionProvider): Promise<void> {
  const typePick = await vscode.window.showQuickPick(['Doris', 'MySQL'], {
    title: 'Database type',
    placeHolder: 'Doris uses the MySQL protocol on port 9030',
  });
  const type = typePick as DatabaseType | undefined;
  if (!type) {
    return;
  }

  const name = await requiredInput('Connection name', type);
  if (!name) {
    return;
  }
  const host = await requiredInput('Host', '127.0.0.1');
  if (!host) {
    return;
  }
  const portText = await requiredInput('Port', type === 'Doris' ? '9030' : '3306');
  const port = portText ? Number(portText) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    vscode.window.showErrorMessage('端口必须是 1 到 65535 之间的整数。');
    return;
  }
  const database = await optionalInput('Database', type === 'Doris' ? 'doris_welove' : '');
  const username = await requiredInput('Username', 'root');
  if (!username) {
    return;
  }
  const password = await vscode.window.showInputBox({
    title: `Password for ${name}`,
    prompt: '只输入一次，密码将保存到 VS Code SecretStorage，不写入 settings.json。留空表示空密码。',
    password: true,
    ignoreFocusOut: true,
  });
  if (password === undefined) {
    return;
  }

  const profile: ConnectionProfile = {
    id: randomUUID(),
    name,
    type,
    host,
    port,
    database: database || undefined,
    username,
  };
  await manager.saveProfiles([...manager.getProfiles(), profile]);
  await manager.savePassword(profile.id, password);
  provider.refresh();
  vscode.window.showInformationMessage(`已添加连接：${name}`);
}

async function runQuery(
  manager: ConnectionManager,
  documentConnections: Map<string, string>,
  requestedConnectionId?: string,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('请先打开 SQL 文件。');
    return;
  }
  const sql = editor.selection.isEmpty
    ? editor.document.getText()
    : editor.document.getText(editor.selection);
  if (!sql.trim()) {
    vscode.window.showInformationMessage('没有可执行的 SQL。');
    return;
  }
  if (hasMultipleStatements(sql)) {
    vscode.window.showInformationMessage('当前一次只支持执行一条 SQL，请分开选择后再执行。');
    return;
  }

  const id = requestedConnectionId ?? documentConnections.get(editor.document.uri.toString());
  const profile = await chooseProfile(manager, id);
  if (!profile) {
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `执行 ${profile.name}` },
    async () => {
      let connection: mysql.Connection | undefined;
      try {
        connection = await manager.open(profile);
        const [rawResult, rawFields] = await connection.query(sql);
        const maxRows = vscode.workspace
          .getConfiguration('dorisSqlLite')
          .get<number>('maxResultRows', 1000);
        const result = createQueryResultView(rawResult, rawFields, maxRows);
        const resultRows = result.rows.length > 0 || result.columns.length > 0
          ? result.rows
          : [{ affectedRows: result.affectedRows, message: 'Statement executed.' }];
        const resultColumns = result.columns.length > 0
          ? result.columns
          : Object.keys(resultRows[0]);
        ResultPanel.open(resultRows, resultColumns, profile.name);
        if (result.truncated) {
          vscode.window.showInformationMessage(`结果已限制为 ${maxRows} 行，可在设置中调整 dorisSqlLite.maxResultRows。`);
        }
      } catch (error) {
        showError('执行失败', error);
      } finally {
        await connection?.end().catch(() => undefined);
      }
    },
  );
}

async function chooseProfile(
  manager: ConnectionManager,
  preferredId?: string,
): Promise<ConnectionProfile | undefined> {
  const profiles = manager.getProfiles();
  if (preferredId) {
    const preferred = profiles.find((profile) => profile.id === preferredId);
    if (preferred) {
      return preferred;
    }
  }
  if (profiles.length === 0) {
    vscode.window.showInformationMessage('还没有连接，请先执行 Doris SQL Lite: Add Connection。');
    return undefined;
  }
  const selected = await vscode.window.showQuickPick(
    profiles.map((profile) => ({ label: profile.name, description: `${profile.type} · ${profile.host}:${profile.port}`, profile })),
    { title: '选择数据库连接' },
  );
  return selected?.profile;
}

async function requiredInput(prompt: string, value?: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: prompt,
    value,
    ignoreFocusOut: true,
    validateInput: (input) => input.trim() ? undefined : `${prompt} 不能为空。`,
  });
}

async function optionalInput(prompt: string, value?: string): Promise<string | undefined> {
  return vscode.window.showInputBox({ title: prompt, value, ignoreFocusOut: true });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function nonce(): string {
  return randomUUID().replace(/-/g, '');
}

function getConfigurationTarget(
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

function showError(prefix: string, error: unknown): void {
  const message = redactErrorMessage(error instanceof Error ? error.message : String(error));
  vscode.window.showErrorMessage(`${prefix}：${message}`);
}

export function deactivate(): void {
  // Connections are opened per query and closed immediately, so there is no pool to dispose.
}
