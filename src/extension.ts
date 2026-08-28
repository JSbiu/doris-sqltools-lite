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
import { displayValue, isExportFormat, toTsv, type ExportFormat } from './exports';
import {
  createQueryResultView,
  findSqlStatementAtOffset,
  hasMultipleStatements,
  type QueryResultView,
  type Row,
} from './queryResults';

type ConnectionSessionState = {
  documentConnections: Map<string, string>;
  liveConnections: Map<string, LiveDocumentConnection>;
  runningDocuments: Set<string>;
  defaultConnectionId?: string;
};

type LiveDocumentConnection = {
  profileId: string;
  connection: mysql.Connection;
};

let activeConnectionSession: ConnectionSessionState | undefined;

interface ResultPanelMetadata {
  connectionName: string;
  database?: string;
  durationMs: number;
  maxRows: number;
}

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
      throw new Error(redactErrorMessage(message, [password]), { cause: error });
    }
  }

  private secretKey(id: string): string {
    return `${this.secretPrefix}${id}`;
  }
}

async function closeDocumentConnection(
  session: ConnectionSessionState,
  documentKey: string,
): Promise<void> {
  const active = session.liveConnections.get(documentKey);
  if (!active) {
    return;
  }

  session.liveConnections.delete(documentKey);
  await active.connection.end().catch(() => undefined);
}

async function closeConnectionsForProfile(
  session: ConnectionSessionState,
  profileId: string,
): Promise<void> {
  const documentKeys = [...session.liveConnections.entries()]
    .filter(([, active]) => active.profileId === profileId)
    .map(([documentKey]) => documentKey);
  await Promise.all(documentKeys.map((documentKey) => closeDocumentConnection(session, documentKey)));
}

async function closeAllDocumentConnections(session: ConnectionSessionState): Promise<void> {
  await Promise.all(
    [...session.liveConnections.keys()].map((documentKey) =>
      closeDocumentConnection(session, documentKey),
    ),
  );
}

function isConnectionFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && [
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENOTFOUND',
    'EPIPE',
    'ETIMEDOUT',
    'PROTOCOL_CONNECTION_LOST',
    'PROTOCOL_ENQUEUE_AFTER_QUIT',
    'PROTOCOL_ENQUEUE_AFTER_DESTROY',
    'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
    'PROTOCOL_SEQUENCE_TIMEOUT',
  ].includes(code);
}

class ConnectionItem extends vscode.TreeItem {
  public readonly contextValue = 'dorisSqlLite.connection';

  public constructor(public readonly profile: ConnectionProfile) {
    super(profile.name, vscode.TreeItemCollapsibleState.None);
    this.description = `${profile.type} · ${profile.host}:${profile.port}${
      profile.ssl ? ' · SSL' : ''
    }`;
    this.tooltip = `${profile.name}\n${profile.username}@${profile.host}:${profile.port}${
      profile.database ? `/${profile.database}` : ''
    }${profile.ssl ? '\nSSL (TLS) 已启用' : '\n未启用 SSL'}`;
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
  private static current: ResultPanel | undefined;
  private result: QueryResultView = { rows: [], columns: [], affectedRows: 0, truncated: false };
  private metadata: ResultPanelMetadata = {
    connectionName: '',
    durationMs: 0,
    maxRows: 1000,
  };

  private constructor(private readonly panel: vscode.WebviewPanel) {}

  public static open(result: QueryResultView, metadata: ResultPanelMetadata): void {
    if (ResultPanel.current) {
      ResultPanel.current.update(result, metadata);
      ResultPanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'dorisSqlLiteResults',
      `Results · ${metadata.connectionName}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    const resultPanel = new ResultPanel(panel);
    ResultPanel.current = resultPanel;
    resultPanel.update(result, metadata);
    panel.onDidDispose(() => {
      if (ResultPanel.current === resultPanel) {
        ResultPanel.current = undefined;
      }
    });
    panel.webview.onDidReceiveMessage(async (message: { type?: unknown; format?: unknown }) => {
      if (message.type === 'copy') {
        try {
          await resultPanel.copyToClipboard();
          await panel.webview.postMessage({ type: 'actionComplete', action: 'copy' });
        } catch (error) {
          showError('复制失败', error);
          await panel.webview.postMessage({ type: 'actionFailed', action: 'copy' });
        }
        return;
      }
      if (message.type === 'export' && isExportFormat(message.format)) {
        try {
          const exported = await resultPanel.export(message.format);
          await panel.webview.postMessage({ type: exported ? 'actionComplete' : 'actionCancelled', action: 'export' });
        } catch (error) {
          showError('导出失败', error);
          await panel.webview.postMessage({ type: 'actionFailed', action: 'export' });
        }
      }
    });
  }

  private update(result: QueryResultView, metadata: ResultPanelMetadata): void {
    this.result = result;
    this.metadata = metadata;
    this.panel.title = `Results · ${metadata.connectionName}`;
    this.render();
  }

  private get rows(): Row[] {
    return this.result.rows;
  }

  private get columns(): string[] {
    return this.result.columns;
  }

  private get title(): string {
    return this.metadata.connectionName;
  }

  private render(): void {
    const scriptNonce = nonce();
    const shownRows = this.rows.map((row) =>
      this.columns.map((column) => {
        const value = row[column];
        return value === null || value === undefined
          ? '<span class="null-value">NULL</span>'
          : escapeHtml(displayValue(value));
      }),
    );
    const header = [
      '<th class="row-number" aria-label="Row number">#</th>',
      ...this.columns.map((column) => `<th>${escapeHtml(column)}</th>`),
    ].join('');
    const body = shownRows
      .map((cells, index) => `<tr data-row><td class="row-number">${index + 1}</td>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
      .join('');
    const hasTable = this.columns.length > 0;
    const databaseLabel = this.metadata.database
      ? `<span class="meta">${escapeHtml(this.metadata.database)}</span>`
      : '';
    const truncatedNotice = this.result.truncated
      ? `<div class="notice">仅显示前 ${this.metadata.maxRows} 行；导出和复制也基于当前显示结果。</div>`
      : '';
    const resultContent = hasTable
      ? `<div class="table-wrap"><table><thead><tr>${header}</tr></thead><tbody>${body || `<tr class="empty-row"><td colspan="${this.columns.length + 1}">查询成功，未返回数据</td></tr>`}</tbody></table></div>`
      : `<section class="success-state"><span class="success-icon">✓</span><div><strong>执行成功</strong><p>${this.result.affectedRows} 行受到影响 · ${formatDuration(this.metadata.durationMs)}</p></div></section>`;

    this.panel.webview.html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}';" />
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 16px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 12px; }
    .summary { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-right: auto; }
    .summary strong { font-size: 14px; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .connection { padding: 2px 7px; border: 1px solid var(--vscode-panel-border); border-radius: 999px; }
    .filter { min-width: 180px; width: min(260px, 35vw); color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 6px 8px; outline: none; }
    .filter:focus { border-color: var(--vscode-focusBorder); }
    button { min-height: 28px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 1px solid transparent; border-radius: 2px; padding: 5px 11px; cursor: pointer; }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button:disabled { cursor: default; opacity: .65; }
    .notice { margin-bottom: 10px; padding: 8px 10px; color: var(--vscode-editorWarning-foreground); background: var(--vscode-inputValidation-warningBackground); border-left: 3px solid var(--vscode-editorWarning-foreground); }
    .table-wrap { overflow: auto; max-height: calc(100vh - 92px); border: 1px solid var(--vscode-panel-border); }
    table { border-collapse: separate; border-spacing: 0; min-width: 100%; white-space: nowrap; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
    th, td { border-bottom: 1px solid var(--vscode-panel-border); border-right: 1px solid var(--vscode-panel-border); padding: 6px 9px; text-align: left; vertical-align: top; }
    th { position: sticky; top: 0; z-index: 2; color: var(--vscode-foreground); background: var(--vscode-editorGroupHeader-tabsBackground); font-family: var(--vscode-font-family); font-weight: 600; }
    tbody tr:nth-child(even) { background: var(--vscode-list-hoverBackground); }
    tbody tr:hover { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    td { max-width: 560px; overflow: hidden; text-overflow: ellipsis; }
    .row-number { position: sticky; left: 0; z-index: 1; width: 1%; color: var(--vscode-descriptionForeground); background: var(--vscode-editorGroupHeader-tabsBackground); text-align: right; user-select: none; }
    th.row-number { z-index: 3; }
    .null-value { color: var(--vscode-descriptionForeground); font-style: italic; }
    .empty-row td { padding: 28px; color: var(--vscode-descriptionForeground); text-align: center; }
    .success-state { display: flex; align-items: center; gap: 12px; padding: 24px; border: 1px solid var(--vscode-panel-border); }
    .success-state p { margin: 4px 0 0; color: var(--vscode-descriptionForeground); }
    .success-icon { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; color: var(--vscode-button-foreground); background: var(--vscode-testing-iconPassed); font-weight: 700; }
  </style>
</head>
<body>
  <div class="toolbar">
    <span class="summary">
      <strong><span id="visible-count">${this.rows.length}</span> 行</strong>
      <span class="meta">${this.columns.length} 列</span>
      <span class="meta connection">${escapeHtml(this.metadata.connectionName)}</span>
      ${databaseLabel}
      <span class="meta">${formatDuration(this.metadata.durationMs)}</span>
    </span>
    ${hasTable ? `
      <input id="result-filter" class="filter" type="search" placeholder="筛选当前结果…" aria-label="筛选当前结果" title="仅筛选显示，不改变复制和导出内容" />
      <button class="secondary" data-format="tsv" data-default-label="导出 TSV">导出 TSV</button>
      <button data-action="copy" data-default-label="复制 TSV">复制 TSV</button>
    ` : ''}
  </div>
  ${truncatedNotice}
  ${resultContent}
  <script nonce="${scriptNonce}">
    const api = acquireVsCodeApi();
    const copyButton = document.querySelector('button[data-action="copy"]');
    const exportButton = document.querySelector('button[data-format="tsv"]');
    const setPending = (button, label) => {
      if (!button) return;
      button.disabled = true;
      button.textContent = label;
    };
    copyButton?.addEventListener('click', () => {
      setPending(copyButton, '正在复制…');
      api.postMessage({ type: 'copy' });
    });
    exportButton?.addEventListener('click', () => {
      setPending(exportButton, '正在导出…');
      api.postMessage({ type: 'export', format: exportButton.dataset.format });
    });
    const filter = document.getElementById('result-filter');
    const rows = [...document.querySelectorAll('tbody tr[data-row]')];
    filter?.addEventListener('input', () => {
      const query = filter.value.trim().toLocaleLowerCase();
      let visible = 0;
      rows.forEach((row) => {
        const matches = !query || (row.textContent?.toLocaleLowerCase().includes(query) ?? false);
        row.hidden = !matches;
        if (matches) visible += 1;
      });
      document.getElementById('visible-count').textContent = String(visible);
    });
    window.addEventListener('message', ({ data }) => {
      const button = data.action === 'copy' ? copyButton : exportButton;
      if (!button) return;
      const completed = data.type === 'actionComplete';
      button.textContent = completed ? (data.action === 'copy' ? '已复制' : '已导出') : button.dataset.defaultLabel;
      window.setTimeout(() => {
        button.disabled = false;
        button.textContent = button.dataset.defaultLabel;
      }, completed ? 1200 : 0);
    });
  </script>
</body>
</html>`;
  }

  private async export(format: ExportFormat): Promise<boolean> {
    const extension = format;
    const title = this.title;
    const rows = this.rows;
    const columns = this.columns;
    const content = toTsv(rows, columns);
    const safeTitle = title.replace(/[^a-z0-9_-]+/gi, '_') || 'query';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const defaultName = `query_${safeTitle}_${timestamp}.${extension}`;
    const defaultUri = vscode.workspace.workspaceFolders?.[0]
      ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, defaultName)
      : undefined;
    const uri = await vscode.window.showSaveDialog({
      title: `导出 ${title} 查询结果`,
      saveLabel: '导出',
      filters: { [format.toUpperCase()]: [extension] },
      defaultUri,
    });
    if (!uri) {
      return false;
    }

    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    vscode.window.showInformationMessage(`已导出 ${rows.length} 行到 ${uri.fsPath}`);
    return true;
  }

  public async copyToClipboard(): Promise<void> {
    await vscode.env.clipboard.writeText(toTsv(this.rows, this.columns));
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const manager = new ConnectionManager(context);
  const provider = new ConnectionProvider(manager);
  // Kept only for the current extension host session; never persisted to settings.
  const connectionSession: ConnectionSessionState = {
    documentConnections: new Map(),
    liveConnections: new Map(),
    runningDocuments: new Set(),
  };
  activeConnectionSession = connectionSession;
  const connectionStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  connectionStatus.name = 'Doris SQL Lite Connection';
  connectionStatus.command = 'dorisSqlLite.setConnection';
  const refreshConnectionStatus = (): void => updateConnectionStatus(connectionStatus, manager, connectionSession);
  refreshConnectionStatus();

  try {
    await manager.migrateLegacyPasswords();
  } catch (error) {
    showError('迁移旧连接密码失败', error);
  }

  context.subscriptions.push(
    connectionStatus,
    vscode.window.registerTreeDataProvider('dorisSqlLiteExplorer', provider),
    vscode.window.onDidChangeActiveTextEditor(refreshConnectionStatus),
    vscode.workspace.onDidCloseTextDocument((document) => {
      void closeDocumentConnection(connectionSession, document.uri.toString());
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('dorisSqlLite.connections')) {
        provider.refresh();
        refreshConnectionStatus();
      }
    }),
    vscode.commands.registerCommand('dorisSqlLite.addConnection', async () => {
      try {
        await addConnection(manager, provider);
      } catch (error) {
        showError('添加连接失败', error);
      }
    }),
    vscode.commands.registerCommand('dorisSqlLite.newQuery', async (commandArgument?: unknown) => {
      const connectionId = normalizeCommandConnectionId(commandArgument);
      const profile = await chooseProfile(manager, connectionId ?? connectionSession.defaultConnectionId);
      if (!profile) {
        return;
      }
      connectionSession.defaultConnectionId = profile.id;
      const document = await vscode.workspace.openTextDocument({
        language: 'sql',
        content: `-- Doris SQL Lite · ${profile.name.replace(/[\r\n]+/g, ' ')}\n\nSELECT 1;\n`,
      });
      connectionSession.documentConnections.set(document.uri.toString(), profile.id);
      await vscode.window.showTextDocument(document, vscode.ViewColumn.Active);
      refreshConnectionStatus();
    }),
    vscode.commands.registerCommand('dorisSqlLite.setConnection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'sql') {
        vscode.window.showInformationMessage('请先打开 SQL 文件。');
        return;
      }
      const profile = await chooseProfile(manager);
      if (!profile) {
        return;
      }
      const documentKey = editor.document.uri.toString();
      const active = connectionSession.liveConnections.get(documentKey);
      if (active && active.profileId !== profile.id) {
        await closeDocumentConnection(connectionSession, documentKey);
      }
      connectionSession.documentConnections.set(documentKey, profile.id);
      connectionSession.defaultConnectionId = profile.id;
      refreshConnectionStatus();
      vscode.window.showInformationMessage(`已为当前文件指定连接：${profile.name}`);
    }),
    vscode.commands.registerCommand('dorisSqlLite.editConnection', async (item?: ConnectionItem) => {
      try {
        await editConnection(manager, provider, connectionSession, item);
        refreshConnectionStatus();
      } catch (error) {
        showError('修改连接失败', error);
      }
    }),
    vscode.commands.registerCommand('dorisSqlLite.runQuery', async (commandArgument?: unknown) => {
      await runQuery(manager, connectionSession, normalizeCommandConnectionId(commandArgument), refreshConnectionStatus);
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
        showError(`连接失败（${profile.name}）`, error);
      } finally {
        await connection?.end().catch(() => undefined);
      }
    }),
    vscode.commands.registerCommand('dorisSqlLite.removeConnection', async (item?: ConnectionItem) => {
      const profile = await chooseProfile(manager, item?.profile.id);
      if (!profile) {
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        `删除连接“${profile.name}”？同时删除本机 SecretStorage 中保存的密码。`,
        { modal: true },
        '删除',
      );
      if (answer !== '删除') {
        return;
      }
      await closeConnectionsForProfile(connectionSession, profile.id);
      const profiles = manager.getProfiles().filter((candidate) => candidate.id !== profile.id);
      await manager.saveProfiles(profiles);
      await manager.deletePassword(profile.id);
      for (const [document, connectionId] of connectionSession.documentConnections) {
        if (connectionId === profile.id) {
          connectionSession.documentConnections.delete(document);
        }
      }
      if (connectionSession.defaultConnectionId === profile.id) {
        connectionSession.defaultConnectionId = undefined;
      }
      provider.refresh();
      refreshConnectionStatus();
      vscode.window.showInformationMessage(`已删除连接“${profile.name}”。`);
    }),
    vscode.commands.registerCommand('dorisSqlLite.forgetPassword', async (item?: ConnectionItem) => {
      const profile = await chooseProfile(manager, item?.profile.id);
      if (!profile) {
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        `清除连接“${profile.name}”已保存的密码？下次连接时需要重新输入。`,
        { modal: true },
        '清除密码',
      );
      if (answer !== '清除密码') {
        return;
      }
      await manager.deletePassword(profile.id);
      vscode.window.showInformationMessage(`已清除连接“${profile.name}”的已保存密码。`);
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
  const database = await optionalInput('Database（可留空）', '');
  if (database === undefined) {
    return;
  }
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
  const sslPick = await vscode.window.showQuickPick(
    [
      { label: '不使用 SSL', description: '适用于内网或不要求加密的环境' },
      { label: '使用 SSL (TLS)', description: '加密客户端与服务器之间的连接' },
    ],
    { title: `SSL for ${name}`, placeHolder: '生产环境通常建议启用' },
  );
  if (!sslPick) {
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
    ssl: sslPick.label.startsWith('使用'),
  };
  await manager.saveProfiles([...manager.getProfiles(), profile]);
  await manager.savePassword(profile.id, password);
  provider.refresh();
  vscode.window.showInformationMessage(`已添加连接：${name}`);
}

async function editConnection(
  manager: ConnectionManager,
  provider: ConnectionProvider,
  connectionSession: ConnectionSessionState,
  item?: ConnectionItem,
): Promise<void> {
  const current = item?.profile ?? await chooseProfile(manager);
  if (!current) {
    return;
  }

  const typePick = await vscode.window.showQuickPick(['Doris', 'MySQL'], {
    title: `Database type for ${current.name}`,
    placeHolder: `当前：${current.type}`,
  });
  const type = typePick as DatabaseType | undefined;
  if (!type) {
    return;
  }

  const name = await requiredInput('Connection name', current.name);
  if (!name) {
    return;
  }
  const host = await requiredInput('Host', current.host);
  if (!host) {
    return;
  }
  const portText = await requiredInput('Port', String(current.port));
  const port = portText ? Number(portText) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    vscode.window.showErrorMessage('端口必须是 1 到 65535 之间的整数。');
    return;
  }
  const database = await optionalInput('Database', current.database ?? '');
  if (database === undefined) {
    return;
  }
  const username = await requiredInput('Username', current.username);
  if (!username) {
    return;
  }

  const passwordAction = await vscode.window.showQuickPick(
    ['Keep current password', 'Change password'],
    {
      title: `Password for ${name}`,
      placeHolder: '选择是否更新已保存的密码',
    },
  );
  if (!passwordAction) {
    return;
  }

  let newPassword: string | undefined;
  if (passwordAction === 'Change password') {
    newPassword = await vscode.window.showInputBox({
      title: `New password for ${name}`,
      prompt: '输入新密码；密码只会保存到 VS Code SecretStorage，不写入 settings.json。留空表示空密码。',
      password: true,
      ignoreFocusOut: true,
    });
    if (newPassword === undefined) {
      return;
    }
  }

  const sslPick = await vscode.window.showQuickPick(
    [
      { label: '不使用 SSL', description: '适用于内网或不要求加密的环境', picked: current.ssl !== true },
      { label: '使用 SSL (TLS)', description: '加密客户端与服务器之间的连接', picked: current.ssl === true },
    ],
    { title: `SSL for ${name}`, placeHolder: `当前：${current.ssl ? '使用 SSL' : '不使用 SSL'}` },
  );
  if (!sslPick) {
    return;
  }

  const updated: ConnectionProfile = {
    id: current.id,
    name,
    type,
    host,
    port,
    database: database || undefined,
    username,
    ssl: sslPick.label.startsWith('使用'),
  };
  const profiles = manager.getProfiles().map((profile) =>
    profile.id === current.id ? updated : profile,
  );
  await manager.saveProfiles(profiles);
  try {
    if (newPassword !== undefined) {
      await manager.savePassword(current.id, newPassword);
    }
  } finally {
    await closeConnectionsForProfile(connectionSession, current.id);
  }
  provider.refresh();
  vscode.window.showInformationMessage(`已更新连接：${name}`);
}

async function runQuery(
  manager: ConnectionManager,
  connectionSession: ConnectionSessionState,
  requestedConnectionId?: string,
  onConnectionChanged?: () => void,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'sql') {
    vscode.window.showInformationMessage('请先打开 SQL 文件。');
    return;
  }
  const sql = editor.selection.isEmpty
    ? findSqlStatementAtOffset(
      editor.document.getText(),
      editor.document.offsetAt(editor.selection.active),
    )
    : editor.document.getText(editor.selection);
  if (!sql?.trim()) {
    vscode.window.showInformationMessage('没有可执行的 SQL。');
    return;
  }
  if (!editor.selection.isEmpty && hasMultipleStatements(sql)) {
    vscode.window.showInformationMessage('当前一次只支持执行一条 SQL，请分开选择后再执行。');
    return;
  }

  const documentKey = editor.document.uri.toString();
  if (connectionSession.runningDocuments.has(documentKey)) {
    vscode.window.showInformationMessage('当前 SQL 文件已有查询正在执行；可先从进度通知中取消。');
    return;
  }
  const id = requestedConnectionId
    ?? connectionSession.documentConnections.get(documentKey)
    ?? connectionSession.defaultConnectionId;
  const profile = await chooseProfile(manager, id);
  if (!profile) {
    return;
  }
  const active = connectionSession.liveConnections.get(documentKey);
  if (active && active.profileId !== profile.id) {
    await closeDocumentConnection(connectionSession, documentKey);
  }
  connectionSession.documentConnections.set(documentKey, profile.id);
  connectionSession.defaultConnectionId = profile.id;
  onConnectionChanged?.();

  connectionSession.runningDocuments.add(documentKey);
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `执行 ${profile.name}`,
        cancellable: true,
      },
      async (progress, token) => {
        const startedAt = Date.now();
        let connection: mysql.Connection | undefined =
          connectionSession.liveConnections.get(documentKey)?.connection;
        let connectionInvalid = false;
        let cancelled = false;
        const cancellation = token.onCancellationRequested(() => {
          cancelled = true;
          connectionInvalid = true;
          connection?.destroy();
        });
        try {
          if (!connection) {
            progress.report({ message: '正在建立连接…' });
            connection = await manager.open(profile);
            if (token.isCancellationRequested) {
              connectionInvalid = true;
              connection.destroy();
              return;
            }
            connectionSession.liveConnections.set(documentKey, {
              profileId: profile.id,
              connection,
            });
          } else {
            progress.report({ message: '复用当前文件连接…' });
          }
          if (token.isCancellationRequested) {
            connectionInvalid = true;
            connection.destroy();
            return;
          }
          progress.report({ message: '正在执行…' });
          const [rawResult, rawFields] = await connection.query(sql);
          if (token.isCancellationRequested) {
            connectionInvalid = true;
            return;
          }
          const maxRows = vscode.workspace
            .getConfiguration('dorisSqlLite')
            .get<number>('maxResultRows', 1000);
          const result = createQueryResultView(rawResult, rawFields, maxRows);
          ResultPanel.open(result, {
            connectionName: profile.name,
            database: profile.database,
            durationMs: Date.now() - startedAt,
            maxRows,
          });
        } catch (error) {
          if (cancelled || token.isCancellationRequested) {
            connectionInvalid = true;
            vscode.window.showInformationMessage(`已取消 ${profile.name} 上的查询。`);
          } else {
            connectionInvalid = isConnectionFailure(error);
            showError(`执行失败（${profile.name}）`, error);
          }
        } finally {
          cancellation.dispose();
          if (connectionInvalid && connection) {
            const activeConnection = connectionSession.liveConnections.get(documentKey);
            if (activeConnection?.connection === connection) {
              connectionSession.liveConnections.delete(documentKey);
            }
            await connection.end().catch(() => undefined);
          }
        }
      },
    );
  } finally {
    connectionSession.runningDocuments.delete(documentKey);
  }
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
    profiles.map((profile) => ({
      label: profile.name,
      description: `${profile.type} · ${profile.host}:${profile.port}`,
      detail: `${profile.username}${profile.database ? ` · ${profile.database}` : ' · 未指定 database'}${profile.ssl ? ' · SSL' : ''}`,
      profile,
    })),
    { title: '选择数据库连接' },
  );
  return selected?.profile;
}

function updateConnectionStatus(
  status: vscode.StatusBarItem,
  manager: ConnectionManager,
  connectionSession: ConnectionSessionState,
): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'sql') {
    status.hide();
    return;
  }

  const documentConnectionId = connectionSession.documentConnections.get(editor.document.uri.toString());
  const connectionId = documentConnectionId ?? connectionSession.defaultConnectionId;
  const profile = manager.getProfiles().find((candidate) => candidate.id === connectionId);
  if (!profile) {
    status.text = '$(database) 选择连接';
    status.tooltip = 'Doris SQL Lite：点击为当前 SQL 文件选择连接';
    status.show();
    return;
  }

  const source = documentConnectionId ? '当前文件连接' : '本次会话默认连接';
  const database = profile.database ? `/${profile.database}` : '';
  status.text = `$(database) ${profile.name.replace(/\$\(/g, '$ (')}`;
  status.tooltip = `${source}：${profile.name}\n${profile.username}@${profile.host}:${profile.port}${database}\n点击切换连接`;
  status.show();
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${Math.max(0, durationMs)} ms`;
  }
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 2 : 1)} s`;
}

async function requiredInput(prompt: string, value?: string): Promise<string | undefined> {
  const result = await vscode.window.showInputBox({
    title: prompt,
    value,
    ignoreFocusOut: true,
    validateInput: (input) => input.trim() ? undefined : `${prompt} 不能为空。`,
  });
  return result?.trim();
}

async function optionalInput(prompt: string, value?: string): Promise<string | undefined> {
  const result = await vscode.window.showInputBox({ title: prompt, value, ignoreFocusOut: true });
  return result?.trim();
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

function normalizeCommandConnectionId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export async function deactivate(): Promise<void> {
  const session = activeConnectionSession;
  activeConnectionSession = undefined;
  if (session) {
    await closeAllDocumentConnections(session);
  }
}
