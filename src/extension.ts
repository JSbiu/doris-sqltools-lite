import * as vscode from 'vscode';
import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { type ConnectionProfile } from './connectionSecurity';
import { ConnectionManager, sameConnectionTarget, showError } from './connectionManager';
import { openConnectionForm } from './connectionForm';
import {
  displayValue,
  encodeTsvHeader,
  encodeTsvRows,
  isExportFormat,
  toTsv,
  TSV_CHUNK_ROWS,
  type ExportFormat,
} from './exports';
import { buildExportFileName, normalizeExportDirectory } from './exportPath';
import { openParameterForm } from './parameterForm';
import {
  forgetParameterValues,
  readParameterValues,
  rememberParameterValues,
  type ParameterMemento,
} from './parameterStore';
import {
  parseSqlParameters,
  resolveSqlParameters,
  unescapeDollarPlaceholders,
  type SqlParameter,
} from './sqlParameters';
import {
  createRowCollector,
  findSqlStatementAtOffset,
  hasMultipleStatements,
  type QueryResultView,
  type Row,
} from './queryResults';
import {
  QueryCancelledError,
  isQueryCancelled,
  neverCancelled,
  type CancelSignal,
  type QuerySession,
  type RowSink,
  type StopReason,
} from './querySession';

type ConnectionSessionState = {
  documentConnections: Map<string, string>;
  liveConnections: Map<string, LiveDocumentConnection>;
  runningDocuments: Set<string>;
  cancellationSources: Map<string, vscode.CancellationTokenSource>;
  defaultConnectionId?: string;
};

// Export writes the whole result set, so ask before producing a huge file.
const EXPORT_CONFIRM_ROW_THRESHOLD = 100_000;

// A missing or blank setting means "ask every time", so clearing the setting
// degrades gracefully instead of writing to an unexpected location.
function configuredExportDirectory(): string | undefined {
  return normalizeExportDirectory(
    vscode.workspace.getConfiguration('dorisSqlLite').get<unknown>('exportDirectory'),
  );
}

// Only trades round-trip granularity against allocation churn: it bounds the
// intermediate string per block, not the export itself.
function configuredExportChunkRows(): number {
  const raw = vscode.workspace
    .getConfiguration('dorisSqlLite')
    .get<number>('exportChunkRows', TSV_CHUNK_ROWS);
  return Number.isInteger(raw) && raw > 0 ? raw : TSV_CHUNK_ROWS;
}

// Spreadsheets evaluate a cell starting with `=`, `@` or a non-numeric `+`/`-`,
// so an exported result carrying user-controlled text becomes an injection
// vector the moment it is opened or pasted into a sheet. On by default; the
// switch exists for pipelines that need the stored value byte for byte.
function configuredEscapeFormulas(): boolean {
  return vscode.workspace
    .getConfiguration('dorisSqlLite')
    .get<boolean>('escapeSpreadsheetFormulas', true);
}

// Hue-style ${name} substitution. Applies to every connection type: it happens
// on our side of the wire, so Doris and MySQL get the same behaviour as Spark
// even though only Spark would recognise a placeholder on its own -- and Spark
// would silently turn an unknown name into an empty string rather than fail.
function configuredSqlParameters(): boolean {
  return vscode.workspace
    .getConfiguration('dorisSqlLite')
    .get<boolean>('sqlParameters', true);
}

// How many rows to read before giving up on the rest of the answer. 0 follows
// the display cap, a positive number is an explicit limit, and -1 reads
// everything so the total can be counted exactly (the slow, pre-0.8.1
// behaviour). Never returns less than the display cap: stopping before the panel
// can be filled would be surprising.
function configuredReadRowLimit(): number {
  const raw = vscode.workspace
    .getConfiguration('dorisSqlLite')
    .get<number>('readRowLimit', 0);
  return Number.isFinite(raw) ? raw : 0;
}

export function resolveReadLimit(setting: number, maxRows: number): number | undefined {
  if (!Number.isInteger(setting) || setting === 0) {
    return maxRows;
  }
  if (setting < 0) {
    return undefined;
  }
  return Math.max(setting, maxRows);
}

type LiveDocumentConnection = {
  profileId: string;
  session: QuerySession;
};

let activeConnectionSession: ConnectionSessionState | undefined;

// Where remembered parameter values live. Workspace state when a folder is open
// (so a project keeps its own values), otherwise global. Neither is part of
// Settings Sync, and neither is settings.json -- these are business values, not
// configuration.
let parameterState: ParameterMemento | undefined;

interface ResultPanelMetadata {
  connectionName: string;
  database?: string;
  durationMs: number;
  maxRows: number;
  // False when reading stopped at the row limit, which means totalRows is a
  // lower bound rather than a count of the whole answer.
  readComplete: boolean;
  // The values this run actually substituted, so the panel shows what was really
  // sent rather than what the file says. An empty object means the statement had
  // no parameters.
  parameters?: Record<string, string>;
  // Enough to run the statement again. Rows past maxResultRows are counted but
  // never stored, so a truncated result has no full set in memory to export.
  rerun?: {
    manager: ConnectionManager;
    profile: ConnectionProfile;
    sql: string;
  };
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
  await active.session.close().catch(() => undefined);
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
  private result: QueryResultView = {
    rows: [],
    columns: [],
    affectedRows: 0,
    truncated: false,
    totalRows: 0,
  };
  private metadata: ResultPanelMetadata = {
    connectionName: '',
    durationMs: 0,
    maxRows: 1000,
    readComplete: true,
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
    panel.webview.onDidReceiveMessage(async (message: { type?: unknown; format?: unknown; chooseLocation?: unknown }) => {
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
          const exported = await resultPanel.export(message.format, {
            chooseLocation: message.chooseLocation === true,
          });
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
    const exportDirectory = configuredExportDirectory();
    const exportHint = exportDirectory ? `导出到默认目录：${exportDirectory}` : '选择导出位置';
    const databaseLabel = this.metadata.database
      ? `<span class="meta">${escapeHtml(this.metadata.database)}</span>`
      : '';
    const truncatedNotice = !this.result.truncated
      ? ''
      : this.metadata.readComplete
        ? `<div class="notice">共 ${this.result.totalRows} 行，显示前 ${this.metadata.maxRows} 行。导出为全部 ${this.result.totalRows} 行；复制为当前显示的 ${this.rows.length} 行。</div>`
        // Reading stopped at the limit, so there is no total to report -- saying
        // "共 N 行" here would be a lie the user cannot see through.
        : `<div class="notice">已读取 ${this.result.totalRows} 行后停止（达到读取上限，结果不止这些）。显示前 ${this.metadata.maxRows} 行，复制同样只取这些行；导出不受影响，会重新执行该查询并写出全部结果。</div>`;
    // What was actually substituted, not what the file says: with ${...} in the
    // statement the editor no longer shows the values that ran.
    const parameterEntries = Object.entries(this.metadata.parameters ?? {});
    const parameterNotice = parameterEntries.length === 0
      ? ''
      : `<div class="params"><span class="params-label">本次参数</span>${parameterEntries
          .map(([name, value]) => `<span class="param"><span class="param-name">${escapeHtml(name)}</span>=<span class="param-value">${escapeHtml(value)}</span></span>`)
          .join('')}</div>`;
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
    button.ghost { color: var(--vscode-textLink-foreground); background: transparent; border-color: var(--vscode-panel-border); }
    button.ghost:hover { background: var(--vscode-list-hoverBackground); }
    button:disabled { cursor: default; opacity: .65; }
    .notice { margin-bottom: 10px; padding: 8px 10px; color: var(--vscode-editorWarning-foreground); background: var(--vscode-inputValidation-warningBackground); border-left: 3px solid var(--vscode-editorWarning-foreground); }
    .params { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin-bottom: 10px; padding: 8px 10px; border-left: 3px solid var(--vscode-panel-border); background: var(--vscode-textCodeBlock-background, var(--vscode-editorWidget-background)); font-family: var(--vscode-editor-font-family); font-size: 12px; }
    .params-label { color: var(--vscode-descriptionForeground); font-family: var(--vscode-font-family); }
    .param-name { color: var(--vscode-descriptionForeground); }
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
      <button class="secondary" data-export="default" data-format="tsv" data-default-label="导出 TSV" title="${escapeHtml(exportHint)}">导出 TSV</button>
      <button class="ghost" data-export="custom" data-format="tsv" data-default-label="其他位置…" title="这次导出时弹出位置选择">其他位置…</button>
      <button data-action="copy" data-default-label="复制 TSV">复制 TSV</button>
    ` : ''}
  </div>
  ${truncatedNotice}
  ${parameterNotice}
  ${resultContent}
  <script nonce="${scriptNonce}">
    const api = acquireVsCodeApi();
    const copyButton = document.querySelector('button[data-action="copy"]');
    const exportButton = document.querySelector('button[data-export="default"]');
    const exportElsewhereButton = document.querySelector('button[data-export="custom"]');
    let pendingButton;
    const setPending = (button, label) => {
      if (!button) return;
      button.disabled = true;
      button.textContent = label;
    };
    copyButton?.addEventListener('click', () => {
      pendingButton = copyButton;
      setPending(copyButton, '正在复制…');
      api.postMessage({ type: 'copy' });
    });
    exportButton?.addEventListener('click', () => {
      pendingButton = exportButton;
      setPending(exportButton, '正在导出…');
      api.postMessage({ type: 'export', format: exportButton.dataset.format });
    });
    exportElsewhereButton?.addEventListener('click', () => {
      pendingButton = exportElsewhereButton;
      setPending(exportElsewhereButton, '正在导出…');
      api.postMessage({ type: 'export', format: exportElsewhereButton.dataset.format, chooseLocation: true });
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
      const button = pendingButton ?? (data.action === 'copy' ? copyButton : exportButton);
      pendingButton = undefined;
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

  private async export(format: ExportFormat, options: { chooseLocation?: boolean } = {}): Promise<boolean> {
    const extension = format;
    const title = this.title;
    const columns = this.columns;
    const keptRows = this.rows;
    const totalRows = this.result.totalRows;
    // Rows past maxResultRows are counted but discarded, so a truncated result
    // can only be exported by running the statement a second time.
    const rerun = this.result.truncated ? this.metadata.rerun : undefined;

    if (this.result.truncated && !rerun) {
      void vscode.window.showWarningMessage(
        this.metadata.readComplete
          ? `这次查询返回 ${totalRows} 行，面板只保留了前 ${keptRows.length} 行，无法导出完整结果。请重新执行一次查询后再导出。`
          : `这次查询读到 ${totalRows} 行就停止了，面板只保留了前 ${keptRows.length} 行，无法导出完整结果。请重新执行一次查询后再导出。`,
      );
      return false;
    }

    // An incomplete read leaves no row count to compare against the threshold,
    // and the export will re-run the statement and write an unknown number of
    // rows -- so that case is always confirmed, or the old guard would silently
    // stop protecting exactly the queries it was added for.
    const needsConfirm =
      totalRows > EXPORT_CONFIRM_ROW_THRESHOLD ||
      (rerun !== undefined && !this.metadata.readComplete);
    if (needsConfirm) {
      const parameterNote = Object.keys(this.metadata.parameters ?? {}).length > 0
        // Say so explicitly: the re-run reuses the values of this run, and the
        // panel is showing them, but the file itself no longer contains them.
        ? '（沿用本次的查询参数）'
        : '';
      const answer = await vscode.window.showWarningMessage(
        rerun
          ? this.metadata.readComplete
            ? `将导出 ${totalRows} 行。结果超出了面板保留上限，导出会重新执行一次该查询${parameterNote}。确认继续？`
            : `结果未读完，导出会重新执行一次该查询并写出全部结果${parameterNote}，行数未知、可能很大。确认继续？`
          : `将导出 ${totalRows} 行，文件可能很大。确认继续？`,
        { modal: true },
        '继续导出',
      );
      if (answer !== '继续导出') {
        return false;
      }
    }

    const defaultName = buildExportFileName(title, extension, new Date());
    const directory = options.chooseLocation ? undefined : configuredExportDirectory();
    if (directory) {
      const target = join(directory, defaultName);
      try {
        await mkdir(directory, { recursive: true });
        const written = await this.exportTo(vscode.Uri.file(target), columns, keptRows, rerun);
        if (written === undefined) {
          return false;
        }
        vscode.window.showInformationMessage(`已导出 ${written} 行到 ${target}`);
        return true;
      } catch (error) {
        // A stale or unwritable default directory must never block the export.
        const reason = error instanceof Error ? error.message : String(error);
        void vscode.window.showWarningMessage(`写入默认导出目录失败（${reason}），请选择其他位置。`);
      }
    }

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

    const written = await this.exportTo(uri, columns, keptRows, rerun);
    if (written === undefined) {
      return false;
    }
    vscode.window.showInformationMessage(`已导出 ${written} 行到 ${uri.fsPath}`);
    return true;
  }

  // Writes behind a cancellable notification. A result the panel kept in full is
  // written straight from memory, so the bar is exact; a truncated one is
  // re-run, and since its size cannot be known up front the bar reports the
  // count reached instead. Returns undefined when the user cancelled.
  private async exportTo(
    uri: vscode.Uri,
    columns: string[],
    keptRows: Row[],
    rerun: { manager: ConnectionManager; profile: ConnectionProfile; sql: string } | undefined,
  ): Promise<number | undefined> {
    const chunkRows = configuredExportChunkRows();
    const escapeFormulas = configuredEscapeFormulas();
    let lastRatio = 0;
    let cancelled = false;
    let written = 0;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: rerun ? '导出结果（重新执行查询）' : `导出 ${keptRows.length} 行`,
        cancellable: true,
      },
      async (progress, token) => {
        const report = (rowsWritten: number): void => {
          if (rerun) {
            progress.report({ message: `已导出 ${rowsWritten} 行…` });
            return;
          }
          const ratio = keptRows.length === 0 ? 1 : Math.min(rowsWritten / keptRows.length, 1);
          progress.report({
            message: `${rowsWritten} / ${keptRows.length} 行`,
            increment: Math.max((ratio - lastRatio) * 100, 0),
          });
          lastRatio = ratio;
        };

        const writer = createTsvWriter(uri, columns, {
          chunkRows,
          escapeFormulas,
          token,
          onProgress: report,
        });

        try {
          await writer.begin();
          if (rerun) {
            await runForExport(rerun, writer, token);
          } else {
            for (const row of keptRows) {
              await writer.write(row);
            }
          }
          written = await writer.finish();
        } catch (error) {
          await writer.abort();
          if (!isQueryCancelled(error)) {
            throw error;
          }
          cancelled = true;
        }
      },
    );

    if (cancelled) {
      vscode.window.showInformationMessage('已取消导出，未写完的文件已删除。');
      return undefined;
    }
    return written;
  }

  public async copyToClipboard(): Promise<void> {
    const rows = this.rows;
    await vscode.env.clipboard.writeText(toTsv(rows, this.columns));
    if (this.result.truncated) {
      vscode.window.showInformationMessage(
        this.metadata.readComplete
          ? `已复制当前显示的 ${rows.length} 行（共 ${this.result.totalRows} 行）；需要全部数据请用导出。`
          : `已复制当前显示的 ${rows.length} 行（结果未读完，实际不止这些）；需要全部数据请用导出。`,
      );
    }
  }
}

// Runs the statement again and feeds the rows straight into the writer. Uses its
// own connection so a long export cannot disturb the session the user is working
// in (USE / temp tables / session variables stay put).
async function runForExport(
  rerun: { manager: ConnectionManager; profile: ConnectionProfile; sql: string },
  writer: TsvWriter,
  token: vscode.CancellationToken,
): Promise<void> {
  const session = await rerun.manager.open(rerun.profile);
  const listeners = new Set<() => void>();
  // No row limit here on purpose: an export exists to write every row, so this
  // path always reads the answer to the end. Only the user can stop it.
  const signal: CancelSignal = {
    get requested(): boolean {
      return token.isCancellationRequested;
    },
    get reason(): StopReason | undefined {
      return token.isCancellationRequested ? 'user' : undefined;
    },
    onRequest(listener: () => void) {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
  };
  const subscription = token.onCancellationRequested(() => {
    for (const listener of [...listeners]) {
      listener();
    }
  });

  try {
    const sink: RowSink = {
      onColumns: () => undefined,
      onAffectedRows: () => undefined,
      onRow: (row) => writer.write(row),
    };
    await session.execute(rerun.sql, signal, sink);
    if (token.isCancellationRequested) {
      throw new QueryCancelledError('导出已取消。');
    }
  } finally {
    subscription.dispose();
    listeners.clear();
    await session.close().catch(() => undefined);
  }
}

interface WriteTsvOptions {
  chunkRows: number;
  escapeFormulas: boolean;
  token: vscode.CancellationToken;
  onProgress: (writtenRows: number) => void;
}

function throwIfCancelled(token: vscode.CancellationToken): void {
  if (token.isCancellationRequested) {
    throw new QueryCancelledError('导出已取消。');
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

interface TsvWriter {
  // Writes the header row.
  begin(): Promise<void>;
  write(row: Row): Promise<void>;
  // Flushes the tail, closes the target and reports how many data rows landed.
  finish(): Promise<number>;
  // Drops the half-written target.
  abort(): Promise<void>;
}

// Accepts rows one at a time so a result set can be exported without being
// materialised first: the rows a re-run produces go straight to disk. Blocks
// stay bounded, which also keeps the intermediate string well clear of V8's
// ~512MB ceiling. Non-file targets have no streaming API, so the blocks are
// collected as Buffers there and written once -- bytes rather than a JS string.
function createTsvWriter(
  uri: vscode.Uri,
  columns: string[],
  options: WriteTsvOptions,
): TsvWriter {
  const { chunkRows, escapeFormulas, token, onProgress } = options;
  const encodeOptions = { escapeFormulas };
  const header = encodeTsvHeader(columns, encodeOptions);

  let buffer: Row[] = [];
  let writtenRows = 0;
  let parts: Buffer[] | undefined;
  let stream: ReturnType<typeof createWriteStream> | undefined;

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) {
      return;
    }
    const block = encodeTsvRows(buffer, columns, encodeOptions);
    writtenRows += buffer.length;
    buffer = [];

    if (parts) {
      parts.push(Buffer.from(block, 'utf8'));
    } else if (stream) {
      if (!stream.write(block)) {
        await once(stream, 'drain');
      }
      // When the write buffer never fills there is nothing above to await, so
      // hand the event loop a turn; otherwise a fast disk makes the whole loop
      // synchronous and neither the progress bar nor cancellation is observed.
      await yieldToEventLoop();
    }
    onProgress(writtenRows);
  };

  return {
    async begin(): Promise<void> {
      if (uri.scheme !== 'file') {
        parts = [Buffer.from(header, 'utf8')];
        return;
      }
      stream = createWriteStream(uri.fsPath, { encoding: 'utf8' });
      if (!stream.write(header)) {
        await once(stream, 'drain');
      }
    },

    async write(row: Row): Promise<void> {
      throwIfCancelled(token);
      buffer.push(row);
      if (buffer.length >= chunkRows) {
        await flush();
      }
    },

    async finish(): Promise<number> {
      throwIfCancelled(token);
      await flush();
      if (parts) {
        await vscode.workspace.fs.writeFile(uri, Buffer.concat(parts));
      } else if (stream) {
        stream.end();
        await once(stream, 'finish');
      }
      return writtenRows;
    },

    async abort(): Promise<void> {
      stream?.destroy();
      if (uri.scheme === 'file') {
        // A half-written file must not be left behind looking like a complete export.
        await unlink(uri.fsPath).catch(() => undefined);
      }
    },
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const manager = new ConnectionManager(context);
  const provider = new ConnectionProvider(manager);
  // Kept only for the current extension host session; never persisted to settings.
  const connectionSession: ConnectionSessionState = {
    documentConnections: new Map(),
    liveConnections: new Map(),
    runningDocuments: new Set(),
    cancellationSources: new Map(),
  };
  activeConnectionSession = connectionSession;
  const connectionStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  connectionStatus.name = 'Doris SQL Lite Connection';
  connectionStatus.command = 'dorisSqlLite.setConnection';
  const refreshConnectionStatus = (): void => updateConnectionStatus(connectionStatus, manager, connectionSession);
  refreshConnectionStatus();

  try {
    await manager.migrateConnectionScope();
  } catch (error) {
    showError('迁移连接配置位置失败', error);
  }

  try {
    await manager.migrateLegacyPasswords();
  } catch (error) {
    showError('迁移旧连接密码失败', error);
  }

  // A project keeps its own parameter values; without a folder there is nothing
  // to scope to, so fall back to global state.
  parameterState = vscode.workspace.workspaceFolders?.length
    ? context.workspaceState
    : context.globalState;

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
    vscode.commands.registerCommand('dorisSqlLite.addConnection', () => {
      openConnectionForm({
        context,
        manager,
        mode: 'add',
        onSaved: async (profile, info) => {
          provider.refresh();
          refreshConnectionStatus();
          const passwordNote = info.passwordSaved ? '' : '；未保存密码，首次连接时会提示输入';
          vscode.window.showInformationMessage(`已添加连接：${profile.name}${passwordNote}`);
        },
      });
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
      const existing = item?.profile ?? await chooseProfile(manager);
      if (!existing) {
        return;
      }
      openConnectionForm({
        context,
        manager,
        mode: 'edit',
        existing,
        onSaved: async (profile, info) => {
          let sessionClosed = false;
          if (!sameConnectionTarget(existing, profile)) {
            sessionClosed = [...connectionSession.liveConnections.values()].some(
              (active) => active.profileId === existing.id,
            );
            await closeConnectionsForProfile(connectionSession, existing.id);
          }
          provider.refresh();
          refreshConnectionStatus();
          const notes: string[] = [];
          if (info.passwordSaved) {
            notes.push('已更新密码');
          } else if (info.passwordCleared) {
            notes.push('已清除已保存的密码');
          }
          if (sessionClosed) {
            notes.push('已关闭该连接的活动会话');
          }
          const suffix = notes.length > 0 ? `（${notes.join('；')}）` : '';
          vscode.window.showInformationMessage(`已更新连接：${profile.name}${suffix}`);
        },
      });
    }),
    vscode.commands.registerCommand('dorisSqlLite.runQuery', async (commandArgument?: unknown) => {
      await runQuery(manager, connectionSession, normalizeCommandConnectionId(commandArgument), refreshConnectionStatus);
    }),
    vscode.commands.registerCommand('dorisSqlLite.cancelQuery', async () => {
      const documentKey = vscode.window.activeTextEditor?.document.uri.toString();
      const source = documentKey ? connectionSession.cancellationSources.get(documentKey) : undefined;
      if (!source) {
        vscode.window.showInformationMessage('当前 SQL 文件没有正在执行的查询。');
        return;
      }
      source.cancel();
    }),
    vscode.commands.registerCommand('dorisSqlLite.testConnection', async (item?: ConnectionItem) => {
      const profile = await chooseProfile(manager, item?.profile.id);
      if (!profile) {
        return;
      }
      let session: QuerySession | undefined;
      try {
        session = await manager.open(profile);
        // Only connectivity matters here, so keep a single row rather than
        // buffering whatever the probe returns.
        await session.execute('SELECT 1', neverCancelled, createRowCollector(1));
        vscode.window.showInformationMessage(`连接成功：${profile.name}`);
      } catch (error) {
        showError(`连接失败（${profile.name}）`, error);
      } finally {
        await session?.close().catch(() => undefined);
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
    vscode.commands.registerCommand('dorisSqlLite.setExportDirectory', async () => {
      const current = configuredExportDirectory();
      const picked = await vscode.window.showOpenDialog({
        title: '选择默认导出目录',
        openLabel: '设为默认导出目录',
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri: current ? vscode.Uri.file(current) : undefined,
      });
      const directory = picked?.[0];
      if (!directory) {
        return;
      }
      await vscode.workspace
        .getConfiguration('dorisSqlLite')
        .update('exportDirectory', directory.fsPath, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`已设置默认导出目录：${directory.fsPath}`);
    }),
    vscode.commands.registerCommand('dorisSqlLite.clearExportDirectory', async () => {
      const current = configuredExportDirectory();
      if (!current) {
        vscode.window.showInformationMessage('当前没有设置默认导出目录，每次导出都会弹出位置选择。');
        return;
      }
      await vscode.workspace
        .getConfiguration('dorisSqlLite')
        .update('exportDirectory', '', vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`已清除默认导出目录（原：${current}），导出时将重新弹出位置选择。`);
    }),
    vscode.commands.registerCommand('dorisSqlLite.forgetSqlParameters', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('请先打开要清除参数的 SQL 文件。');
        return;
      }
      if (!parameterState) {
        vscode.window.showInformationMessage('当前没有记住任何查询参数。');
        return;
      }

      const documentKey = editor.document.uri.toString();
      const remembered = readParameterValues(parameterState, documentKey);
      const names = Object.keys(remembered);
      if (names.length === 0) {
        vscode.window.showInformationMessage(
          `「${basename(editor.document.fileName)}」没有记住查询参数。`,
        );
        return;
      }

      // Confirm by name: this is the way out of a value that has gone stale, and
      // it is not obvious from the editor that anything was stored at all.
      const answer = await vscode.window.showWarningMessage(
        `将清除「${basename(editor.document.fileName)}」记住的 ${names.length} 个查询参数：${names.join('、')}。下次执行会重新询问。`,
        { modal: true },
        '清除',
      );
      if (answer !== '清除') {
        return;
      }

      await forgetParameterValues(parameterState, documentKey);
      vscode.window.showInformationMessage(`已清除 ${names.length} 个查询参数。`);
    }),
  );
}



// The declaration text a value was entered against, as written after the `=`:
// `US` for ${country=US}, `A, B` for ${country=A, B}, '' when there is none.
// Comparing it verbatim is what lets an edit to the default inside the SQL
// invalidate a remembered value.
function declarationText(parameter: SqlParameter): string {
  return parameter.candidates.join(', ');
}

// Resolves Hue-style ${...} parameters, asking for anything the template does not
// answer by itself. Returns undefined when the user backs out.
async function prepareStatementSql(
  sql: string,
  documentKey: string,
  documentLabel: string,
): Promise<{ sql: string; used: Record<string, string> } | undefined> {
  if (!configuredSqlParameters()) {
    // Still unwrap $$ escapes: they are part of the template's meaning either way.
    return { sql: unescapeDollarPlaceholders(sql), used: {} };
  }

  const parameters = parseSqlParameters(sql);
  if (parameters.length === 0) {
    return { sql: unescapeDollarPlaceholders(sql), used: {} };
  }

  const declarations: Record<string, string> = {};
  for (const parameter of parameters) {
    declarations[parameter.name] = declarationText(parameter);
  }

  const decision = await openParameterForm({
    documentLabel,
    sql,
    parameters,
    initialValues: parameterState
      ? readParameterValues(parameterState, documentKey, declarations)
      : {},
  });
  if (!decision) {
    return undefined;
  }
  if (decision.action === 'raw') {
    return { sql: unescapeDollarPlaceholders(sql), used: {} };
  }

  const resolution = resolveSqlParameters(sql, decision.values);
  if (resolution.missing.length > 0) {
    // The panel will not submit with an unanswered parameter, so this is a
    // backstop: a placeholder must never reach the server by accident, because
    // Spark turns an unknown one into an empty string instead of failing.
    vscode.window.showWarningMessage(
      `这些参数没有值，已取消执行：${resolution.missing.join('、')}。`,
    );
    return undefined;
  }

  if (parameterState) {
    try {
      await rememberParameterValues(parameterState, documentKey, decision.values, declarations);
    } catch {
      // Remembering is a convenience; a state write failure must not block a query.
    }
  }
  return { sql: resolution.sql, used: resolution.used };
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
    vscode.window.showInformationMessage(
      '当前 SQL 文件已有查询正在执行；可从进度通知取消，或执行 Doris SQL Lite: Cancel Query。',
    );
    return;
  }

  // ${...} is resolved before a connection is chosen, so cancelling the panel
  // cannot leave a session behind. Substituting here, after the statement was
  // picked out of the document, is what keeps a value containing `;` or `--`
  // from ever moving a statement boundary.
  const prepared = await prepareStatementSql(
    sql,
    documentKey,
    basename(editor.document.fileName),
  );
  if (!prepared) {
    return;
  }
  const statement = prepared.sql;

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
  const cancelSource = new vscode.CancellationTokenSource();
  connectionSession.cancellationSources.set(documentKey, cancelSource);

  const startedAt = Date.now();
  let progressHandle: vscode.Progress<{ message?: string }> | undefined;
  let session: QuerySession | undefined =
    connectionSession.liveConnections.get(documentKey)?.session;
  let cancelled = false;

  const isCancelled = (token?: vscode.CancellationToken): boolean =>
    cancelled || cancelSource.token.isCancellationRequested || token?.isCancellationRequested === true;

  // Adapters listen on this instead of on a vscode token, so the query runner no
  // longer has to know how a given protocol interrupts a statement. `reason`
  // travels with it because the two ways of stopping lead to opposite outcomes:
  // a cancel discards the rows, a row limit means we are done and want them.
  const cancelListeners = new Set<() => void>();
  let stopReason: StopReason | undefined;
  const signal: CancelSignal = {
    get requested(): boolean {
      return cancelled;
    },
    get reason(): StopReason | undefined {
      return stopReason;
    },
    onRequest(listener: () => void) {
      cancelListeners.add(listener);
      return {
        dispose: () => {
          cancelListeners.delete(listener);
        },
      };
    },
  };

  const dropSession = async (target: QuerySession): Promise<void> => {
    const active = connectionSession.liveConnections.get(documentKey);
    if (active?.session === target) {
      connectionSession.liveConnections.delete(documentKey);
    }
    await target.close().catch(() => undefined);
  };

  const stop = (reason: StopReason): void => {
    if (cancelled) {
      return;
    }
    cancelled = true;
    stopReason = reason;
    progressHandle?.report({ message: reason === 'user' ? '正在取消…' : '已读满，正在停止读取…' });
    for (const listener of [...cancelListeners]) {
      listener();
    }
  };

  const requestCancel = (): void => stop('user');

  const subscriptions = [cancelSource.token.onCancellationRequested(requestCancel)];
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `执行 ${profile.name}`,
        cancellable: true,
      },
      async (progress, token) => {
        progressHandle = progress;
        subscriptions.push(token.onCancellationRequested(requestCancel));
        try {
          let active = session;
          if (!active) {
            progress.report({ message: '正在建立连接…' });
            active = await manager.open(profile);
            session = active;
            connectionSession.liveConnections.set(documentKey, {
              profileId: profile.id,
              session: active,
            });
          } else {
            progress.report({ message: '复用当前文件连接…' });
          }
          if (signal.requested) {
            await dropSession(active);
            return;
          }
          const maxRows = vscode.workspace
            .getConfiguration('dorisSqlLite')
            .get<number>('maxResultRows', 1000);
          // Rows arrive one at a time and only the first maxRows are kept. Once
          // one row past that cap has arrived, truncation is certain -- so the
          // read stops there instead of counting the rest of the answer, which
          // for a few hundred thousand rows is the difference between seconds
          // and a minute. The statement is interrupted the same way a cancel
          // does it, so the server stops producing too.
          const readLimit = resolveReadLimit(configuredReadRowLimit(), maxRows);
          let reportedRows = 0;
          const collector = createRowCollector(
            maxRows,
            readLimit === undefined ? {} : { onLimitReached: () => stop('limit') },
          );
          const sink: RowSink = {
            onColumns: (columns) => collector.onColumns(columns),
            onAffectedRows: (count) => collector.onAffectedRows(count),
            onRow: (row) => {
              collector.onRow(row);
              const total = collector.totalRows();
              if (total - reportedRows >= 1000) {
                reportedRows = total;
                progress.report({ message: `已读取 ${total} 行…` });
              }
            },
          };

          progress.report({ message: '正在执行…' });
          await active.execute(statement, signal, sink);
          // Only a user cancel abandons the result here. A limit stop returns
          // the rows on purpose: they are exactly what was asked for.
          if (stopReason === 'user') {
            return;
          }
          ResultPanel.open(collector.toView(), {
            connectionName: profile.name,
            database: profile.database,
            durationMs: Date.now() - startedAt,
            maxRows,
            parameters: prepared.used,
            // False when we stopped reading at the limit, so the panel can say
            // "已读取 N 行" instead of claiming an exact total it does not have.
            readComplete: stopReason !== 'limit',
            // The resolved statement, not the template: an export that has to run
            // the query again must use the same values this panel is showing.
            rerun: { manager, profile, sql: statement },
          });
        } catch (error) {
          if (isQueryCancelled(error) || isCancelled(token)) {
            vscode.window.showInformationMessage(`已取消 ${profile.name} 上的查询。`);
          } else {
            showError(`执行失败（${profile.name}）`, error);
          }
        }
      },
    );
  } finally {
    for (const subscription of subscriptions) {
      subscription.dispose();
    }
    cancelListeners.clear();
    cancelSource.dispose();
    connectionSession.cancellationSources.delete(documentKey);
    connectionSession.runningDocuments.delete(documentKey);
    // A session that already had to be torn down (or was dropped to cancel) must
    // not be handed to the next statement.
    if (session?.broken) {
      await dropSession(session);
    }
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

function normalizeCommandConnectionId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export async function deactivate(): Promise<void> {
  const session = activeConnectionSession;
  activeConnectionSession = undefined;
  parameterState = undefined;
  if (session) {
    for (const source of session.cancellationSources.values()) {
      source.cancel();
    }
    await closeAllDocumentConnections(session);
  }
}
