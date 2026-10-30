import * as vscode from 'vscode';
import { mkdir } from 'node:fs/promises';
import { join, basename, dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DataKeys } from './dataKeys';
import { registerDataCommands } from './dataCommands';
import {
  createProtection, decodeParameter, getDataMode, loadParameterKeys,
  onDataModeChange, protectSink, PROTECTED_MATERIAL_NOTICE, type ProtectionProjection,
} from './dataProtection';
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
import { buildExportFileName, normalizeExportDirectory, resolveOutputPath } from './exportPath';
import { assertDirectExportSql } from './directExport';
import { runBatchScript } from './batchScript';
import { BatchProgress } from './batchProgress';
import { readBatchDefinition, parseBatchParameters, prepareBatchTask, createBatchFeedback, runBatchTask } from './batchExecution';
import { createTsvFileWriter, type TsvFileWriter } from './tsvFileWriter';
import { copyFeedback, saveFeedback, rememberFeedback, type FeedbackRecord } from './feedbackActions';
import { classifyDatabaseError, formatDatabaseError } from './connectionDiagnostics';
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
  hasMultipleStatements,
  type QueryResultView,
  type Row,
} from './queryResults';
import { applyRowLimit } from './rowLimit';
import { resolveStatementContext, findDirectiveConnection } from './sqlDirectives';
import { buildExplainSql, planText } from './executionPlan';
import { openPlanPanel } from './planPanel';
import { setFeedbackExtensionVersion } from './sqlFeedback';
import { WEBVIEW_BASE_CSS, escapeHtml } from './webviewTheme';
import { DocumentSessions, SessionExpiredError, type DocumentOperation, type SessionEntry, type SessionSnapshot } from './documentSessions';
import {
  QueryCancelledError,
  isQueryCancelled,
  neverCancelled,
  type CancelSignal,
  type QuerySession,
  type StopReason,
} from './querySession';

type ConnectionSessionState = {
  documentConnections: Map<string, string>;
  sessions: DocumentSessions;
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

// A connection that goes away without a FIN leaves the read loop parked on a
// packet that will never arrive -- the progress notification keeps spinning and
// the file stays marked as running. This is how long a live connection may go
// quiet mid-answer before it is presumed dead; the clock only starts once rows
// have begun arriving, so a slow statement is never cut off by it.
function configuredQueryIdleTimeoutMs(): number {
  const raw = vscode.workspace
    .getConfiguration('dorisSqlLite')
    .get<number>('queryIdleTimeoutMs', 300_000);
  return Number.isFinite(raw) ? raw : 300_000;
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

let activeConnectionSession: ConnectionSessionState | undefined;

// Where remembered parameter values live. Workspace state when a folder is open
// (so a project keeps its own values), otherwise global. Neither is part of
// Settings Sync, and neither is settings.json -- these are business values, not
// configuration.
let parameterState: ParameterMemento | undefined;
let dataKeys: DataKeys | undefined;

function protectedMessage(error: unknown, protection?: ProtectionProjection, protectRaw = false): string {
  return (getDataMode() === 'encrypted' || protection?.mode === 'encrypted') && (protection || protectRaw)
    ? `${classifyDatabaseError(error).kind}：${PROTECTED_MATERIAL_NOTICE}` : formatDatabaseError(error);
}

function modeLabel(protection?: ProtectionProjection): string {
  return protection ? `（${protection.mode === 'encrypted' ? '字段密文' : '字段原文'}）` : '';
}

function tlsDescription(profile: ConnectionProfile): string {
  if (!profile.ssl) return '';
  return profile.sslVerify === false ? 'TLS · 接受证书' : 'TLS · 校验';
}

function tlsTooltip(profile: ConnectionProfile): string {
  if (!profile.ssl) return '传输：未启用 TLS';
  return profile.sslVerify === false ? '传输：TLS，接受服务器证书' : '传输：TLS，校验证书';
}

function declaresProtection(sql: string): boolean {
  return /--\s*@(?:default-)?encrypt\b/i.test(sql);
}

async function statementProtection(context: { encryption?: Readonly<Record<string, string>>; requiredEncryption?: readonly string[] }): Promise<ProtectionProjection | undefined> {
  if (!context.encryption || !Object.keys(context.encryption).length) return undefined;
  if (!dataKeys) throw new Error('字段加密密钥存储尚未就绪，请重新加载窗口。');
  const mode = getDataMode();
  const key = await dataKeys.active();
  return createProtection(context.encryption, context.requiredEncryption ?? [], key, (id) => dataKeys!.lookup(id), mode);
}

interface ResultPanelMetadata {
  connectionName: string;
  databaseType?: ConnectionProfile['type'];
  statementName?: string;
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
  feedback?: FeedbackRecord;
  protection?: ProtectionProjection;
  origin?: ResultOrigin;
  // Enough to run the statement again. Rows past maxResultRows are counted but
  // never stored, so a truncated result has no full set in memory to export.
  rerun?: ResultRerun;
}

interface ResultOrigin {
  state: ConnectionSessionState;
  documentKey: string;
  onStateChanged?: () => void;
}

interface ResultRerun extends ResultOrigin {
  snapshot: SessionSnapshot;
  sql: string;
  protection?: ProtectionProjection;
  parameters?: Readonly<Record<string, string>>;
}

interface ExportOperation {
  source: vscode.CancellationTokenSource;
  operation: DocumentOperation;
}

async function closeDocumentConnection(
  session: ConnectionSessionState,
  documentKey: string,
): Promise<void> {
  await session.sessions.closeDocument(documentKey);
}

async function closeConnectionsForProfile(
  session: ConnectionSessionState,
  profileId: string,
): Promise<void> {
  await session.sessions.closeProfile(profileId);
}

async function closeAllDocumentConnections(session: ConnectionSessionState): Promise<void> {
  await session.sessions.closeAll();
}

async function withDocumentOperation<T>(
  state: ConnectionSessionState, documentKey: string, onStateChanged: (() => void) | undefined,
  task: (source: vscode.CancellationTokenSource, operation: DocumentOperation) => Promise<T>,
): Promise<T | undefined> {
  const source = new vscode.CancellationTokenSource();
  const operation = state.sessions.begin(documentKey, () => source.cancel());
  if (!operation) {
    source.dispose();
    const active = state.cancellationSources.get(documentKey);
    const answer = active
      ? await vscode.window.showInformationMessage('当前 SQL 文件已有查询、计划、导出或分批任务正在执行。', '取消该操作')
      : await vscode.window.showInformationMessage('当前 SQL 文件正在释放会话，请稍后重试。');
    if (answer === '取消该操作') active?.cancel();
    return undefined;
  }
  const subscription = source.token.onCancellationRequested(() => operation.cancel());
  state.cancellationSources.set(documentKey, source);
  state.runningDocuments.add(documentKey);
  onStateChanged?.();
  try {
    return await task(source, operation);
  } finally {
    subscription.dispose();
    state.cancellationSources.delete(documentKey);
    state.runningDocuments.delete(documentKey);
    source.dispose();
    operation.finish();
    onStateChanged?.();
  }
}

function untilCancelled<T>(promise: PromiseLike<T>, token?: vscode.CancellationToken): Promise<T | undefined> {
  if (!token) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const cancellation: { subscription?: vscode.Disposable } = {};
    cancellation.subscription = token.onCancellationRequested(() => { cancellation.subscription?.dispose(); resolve(undefined); });
    Promise.resolve(promise).then((value) => { cancellation.subscription?.dispose(); resolve(value); },
      (error) => { cancellation.subscription?.dispose(); reject(error); });
    if (token.isCancellationRequested) { cancellation.subscription.dispose(); resolve(undefined); }
  });
}

class ConnectionItem extends vscode.TreeItem {
  public readonly contextValue = 'dorisSqlLite.connection';

  public constructor(public readonly profile: ConnectionProfile) {
    super(profile.name, vscode.TreeItemCollapsibleState.None);
    this.description = `${profile.type} · ${profile.host}:${profile.port}${profile.ssl ? ` · ${tlsDescription(profile)}` : ''}`;
    this.tooltip = `${profile.name}\n${profile.username}@${profile.host}:${profile.port}${
      profile.database ? `/${profile.database}` : ''
    }\n${tlsTooltip(profile)}`;
    this.iconPath = new vscode.ThemeIcon('database');
    this.command = {
      command: 'dorisSqlLite.newQuery',
      title: '新建 SQL 查询',
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
    hasResultSet: true,
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
      `结果 · ${metadata.statementName ?? metadata.connectionName}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    const resultPanel = new ResultPanel(panel);
    const modeSubscription = onDataModeChange(() => resultPanel.render());
    ResultPanel.current = resultPanel;
    resultPanel.update(result, metadata);
    panel.onDidDispose(() => {
      modeSubscription.dispose();
      if (ResultPanel.current === resultPanel) {
        ResultPanel.current = undefined;
      }
    });
    panel.webview.onDidReceiveMessage(async (message: { type?: unknown; format?: unknown; chooseLocation?: unknown }) => {
      if (message.type === 'toggle-mode') {
        await vscode.commands.executeCommand('dorisSqlLite.toggleDataMode');
        return;
      }
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
      if (message.type === 'copy-feedback' || message.type === 'save-feedback') {
        try {
          if (!resultPanel.metadata.feedback) throw new Error('这次结果没有可用反馈，请重新执行查询。');
          const done = message.type === 'copy-feedback'
            ? await copyFeedback(resultPanel.metadata.feedback) : await saveFeedback(resultPanel.metadata.feedback);
          await panel.webview.postMessage({ type: done ? 'actionComplete' : 'actionCancelled', action: 'feedback' });
        } catch (error) {
          showError('反馈操作失败', error);
          await panel.webview.postMessage({ type: 'actionFailed', action: 'feedback' });
        }
      }
    });
  }

  private update(result: QueryResultView, metadata: ResultPanelMetadata): void {
    this.result = result;
    this.metadata = metadata;
    this.panel.title = `结果 · ${metadata.statementName ?? metadata.connectionName}`;
    this.render();
  }

  private get rows(): Row[] {
    const projection = this.metadata.protection?.withMode(getDataMode());
    return projection ? this.result.rows.map((row) => projection.row(row)) : this.result.rows;
  }

  private get columns(): string[] {
    return this.result.columns;
  }

  private get title(): string {
    return this.metadata.connectionName;
  }

  private render(): void {
    try { this.renderResult(); }
    catch (error) {
      if (!this.metadata.protection) throw error;
      // Clear a previous plain DOM even if the new projection fails.
      this.panel.webview.html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';"></head><body>受保护结果暂时无法显示，请核对字段类型或通过状态栏切换模式。</body></html>`;
    }
  }

  private renderResult(): void {
    const scriptNonce = nonce();
    const shownRows = this.rows.map((row) =>
      this.columns.map((column) => {
        const value = row[column];
        if (value === null || value === undefined) {
          return { html: '<span class="null-value">NULL</span>', sort: ' data-sort-null="1"' };
        }
        const text = displayValue(value);
        if (typeof value === 'number' && Number.isFinite(value)) {
          return {
            html: escapeHtml(text),
            sort: ` data-sort-kind="number" data-sort-value="${escapeHtml(String(value))}"`,
          };
        }
        // Everything else is sorted as its displayed text, which keeps text IDs
        // and non-finite numbers exactly as the user sees them.
        return { html: escapeHtml(text), sort: ` data-sort-kind="text" data-sort-value="${escapeHtml(text)}"` };
      }),
    );
    const header = [
      '<th class="row-number" aria-label="行号">#</th>',
      ...this.columns.map((column, index) => `<th scope="col" aria-sort="none" data-sort-header="${index}"><button type="button" class="sort-button" data-sort-column="${index}" data-sort-label="${escapeHtml(column)}" title="排序：${escapeHtml(column)}" aria-label="按 ${escapeHtml(column)} 排序：当前为原始顺序">${escapeHtml(column)}<span class="sort-indicator" aria-hidden="true">↕</span></button></th>`),
    ].join('');
    const body = shownRows
      .map((cells, index) => `<tr data-row data-original-index="${index}"><td class="row-number">${index + 1}</td>${cells.map((cell) => `<td${cell.sort}>${cell.html}</td>`).join('')}</tr>`)
      .join('');
    const hasTable = this.columns.length > 0;
    const exportDirectory = configuredExportDirectory();
    const exportHint = exportDirectory ? `导出到默认目录：${exportDirectory}` : '选择导出位置';
    const truncatedNotice = !this.result.truncated
      ? ''
      : this.metadata.readComplete
        ? `<div class="status-banner warning">本次结果共 ${this.result.totalRows} 行，面板保留前 ${this.metadata.maxRows} 行。导出会写出全部 ${this.result.totalRows} 行，复制使用当前显示的 ${this.rows.length} 行。</div>`
        // Reading stopped at the limit, so there is no total to report -- saying
        // "共 N 行" here would be a lie the user cannot see through.
        : `<div class="status-banner warning">已读取 ${this.result.totalRows} 行并达到上限。面板与复制使用已加载的 ${this.rows.length} 行；导出会重新执行查询并写出完整结果。</div>`;
    // What was actually substituted, not what the file says: with ${...} in the
    // statement the editor no longer shows the values that ran.
    const projection = this.metadata.protection?.withMode(getDataMode());
    const parameterEntries = Object.entries(projection?.parameters(this.metadata.parameters ?? {}) ?? this.metadata.parameters ?? {});
    const parameterNotice = parameterEntries.length === 0
      ? ''
      : `<section class="section compact parameter-panel"><div class="section-header"><span class="section-title">本次参数</span><span class="section-note">${parameterEntries.length} 项</span></div><div class="parameter-list">${parameterEntries
          .map(([name, value]) => `<span class="parameter-chip"><span class="parameter-key">${escapeHtml(name)}</span><span class="parameter-value">${escapeHtml(value)}</span></span>`)
          .join('')}</div></section>`;
    const resultContent = hasTable
      ? `<div class="table-wrap"><table><thead><tr>${header}</tr></thead><tbody>${body || `<tr class="empty-row"><td colspan="${this.columns.length + 1}">查询成功，未返回数据</td></tr>`}</tbody></table></div>`
      : `<section class="success-state"><span class="success-icon">✓</span><div><h2>语句执行成功</h2><p>${this.result.affectedRows === null ? '影响行数未知' : `影响 ${this.result.affectedRows} 行`} · ${formatDuration(this.metadata.durationMs)}</p></div></section>`;
    // Sorting and filtering only ever reorder what is already in the panel, so
    // say that next to the table instead of implying a server-side ORDER BY.
    const sortScopeNotice = !hasTable
      ? ''
      : `<div class="table-meta"><span id="sort-status" class="sort-status" role="status" aria-live="polite">原始顺序</span><span>排序与筛选作用于已加载的 ${this.rows.length} 行；复制与导出保持查询返回顺序。</span></div>`;
    const title = this.metadata.statementName ?? '查询结果';
    const modeControl = projection
      ? `<button class="badge accent mode-button" id="data-mode" title="切换当前窗口的字段保护输出方式"><span>${projection.mode === 'encrypted' ? '字段密文' : '字段原文'}</span><span class="mode-hint">点击切换</span></button>`
      : '<span class="badge">普通输出</span>';

    this.panel.webview.html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}';" />
  <style>
    ${WEBVIEW_BASE_CSS}
    .result-page { padding-bottom: 18px; }
    .result-commandbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px 12px;
      margin-bottom: 12px;
      padding: 10px 12px;
      background: var(--ui-surface);
      border: 1px solid var(--ui-line-soft);
      border-radius: var(--ui-radius);
    }
    .filter-wrap { position: relative; flex: 1 1 240px; max-width: 420px; }
    .filter-wrap input { padding-left: 30px; }
    .filter-icon { position: absolute; left: 9px; top: 50%; color: var(--vscode-descriptionForeground); transform: translateY(-50%); pointer-events: none; }
    .action-group { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
    .action-group.secondary { margin-left: auto; }
    .mode-button { gap: 7px; padding: 2px 9px; color: var(--vscode-foreground); background: transparent; font-weight: 600; }
    .mode-button:hover { background: var(--vscode-list-hoverBackground); }
    .mode-hint { color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 500; }
    .result-notices { display: grid; gap: 8px; margin-bottom: 12px; }
    .parameter-panel { margin-bottom: 12px; }
    .parameter-list { display: flex; flex-wrap: wrap; gap: 7px; }
    .parameter-chip {
      display: inline-flex;
      align-items: baseline;
      gap: 5px;
      max-width: min(100%, 420px);
      padding: 4px 8px;
      background: var(--ui-code);
      border: 1px solid var(--ui-line-soft);
      border-radius: var(--ui-radius-sm);
      font-family: var(--vscode-editor-font-family);
      font-size: 11.5px;
    }
    .parameter-key { color: var(--vscode-descriptionForeground); }
    .parameter-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .table-section { border: 1px solid var(--ui-line-soft); border-radius: var(--ui-radius); overflow: hidden; background: var(--ui-surface-strong); }
    .table-meta {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 5px 12px;
      padding: 9px 12px;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--ui-line-soft);
      font-size: 11.5px;
    }
    .sort-status { color: var(--vscode-foreground); font-weight: 600; }
    .table-wrap { overflow: auto; max-height: calc(100vh - 290px); }
    table { width: max-content; min-width: 100%; border-collapse: separate; border-spacing: 0; white-space: nowrap; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
    th, td { border-bottom: 1px solid var(--ui-line-soft); border-right: 1px solid var(--ui-line-soft); padding: 7px 10px; text-align: left; vertical-align: top; }
    th { position: sticky; top: 0; z-index: 2; color: var(--vscode-foreground); background: var(--vscode-editorGroupHeader-tabsBackground); font-family: var(--vscode-font-family); font-weight: 650; }
    tbody tr:nth-child(even) { background: color-mix(in srgb, var(--vscode-list-hoverBackground) 55%, transparent); }
    tbody tr:hover { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    td { max-width: 560px; overflow: hidden; text-overflow: ellipsis; }
    .row-number { position: sticky; left: 0; z-index: 1; width: 1%; min-width: 44px; color: var(--vscode-descriptionForeground); background: var(--vscode-editorGroupHeader-tabsBackground); text-align: right; user-select: none; }
    th.row-number { z-index: 3; }
    .sort-button { display: inline-flex; align-items: center; gap: 6px; min-height: 0; padding: 0; color: inherit; background: transparent; border: 0; font: inherit; font-weight: 650; cursor: pointer; }
    .sort-button:hover { color: var(--vscode-textLink-foreground); background: transparent; }
    .sort-indicator { color: var(--vscode-descriptionForeground); font-weight: 400; }
    .null-value { color: var(--vscode-descriptionForeground); font-style: italic; }
    .empty-row td { padding: 38px 20px; color: var(--vscode-descriptionForeground); text-align: center; }
    .success-state { display: flex; align-items: flex-start; gap: 14px; padding: 22px; background: var(--ui-surface-strong); border: 1px solid var(--ui-line-soft); border-radius: var(--ui-radius); }
    .success-state h2 { margin-bottom: 4px; font-size: 16px; }
    .success-state p { margin: 0; color: var(--vscode-descriptionForeground); }
    .success-icon { display: grid; place-items: center; flex: 0 0 auto; width: 34px; height: 34px; border-radius: 50%; color: var(--vscode-button-foreground); background: var(--vscode-testing-iconPassed); font-weight: 700; }
  </style>
</head>
<body>
  <div class="page-shell wide result-page">
  <header class="page-header">
    <div class="page-heading">
      <div class="eyebrow">查询结果 · ${escapeHtml(this.metadata.connectionName)}</div>
      <h1>${escapeHtml(title)}</h1>
      <p class="sub">${this.metadata.database ? `数据库 ${escapeHtml(this.metadata.database)} · ` : ''}${formatDuration(this.metadata.durationMs)} · 查询返回的原始顺序</p>
    </div>
    <div class="badge-row">
      ${this.metadata.databaseType ? `<span class="badge accent">${escapeHtml(this.metadata.databaseType)}</span>` : ''}
      <span class="badge" role="status" aria-live="polite"><span id="visible-count">${this.rows.length}</span> 行</span>
      <span class="badge">${this.columns.length} 列</span>
      ${modeControl}
    </div>
  </header>
  <div class="result-commandbar">
    ${hasTable ? `<div class="filter-wrap"><span class="filter-icon" aria-hidden="true">⌕</span><input id="result-filter" type="search" placeholder="筛选当前结果…" aria-label="筛选当前结果" title="筛选只改变当前显示" /></div>` : ''}
    ${hasTable ? `
      <div class="action-group">
        <button data-export="default" data-format="tsv" data-default-label="导出 TSV" title="${escapeHtml(exportHint)}">导出 TSV</button>
        <button class="secondary" data-action="copy" data-default-label="复制 TSV">复制 TSV</button>
        <button class="ghost" data-export="custom" data-format="tsv" data-default-label="其他位置…" title="这次导出时选择位置">其他位置…</button>
      </div>
    ` : ''}
    <div class="action-group secondary">
      <button class="ghost" data-action="copy-feedback" data-default-label="复制 AI 反馈">复制 AI 反馈</button>
      <button class="ghost" data-action="save-feedback" data-default-label="保存 AI 反馈…">保存 AI 反馈…</button>
    </div>
  </div>
  <p id="action-status" class="status-banner action-status" role="status" aria-live="polite"></p>
  <div class="result-notices">${truncatedNotice}</div>
  ${parameterNotice}
  ${hasTable ? `<section class="table-section">${sortScopeNotice}<div class="table-wrap"><table><thead><tr>${header}</tr></thead><tbody>${body || `<tr class="empty-row"><td colspan="${this.columns.length + 1}">查询成功，返回 0 行</td></tr>`}</tbody></table></div></section>` : resultContent}
  </div>
  <script nonce="${scriptNonce}">
    const api = acquireVsCodeApi();
    document.getElementById('data-mode')?.addEventListener('click', () => api.postMessage({ type: 'toggle-mode' }));
    const copyButton = document.querySelector('button[data-action="copy"]');
    const exportButton = document.querySelector('button[data-export="default"]');
    const exportElsewhereButton = document.querySelector('button[data-export="custom"]');
    const copyFeedbackButton = document.querySelector('button[data-action="copy-feedback"]');
    const saveFeedbackButton = document.querySelector('button[data-action="save-feedback"]');
    const actionStatus = document.getElementById('action-status');
    const actionButtons = [copyButton, exportButton, exportElsewhereButton, copyFeedbackButton, saveFeedbackButton];
    let pendingButton;
    const setPending = (button, label) => {
      if (!button) return;
      actionButtons.forEach((action) => { if (action) action.disabled = true; });
      button.textContent = label;
    };
    [copyFeedbackButton, saveFeedbackButton].forEach((button) => button?.addEventListener('click', () => {
      pendingButton = button;
      setPending(button, '正在处理…');
      api.postMessage({ type: button.dataset.action });
    }));
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
    // Sorting only reorders the rows already in the table. It never posts a
    // message, so copy, export and the stored result keep their original order.
    const tbody = document.querySelector('tbody');
    const sortButtons = [...document.querySelectorAll('th button[data-sort-column]')];
    const sortStatus = document.getElementById('sort-status');
    const directionLabels = { ascending: '升序', descending: '降序' };
    let sortColumn = -1;
    let sortDirection = 'none';
    const originalIndex = (row) => Number(row.getAttribute('data-original-index'));
    const sortKey = (row, column) => {
      const cell = row.querySelectorAll('td')[column + 1];
      if (!cell || cell.hasAttribute('data-sort-null')) return { group: 'null', number: 0, text: '' };
      const raw = cell.getAttribute('data-sort-value') ?? '';
      return cell.getAttribute('data-sort-kind') === 'number'
        ? { group: 'number', number: Number(raw), text: raw }
        : { group: 'text', number: 0, text: raw };
    };
    const groupRank = (group) => {
      if (sortDirection === 'descending') {
        return group === 'text' ? 0 : group === 'number' ? 1 : 2;
      }
      return group === 'number' ? 0 : group === 'text' ? 1 : 2;
    };
    const restoreOriginalOrder = () => {
      if (!tbody) return;
      [...rows]
        .sort((left, right) => originalIndex(left) - originalIndex(right))
        .forEach((row) => tbody.appendChild(row));
    };
    const applySort = () => {
      if (!tbody) return;
      const decorated = rows.map((row) => ({ row, index: originalIndex(row), key: sortKey(row, sortColumn) }));
      decorated.sort((left, right) => {
        const groupDelta = groupRank(left.key.group) - groupRank(right.key.group);
        if (groupDelta !== 0) return groupDelta;
        let delta = 0;
        if (left.key.group === 'number') {
          delta = left.key.number - right.key.number;
        } else if (left.key.group === 'text') {
          delta = left.key.text < right.key.text ? -1 : left.key.text > right.key.text ? 1 : 0;
        }
        if (delta !== 0) return sortDirection === 'descending' ? -delta : delta;
        return left.index - right.index;
      });
      decorated.forEach(({ row }) => tbody.appendChild(row));
    };
    const labelOf = (button) => button.getAttribute('data-sort-label') ?? '';
    const updateSortUi = () => {
      sortButtons.forEach((button) => {
        const column = Number(button.getAttribute('data-sort-column'));
        const active = sortDirection !== 'none' && column === sortColumn;
        button.closest('th')?.setAttribute('aria-sort', active ? sortDirection : 'none');
        const indicator = button.querySelector('.sort-indicator');
        if (indicator) indicator.textContent = active ? (sortDirection === 'ascending' ? '↑' : '↓') : '↕';
        const label = labelOf(button);
        button.setAttribute(
          'aria-label',
          active
            ? '按 ' + label + ' 排序：当前' + directionLabels[sortDirection] + '，点击切换为' + (sortDirection === 'ascending' ? '降序' : '原始顺序')
            : '按 ' + label + ' 排序：当前为原始顺序',
        );
      });
      if (!sortStatus) return;
      const current = sortButtons.find((button) => Number(button.getAttribute('data-sort-column')) === sortColumn);
      sortStatus.textContent = sortDirection === 'none' || !current
        ? '原始顺序'
        : '按“' + labelOf(current) + '”' + directionLabels[sortDirection];
    };
    sortButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const column = Number(button.getAttribute('data-sort-column'));
        if (column !== sortColumn) {
          sortColumn = column;
          sortDirection = 'ascending';
        } else {
          sortDirection = sortDirection === 'none' ? 'ascending' : sortDirection === 'ascending' ? 'descending' : 'none';
        }
        if (sortDirection === 'none') {
          sortColumn = -1;
          restoreOriginalOrder();
        } else {
          applySort();
        }
        updateSortUi();
      });
    });
    window.addEventListener('message', ({ data }) => {
      const button = pendingButton ?? (data.action === 'copy' ? copyButton : exportButton);
      pendingButton = undefined;
      if (!button) return;
      const completed = data.type === 'actionComplete';
      const failed = data.type === 'actionFailed';
      button.textContent = completed ? (data.action === 'copy' ? '已复制' : data.action === 'feedback' ? '已完成' : '已导出') : button.dataset.defaultLabel;
      actionStatus.textContent = completed
        ? data.action === 'copy' ? '已复制当前结果。' : data.action === 'feedback' ? '反馈操作已完成。' : '导出已完成。'
        : failed ? '操作未完成，详情请查看通知。' : '已取消。';
      actionStatus.className = 'status-banner action-status' + (failed ? ' bad' : completed ? ' ok' : '');
      window.setTimeout(() => {
        actionButtons.forEach((action) => { if (action) action.disabled = false; });
        button.textContent = button.dataset.defaultLabel;
      }, completed ? 1200 : 0);
    });
  </script>
</body>
</html>`;
  }

  private async export(format: ExportFormat, options: { chooseLocation?: boolean } = {}): Promise<boolean> {
    const projection = this.metadata.protection?.withMode(getDataMode());
    const origin = this.metadata.origin;
    const original = this.metadata.feedback;
    const perform = async (operation?: ExportOperation): Promise<boolean> => {
      const record: FeedbackRecord | undefined = original ? {
        sourceUri: original.sourceUri, currentSource: original.currentSource, startedAt: Date.now(),
        protection: projection,
        value: { name: original.value.name, connectionName: original.value.connectionName,
          databaseType: original.value.databaseType, parameters: original.value.parameters, source: original.value.source,
          action: 'export', status: 'cancelled', submitted: false, generatedAt: '', durationMs: 0,
          rowsRead: 0, totalRows: null, readComplete: false, sessionState: 'not-opened' },
      } : undefined;
      try {
        return await this.exportResult(format, options, operation, record, projection);
      } catch (error) {
        if (record) {
          record.value.status = isQueryCancelled(error) ? 'cancelled' : 'failed';
          record.value.error ??= formatDatabaseError(error);
        }
        throw new Error(protectedMessage(error, projection), { cause: error });
      } finally {
        if (record) {
          record.value.durationMs = Date.now() - record.startedAt;
          record.value.generatedAt = new Date().toISOString();
          rememberFeedback(record);
          if (this.metadata.feedback === original) this.metadata.feedback = record;
        }
      }
    };
    if (!origin) return perform();
    return (await withDocumentOperation(origin.state, origin.documentKey, origin.onStateChanged,
      async (source, operation) => perform({ source, operation }))) ?? false;
  }

  private async exportResult(
    format: ExportFormat, options: { chooseLocation?: boolean }, operation?: ExportOperation, feedback?: FeedbackRecord,
    projection?: ProtectionProjection,
  ): Promise<boolean> {
    const extension = format;
    const title = this.title;
    const columns = this.columns;
    const keptRows = this.result.rows;
    const totalRows = this.result.totalRows;
    // Rows past maxResultRows are counted but discarded, so a truncated result
    // can only be exported by running the statement a second time.
    const rerun = this.result.truncated ? this.metadata.rerun : undefined;
    if (rerun) {
      rerun.state.sessions.validate(rerun.snapshot);
      if (!operation) throw new SessionExpiredError();
      operation.operation.profileId = rerun.snapshot.entry.profileId;
    }

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
      const answer = await untilCancelled(vscode.window.showWarningMessage(
        rerun
          ? this.metadata.readComplete
            ? `将导出 ${totalRows} 行。结果超出了面板保留上限，导出会重新执行一次该查询${parameterNote}。确认继续？`
            : `结果未读完，导出会重新执行一次该查询并写出全部结果${parameterNote}，行数未知、可能很大。确认继续？`
          : `将导出 ${totalRows} 行，文件可能很大。确认继续？`,
        { modal: true },
        '继续导出',
      ), operation?.source.token);
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
        const written = await this.exportTo(vscode.Uri.file(target), columns, keptRows, rerun, operation, feedback, projection);
        if (written === undefined) {
          return false;
        }
        vscode.window.showInformationMessage(`已导出 ${written} 行到 ${target}${modeLabel(projection)}`);
        return true;
      } catch (error) {
        // A database failure or a later file-write failure must not silently
        // run the SQL a second time via the alternate-location fallback.
        if (projection || error instanceof SessionExpiredError || (rerun && rerun.snapshot.entry.revision !== rerun.snapshot.revision)) throw error;
        // A stale or unwritable default directory must never block the export.
        const reason = error instanceof Error ? error.message : String(error);
        void vscode.window.showWarningMessage(`写入默认导出目录失败（${reason}），请选择其他位置。`);
      }
    }

    const defaultUri = vscode.workspace.workspaceFolders?.[0]
      ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, defaultName)
      : undefined;
    const uri = await untilCancelled(vscode.window.showSaveDialog({
      title: `导出 ${title} 查询结果`,
      saveLabel: '导出',
      filters: { [format.toUpperCase()]: [extension] },
      defaultUri,
    }), operation?.source.token);
    if (!uri) {
      return false;
    }

    const written = await this.exportTo(uri, columns, keptRows, rerun, operation, feedback, projection);
    if (written === undefined) {
      return false;
    }
    vscode.window.showInformationMessage(`已导出 ${written} 行到 ${uri.fsPath}${modeLabel(projection)}`);
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
    rerun: ResultRerun | undefined,
    operation?: ExportOperation,
    feedback?: FeedbackRecord,
    projection?: ProtectionProjection,
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
        const exportToken = operation?.source.token ?? token;
        const cancelSubscription = token.onCancellationRequested(() => operation?.source.cancel());
        if (token.isCancellationRequested) operation?.source.cancel();
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
          token: exportToken,
          onProgress: report,
        });
        let writerStarted = false;
        try {
          if (exportToken.isCancellationRequested) throw new QueryCancelledError('导出已取消。');
          if (rerun) rerun.state.sessions.validate(rerun.snapshot);
          writerStarted = true;
          await writer.begin();
          if (rerun) {
            await runForExport(rerun, writer, exportToken, operation!.operation, feedback, projection);
          } else {
            projection?.validate(columns, this.metadata.parameters ?? {}, true);
            for (const row of keptRows) {
              await writer.write(projection?.row(row) ?? row);
            }
          }
          written = await writer.finish();
          if (feedback) {
            Object.assign(feedback.value, { status: 'success', rowsRead: written, totalRows: written,
              readComplete: true, resultFile: uri.scheme === 'file' ? uri.fsPath : uri.toString() });
          }
          if (rerun) rerun.snapshot.revision = rerun.snapshot.entry.revision;
        } catch (error) {
          if (writerStarted) {
            try { await writer.abort(); } catch (cleanupError) {
              if (feedback) { feedback.value.error = formatDatabaseError(error); feedback.value.warning = formatDatabaseError(cleanupError); }
              throw cleanupError;
            }
          }
          if (!isQueryCancelled(error)) {
            throw error;
          }
          cancelled = true;
        } finally {
          cancelSubscription.dispose();
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
    const projection = this.metadata.protection?.withMode(getDataMode());
    const rows = projection ? this.result.rows.map((row) => projection.row(row)) : this.result.rows;
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

// Re-run only on the exact original session and revision, while holding the
// document's operation. Never reconnect or replay initialization SQL here.
async function runForExport(
  rerun: ResultRerun,
  writer: TsvWriter,
  token: vscode.CancellationToken,
  operation: DocumentOperation,
  feedback?: FeedbackRecord,
  projection?: ProtectionProjection,
): Promise<void> {
  const entry = rerun.state.sessions.validate(rerun.snapshot);
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
    const protectedRows = protectSink({
      onColumns: () => undefined,
      onAffectedRows: () => undefined,
      onRow: (row) => { if (feedback) feedback.value.rowsRead = (feedback.value.rowsRead ?? 0) + 1; return writer.write(row); },
    }, projection, rerun.parameters ?? {});
    const session = rerun.state.sessions.startStatement(operation, entry);
    if (feedback) feedback.value.submitted = true;
    await session.execute(rerun.sql, signal, protectedRows.sink);
    protectedRows.check();
    if (token.isCancellationRequested) {
      throw new QueryCancelledError('导出已取消。');
    }
  } finally {
    subscription.dispose();
    listeners.clear();
    if (entry.valid && entry.session?.broken) {
      await rerun.state.sessions.discard(entry);
      void vscode.window.showWarningMessage('导出使用的会话已断开，USE、SET 等会话状态已丢失，请重新初始化后查询。');
    }
    if (feedback) feedback.value.sessionState = entry.valid && !entry.session?.broken ? 'retained' : 'lost';
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
  if (uri.scheme === 'file') {
    const writer = createTsvFileWriter(uri.fsPath, options);
    return {
      async begin() {
        await writer.begin();
        writer.onColumns(columns);
      },
      write: (row) => writer.write(row),
      async finish() {
        const count = await writer.finish();
        if (writer.cleanupWarning) void vscode.window.showWarningMessage(writer.cleanupWarning);
        return count;
      },
      abort: () => writer.abort(),
    };
  }
  const { chunkRows, escapeFormulas, token, onProgress } = options;
  const encodeOptions = { escapeFormulas };
  const header = encodeTsvHeader(columns, encodeOptions);

  let buffer: Row[] = [];
  let writtenRows = 0;
  let parts: Buffer[] = [];

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) {
      return;
    }
    const block = encodeTsvRows(buffer, columns, encodeOptions);
    writtenRows += buffer.length;
    buffer = [];

    parts.push(Buffer.from(block, 'utf8'));
    await yieldToEventLoop();
    onProgress(writtenRows);
  };

  return {
    async begin(): Promise<void> {
      parts = [Buffer.from(header, 'utf8')];
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
      await vscode.workspace.fs.writeFile(uri, Buffer.concat(parts));
      return writtenRows;
    },

    async abort(): Promise<void> {
      buffer = [];
      parts = [];
    },
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  setFeedbackExtensionVersion(context.extension?.packageJSON?.version);
  dataKeys = new DataKeys(context.secrets);
  registerDataCommands(context, dataKeys);
  const manager = new ConnectionManager(context);
  const provider = new ConnectionProvider(manager);
  // Kept only for the current extension host session; never persisted to settings.
  const connectionSession: ConnectionSessionState = {
    documentConnections: new Map(),
    sessions: new DocumentSessions(),
    runningDocuments: new Set(),
    cancellationSources: new Map(),
  };
  activeConnectionSession = connectionSession;
  const connectionStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  connectionStatus.name = 'Doris SQL Lite 连接';
  connectionStatus.command = 'dorisSqlLite.setConnection';
  const refreshConnectionStatus = (): void => updateConnectionStatus(connectionStatus, manager, connectionSession);

  // A running query needs a way out that does not depend on the progress
  // notification still being on screen: dismissing that notification used to
  // leave nothing to click, and the command that does the job is not
  // discoverable by name. This item is shown only while something is running,
  // so it never becomes one more thing to ignore.
  const runningStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  runningStatus.name = 'Doris SQL Lite 查询状态';
  runningStatus.text = '$(stop-circle) 正在执行…';
  runningStatus.tooltip = '当前有 SQL 正在执行。点击取消。';
  runningStatus.command = 'dorisSqlLite.cancelQuery';

  const refreshRunningStatus = (): void => {
    if (connectionSession.cancellationSources.size > 0) {
      runningStatus.show();
    } else {
      runningStatus.hide();
    }
    // Gates the Cancel Query entries in the editor menus, so they appear only
    // when there is something to cancel.
    void vscode.commands.executeCommand(
      'setContext',
      'dorisSqlLite.queryRunning',
      connectionSession.cancellationSources.size > 0,
    );
  };

  // The two items answer different questions ("which connection" vs "is
  // something running"), but both go stale at the same moments.
  const refreshStatusBars = (): void => {
    refreshConnectionStatus();
    refreshRunningStatus();
  };
  refreshStatusBars();

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
  let knownProfiles = new Map(manager.getProfiles().map((profile) => [profile.id, profile]));

  context.subscriptions.push(
    connectionStatus,
    runningStatus,
    vscode.window.registerTreeDataProvider('dorisSqlLiteExplorer', provider),
    vscode.window.onDidChangeActiveTextEditor(refreshConnectionStatus),
    vscode.workspace.onDidCloseTextDocument((document) => {
      void closeDocumentConnection(connectionSession, document.uri.toString());
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('dorisSqlLite.connections')) {
        const next = new Map(manager.getProfiles().map((profile) => [profile.id, profile]));
        for (const [id, previous] of knownProfiles) {
          const current = next.get(id);
          if (!current || !sameConnectionTarget(previous, current) || previous.hiveAuth !== current.hiveAuth) {
            void closeConnectionsForProfile(connectionSession, id);
          }
        }
        knownProfiles = next;
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
          if (!sameConnectionTarget(existing, profile) || existing.hiveAuth !== profile.hiveAuth || info.passwordSaved || info.passwordCleared) {
            sessionClosed = connectionSession.sessions.hasProfile(existing.id);
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
      try {
        await runQuery(manager, connectionSession, normalizeCommandConnectionId(commandArgument), refreshStatusBars);
      } catch (error) {
        showError('执行失败', error);
      }
    }),
    vscode.commands.registerCommand('dorisSqlLite.runBatch', async () => {
      try { await runBatch(manager, connectionSession, refreshStatusBars); }
      catch (error) { showError('分批执行失败', error); }
    }),
    vscode.commands.registerCommand('dorisSqlLite.explainQuery', async () => {
      try {
        await runQuery(manager, connectionSession, undefined, refreshStatusBars, true);
      } catch (error) {
        showError('查看执行计划失败', error);
      }
    }),
    vscode.commands.registerCommand('dorisSqlLite.runQueryToTsv', async () => {
      try {
        await runQuery(manager, connectionSession, undefined, refreshStatusBars, false, true);
      } catch (error) {
        showError('执行并导出失败', error);
      }
    }),
    vscode.commands.registerCommand('dorisSqlLite.copyLastFeedback', async () => {
      try { await copyFeedback(); } catch (error) { showError('复制反馈失败', error); }
    }),
    vscode.commands.registerCommand('dorisSqlLite.saveLastFeedback', async () => {
      try { await saveFeedback(); } catch (error) { showError('保存反馈失败', error); }
    }),
    vscode.commands.registerCommand('dorisSqlLite.resetFileSessions', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'sql') {
        vscode.window.showInformationMessage('请先打开要重置会话的 SQL 文件。');
        return;
      }
      await closeDocumentConnection(connectionSession, editor.document.uri.toString());
      refreshStatusBars();
      vscode.window.showInformationMessage('当前文件的全部数据源会话已重置，USE、SET 等设置需要重新执行。');
    }),
    vscode.commands.registerCommand('dorisSqlLite.cancelQuery', async () => {
      const target = await pickRunningQuery(connectionSession);
      if (!target) {
        vscode.window.showInformationMessage('当前没有正在执行的查询。');
        return;
      }
      if (target.source.token.isCancellationRequested) {
        vscode.window.showInformationMessage(`${target.label} 上的查询正在取消中…`);
        return;
      }
      // Cancel runs through a second connection for KILL QUERY, so it is not
      // instant; saying so here keeps the click from looking ignored if the
      // progress notification has already been dismissed.
      target.source.cancel();
      vscode.window.showInformationMessage(`正在取消 ${target.label} 上的查询…`);
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
      await closeConnectionsForProfile(connectionSession, profile.id);
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
  commentValues: Readonly<Record<string, string>> = {},
  cancellationToken?: vscode.CancellationToken,
  protection?: ProtectionProjection,
): Promise<{ sql: string; used: Record<string, string> } | undefined> {
  if (!configuredSqlParameters()) {
    // Still unwrap $$ escapes: they are part of the template's meaning either way.
    return { sql: unescapeDollarPlaceholders(sql), used: {} };
  }

  const parameters = parseSqlParameters(sql);
  if (parameters.length === 0) {
    return { sql: unescapeDollarPlaceholders(sql), used: {} };
  }

  const load = async (values: Readonly<Record<string, string>>): Promise<void> => {
    if (protection) await loadParameterKeys(values, protection.rules, dataKeys!);
  };
  for (const parameter of parameters) {
    for (const candidate of parameter.candidates) await load({ [parameter.name]: candidate });
  }
  await load(commentValues);
  const transform = protection ? (name: string, value: string) => decodeParameter(name, value, protection.rules, dataKeys!) : undefined;

  // Explicit comment values and inline defaults need no second confirmation.
  // Only unresolved values need the existing parameter form.
  const supplied = resolveSqlParameters(sql, commentValues, transform);
  if (supplied.missing.length === 0) {
    return { sql: supplied.sql, used: { ...supplied.used } };
  }

  const declarations: Record<string, string> = {};
  for (const parameter of parameters) {
    declarations[parameter.name] = protection && Object.hasOwn(protection.rules, parameter.name)
      ? parameter.candidates.map((value) => protection.withMode('encrypted').parameters({ [parameter.name]: value }, true)[parameter.name]).join(', ')
      : declarationText(parameter);
  }
  const initialValues = { ...(parameterState ? readParameterValues(parameterState, documentKey, declarations) : {}), ...commentValues };
  await load(initialValues);

  const decision = await openParameterForm({
    documentLabel,
    sql,
    parameters,
    fixedValues: commentValues,
    protection: protection?.withMode(getDataMode()),
    cancellationToken,
    initialValues,
  });
  if (!decision) {
    return undefined;
  }
  if (decision.action === 'raw') {
    return { sql: unescapeDollarPlaceholders(sql), used: {} };
  }

  await load(decision.values);
  const resolution = resolveSqlParameters(sql, { ...decision.values, ...commentValues }, transform);
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
      const remembered = protection?.withMode('encrypted').parameters(decision.values, true) ?? decision.values;
      await rememberParameterValues(parameterState, documentKey, remembered, declarations);
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
  onStateChanged?: () => void,
  explain = false,
  directExport = false,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const documentKey = editor?.document.uri.toString();
  if (!documentKey || editor?.document.languageId !== 'sql') {
    vscode.window.showInformationMessage('请先打开 SQL 文件。');
    return;
  }
  await withDocumentOperation(connectionSession, documentKey, onStateChanged,
    async (source, operation) => {
      const document = editor.document;
      const version = document.version;
      const origin = {
        path: document.uri.scheme === 'file' ? document.uri.fsPath : document.uri.toString(),
        startLine: 1, endLine: 1,
        savedAtExecution: document.uri.scheme !== 'untitled' && !document.isDirty,
        changedSinceExecution: false as boolean | null,
      };
      const record: FeedbackRecord = {
        sourceUri: document.uri, startedAt: Date.now(),
        protectRaw: declaresProtection(document.getText()),
        currentSource: () => ({ ...origin, changedSinceExecution: document.isClosed ? null : document.version !== version }),
        value: { name: basename(document.fileName), connectionName: '未选择', databaseType: null,
          parameters: {}, source: origin, action: explain ? 'explain' : directExport ? 'export' : 'query',
          status: 'cancelled', submitted: false, generatedAt: '', durationMs: 0, sessionState: 'not-opened' },
      };
      try {
        await executeQuery(manager, connectionSession, source, operation, requestedConnectionId, onStateChanged, explain, directExport, record);
      } catch (error) {
        if (record.value.status !== 'failed') {
          record.value.status = isQueryCancelled(error) ? 'cancelled' : 'failed';
          record.value.error = formatDatabaseError(error);
        }
        if (record.protectRaw && getDataMode() === 'encrypted') throw new Error(protectedMessage(error, record.protection, true), { cause: error });
        throw error;
      } finally {
        record.value.durationMs = Date.now() - record.startedAt;
        record.value.generatedAt = new Date().toISOString();
        rememberFeedback(record);
      }
    });
}

function notifyWithFeedback(
  message: string, feedback: FeedbackRecord | undefined, kind: 'info' | 'error' = 'info',
): void {
  const actions = ['复制 AI 反馈', '保存 AI 反馈…'];
  const notice = kind === 'error'
    ? vscode.window.showErrorMessage(message, ...actions)
    : vscode.window.showInformationMessage(message, ...actions);
  void notice.then(async (answer) => {
    try {
      if (answer === actions[0]) await copyFeedback(feedback);
      if (answer === actions[1]) await saveFeedback(feedback);
    } catch (error) { showError('反馈操作失败', error); }
  });
}

function tokenSignal(token: vscode.CancellationToken): CancelSignal {
  return {
    get requested() { return token.isCancellationRequested; },
    get reason() { return token.isCancellationRequested ? 'user' as const : undefined; },
    onRequest: (listener) => token.onCancellationRequested(listener),
  };
}

async function runBatch(
  manager: ConnectionManager, state: ConnectionSessionState, onStateChanged?: () => void,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'sql') {
    void vscode.window.showInformationMessage('请先打开 SQL 文件。');
    return;
  }
  const document = editor.document;
  const text = document.getText();
  const version = document.version;
  const documentKey = document.uri.toString();
  await withDocumentOperation(state, documentKey, onStateChanged, async (source, operation) => {
    const origin = {
      path: document.uri.scheme === 'file' ? document.uri.fsPath : document.uri.toString(),
      startLine: 1, endLine: text.split('\n').length,
      savedAtExecution: document.uri.scheme === 'file' && !document.isDirty,
      changedSinceExecution: false as boolean | null,
    };
    const feedback: FeedbackRecord = {
      sourceUri: document.uri, startedAt: Date.now(),
      protectRaw: declaresProtection(text),
      currentSource: () => ({ ...origin, changedSinceExecution: document.isClosed ? null : document.version !== version }),
      value: {
        name: basename(document.fileName), connectionName: '未选择', databaseType: null,
        parameters: {}, source: origin, action: 'batch', status: 'cancelled', submitted: false,
        generatedAt: '', durationMs: 0, sessionState: 'not-opened',
      },
    };
    const details = feedback.value;
    const entries = new Map<string, SessionEntry>();
    try {
      if (document.uri.scheme !== 'file') throw new Error('分批执行需要先把 SQL 保存为本地文件，以便定位参数脚本。');
      if (vscode.workspace.isTrusted === false) throw new Error('参数脚本需要在受信任的工作区运行，请先核对并信任当前工作区。');
      if (!configuredSqlParameters()) throw new Error('分批执行需要启用 dorisSqlLite.sqlParameters，以明确解析每批参数。');
      const definition = readBatchDefinition(text);
      const protections = new Map<string, ProtectionProjection>();
      feedback.batchProtections = protections;
      const batchMode = getDataMode();
      const hasProtection = [...definition.init, ...definition.steps].some((step) => step.encryption && Object.keys(step.encryption).length);
      if (hasProtection && !dataKeys) throw new Error('字段加密密钥存储尚未就绪，请重新加载窗口。');
      const batchKey = hasProtection ? await dataKeys!.active() : undefined;
      for (const step of [...definition.init, ...definition.steps]) {
        if (batchKey && step.encryption && Object.keys(step.encryption).length) {
          protections.set(step.name!, createProtection(step.encryption, step.requiredEncryption ?? [], batchKey,
            (id) => dataKeys!.lookup(id), batchMode));
        }
      }
      definition.script = resolve(dirname(document.uri.fsPath), definition.script);
      const profiles = manager.getProfiles();
      // Resolve explicit connections before running the script. One optional
      // picker supplies the fallback for every step without its own directive.
      for (const step of [...definition.init, ...definition.steps]) {
        if (step.connection) findDirectiveConnection(profiles, step.connection);
      }
      const fallback = [...definition.init, ...definition.steps].some((step) => !step.connection)
        ? await chooseProfile(manager, state.documentConnections.get(documentKey) ?? state.defaultConnectionId, source.token)
        : undefined;
      if (source.token.isCancellationRequested || ([...definition.init, ...definition.steps].some((step) => !step.connection) && !fallback)) return;
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: `分批执行 ${details.name}`, cancellable: true,
      }, async (progress, token) => {
        const batchProgress = new BatchProgress((message) => progress.report({ message }), {
          parameters: (record) => protections.get(record.name)?.withMode(getDataMode()).parameters(record.parameters) ?? record.parameters,
        });
        const modeSubscription = onDataModeChange(() => batchProgress.refresh());
        const cancelProgress = source.token.onCancellationRequested(() => batchProgress.setPhase('cancelling'));
        const subscription = token.onCancellationRequested(() => source.cancel());
        if (token.isCancellationRequested) source.cancel();
        const signal = tokenSignal(source.token);
        try {
          const output = await runBatchScript(definition.script, dirname(document.uri.fsPath), signal);
          if (signal.requested) throw new QueryCancelledError();
          const batches = parseBatchParameters(output);
          for (const step of [...definition.init, ...definition.steps]) {
            if (!step.encryption || !Object.keys(step.encryption).length) continue;
            for (const parameter of parseSqlParameters(step.sql)) {
              for (const candidate of parameter.candidates) await loadParameterKeys({ [parameter.name]: candidate }, step.encryption, dataKeys!);
            }
            await loadParameterKeys(step.parameters ?? {}, step.encryption, dataKeys!);
            if (definition.steps.includes(step)) {
              for (const batch of batches) await loadParameterKeys(batch, step.encryption, dataKeys!);
            }
          }
          const task = prepareBatchTask(definition, batches, (context) => context.connection
            ? findDirectiveConnection(profiles, context.connection) : fallback!,
          (step, name, value) => step.encryption ? decodeParameter(name, value, step.encryption, dataKeys!) : value);
          const batch = createBatchFeedback(task);
          // Verify every record can be projected before any initialization or write.
          for (const record of batch.records) protections.get(record.name)?.withMode('encrypted').parameters(record.parameters);
          details.batch = batch;
          const allSteps = [...task.init, ...task.steps];
          details.connectionName = [...new Set(allSteps.map((step) => step.profile.name))].join('、');
          const types = [...new Set(allSteps.map((step) => step.profile.type))];
          details.databaseType = types.length === 1 ? types[0] : null;
          const parameterText = (index: number): string => {
            const value = batch.records.filter((record) => record.batchIndex === index).map((record) => ({
              name: record.name, parameters: protections.get(record.name)?.withMode(getDataMode()).parameters(record.parameters) ?? record.parameters,
            }));
            const json = JSON.stringify(value);
            return json.length > 1500 ? json.slice(0, 1500) + '…（参数较长，已截断显示）' : json;
          };
          const describe = (steps: typeof allSteps): string => steps.length
            ? steps.map((step) => `${step.name} → ${step.profile.name} (${step.profile.type})`).join('\n') : '无';
          batchProgress.prepare(batch);
          const answer = await untilCancelled(vscode.window.showWarningMessage(
            `即将顺序执行 ${task.batches.length} 批 SQL`,
            { modal: true, detail: [
              `SQL：${origin.path}`, `参数脚本：${task.script}`,
              `初始化（仅一次）：\n${describe(task.init)}`, `每批步骤（按顺序）：\n${describe(task.steps)}`,
              `首批参数：${parameterText(1)}`, `末批参数：${parameterText(task.batches.length)}`,
              '失败或取消后停止后续步骤；已完成写入不会自动回滚、补偿或重试。执行期间请保持 VS Code 打开。',
            ].join('\n\n') }, '开始执行',
          ), source.token);
          if (answer !== '开始执行' || signal.requested) return;
          feedback.startedAt = Date.now();
          batchProgress.startTask();
          details.status = await runBatchTask(task, batch, signal, async (step, sql, record) => {
            let entry = entries.get(step.profile.id);
            try {
              if (signal.requested) throw new QueryCancelledError();
              const current = manager.getProfiles().find((item) => item.id === step.profile.id);
              if (!current || !sameConnectionTarget(step.profile, current) || step.profile.hiveAuth !== current.hiveAuth) {
                throw new Error('连接配置已变化，分批任务已停止；不会重新连接或重放初始化。');
              }
              operation.profileId = step.profile.id;
              if (entry) state.sessions.validate(state.sessions.snapshot(entry));
              else {
                batchProgress.setPhase('connecting', step.profile.name);
                entry = await state.sessions.open(operation, step.profile.id,
                  () => manager.open(step.profile, configuredQueryIdleTimeoutMs(), source.token));
                entries.set(step.profile.id, entry);
              }
              record.sessionState = 'retained';
              if (signal.requested) throw new QueryCancelledError();
              const session = state.sessions.startStatement(operation, entry);
              batchProgress.setPhase('executing');
              record.submitted = true;
              details.submitted = true;
              return await session.execute(sql, signal, {
                // MySQL announces columns from an event callback. Rejecting
                // there would throw outside the async execution promise.
                onColumns: () => undefined,
                onRow: () => { throw new Error('分批步骤返回了结果行，任务已停止；请使用普通查询查看结果。'); },
                onAffectedRows: () => undefined,
              });
            } finally {
              if (entry) {
                if (entry.valid && entry.session?.broken) await state.sessions.discard(entry);
                record.sessionState = entry.valid && !entry.session?.broken ? 'retained' : 'lost';
              }
            }
          }, (record) => batchProgress.setStep(record));
          details.needsReview = batch.records.some((record) => record.needsReview);
          details.error = batch.records.find((record) => record.status === 'failed' || record.status === 'cancelled')?.error ?? batch.error;
        } finally {
          batchProgress.dispose();
          modeSubscription.dispose();
          cancelProgress.dispose();
          subscription.dispose();
        }
      });
    } catch (error) {
      details.status = source.token.isCancellationRequested || isQueryCancelled(error) ? 'cancelled' : 'failed';
      details.error = formatDatabaseError(error);
    } finally {
      details.durationMs = Date.now() - feedback.startedAt;
      details.generatedAt = new Date().toISOString();
      const states = details.batch?.records.map((record) => record.sessionState) ?? [];
      details.sessionState = states.includes('lost') ? 'lost' : states.includes('retained') ? 'retained' : 'not-opened';
      rememberFeedback(feedback);
      const stopped = details.batch?.records.find((record) => record.status === 'failed' || record.status === 'cancelled');
      const completion = details.batch ? `已完成 ${details.batch.completedBatches}/${details.batch.batchCount} 批` : '尚未提交 SQL';
      const position = stopped ? `；停止于${stopped.phase === 'init' ? '初始化' : `第 ${stopped.batchIndex} 批`}「${stopped.name}」` : '';
      notifyWithFeedback(
        `${details.name}：${details.status === 'success' ? '分批执行成功' : details.status === 'cancelled' ? '分批执行已取消' : '分批执行失败'}，${completion}${position}，耗时 ${formatDuration(details.durationMs)}。`
          + (details.needsReview ? ' 已提交步骤的写入结果需核对。' : '')
          + (details.error && (details.status === 'failed' || details.error.includes('进程树终止失败'))
            ? ` ${protectedMessage(details.error, undefined, feedback.protectRaw)}` : ''),
        feedback, details.status === 'failed' ? 'error' : 'info',
      );
    }
  });
}

async function chooseDirectExportPath(
  output: string | undefined,
  sourceUri: vscode.Uri,
  title: string,
  token: vscode.CancellationToken,
): Promise<string | undefined> {
  let target: string;
  if (output) {
    target = resolveOutputPath(output, sourceUri.scheme === 'file' ? sourceUri.fsPath : undefined);
  } else {
    const fileName = buildExportFileName(title, 'tsv', new Date());
    const directory = configuredExportDirectory();
    if (directory) {
      if (!isAbsolute(directory)) throw new Error('默认导出目录需要是绝对路径，请重新选择默认目录。');
      target = resolveOutputPath(join(directory, fileName));
    } else {
      const defaultUri = sourceUri.scheme === 'file'
        ? vscode.Uri.file(join(dirname(sourceUri.fsPath), fileName))
        : undefined;
      const uri = await untilCancelled(vscode.window.showSaveDialog({
        title: `执行并导出 ${title}`,
        saveLabel: '执行并导出 TSV',
        filters: { TSV: ['tsv'] },
        defaultUri,
      }), token);
      if (!uri || token.isCancellationRequested) return undefined;
      if (uri.scheme !== 'file') throw new Error('执行并导出需要文件系统路径，所选位置不支持流式写入。');
      target = resolveOutputPath(uri.fsPath);
    }
  }
  if (token.isCancellationRequested) return undefined;
  // Resolve and prepare the destination before any SQL is submitted. Do not
  // recover by executing again at another location after a later failure.
  await mkdir(dirname(target), { recursive: true });
  return token.isCancellationRequested ? undefined : target;
}

async function executeQuery(
  manager: ConnectionManager,
  connectionSession: ConnectionSessionState,
  cancelSource: vscode.CancellationTokenSource,
  operation: DocumentOperation,
  requestedConnectionId?: string,
  onStateChanged?: () => void,
  explain = false,
  directExport = false,
  feedback?: FeedbackRecord,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'sql') {
    vscode.window.showInformationMessage('请先打开 SQL 文件。');
    return;
  }
  const sourceUri = editor.document.uri;
  const sourceLabel = basename(editor.document.fileName);
  const context = resolveStatementContext(
    editor.document.getText(),
    editor.document.offsetAt(editor.selection.start),
    editor.document.offsetAt(editor.selection.end),
  );
  const sql = context?.sql;
  const protection = context ? await statementProtection(context) : undefined;
  if (feedback) { feedback.protection = protection; feedback.protectRaw = protection !== undefined; }
  const details = feedback?.value;
  if (details && context) {
    details.name = context.name ?? sourceLabel;
    details.source.startLine = context.line;
    details.source.endLine = context.endLine;
    details.connectionName = context.connection ?? '未选择';
    details.action = explain ? 'explain' : directExport || context.output ? 'export' : 'query';
  }
  if (!sql?.trim()) {
    vscode.window.showInformationMessage('没有可执行的 SQL。');
    return;
  }
  if (!editor.selection.isEmpty && hasMultipleStatements(sql)) {
    vscode.window.showInformationMessage('当前一次只支持执行一条 SQL，请分开选择后再执行。');
    return;
  }

  const documentKey = editor.document.uri.toString();

  // ${...} is resolved before a connection is chosen, so cancelling the panel
  // cannot leave a session behind. Substituting here, after the statement was
  // picked out of the document, is what keeps a value containing `;` or `--`
  // from ever moving a statement boundary.
  const prepared = await prepareStatementSql(
    sql,
    documentKey,
    sourceLabel,
    context?.parameters,
    cancelSource.token,
    protection,
  );
  if (!prepared || operation.cancelled) {
    return;
  }
  const statement = prepared.sql;
  if (details) details.parameters = prepared.used;
  // Verify the parameter output before submitting any SQL.
  protection?.withMode('encrypted').parameters(prepared.used);
  const outputMode = !explain && (directExport || context?.output !== undefined);
  if (outputMode) assertDirectExportSql(statement);

  const id = requestedConnectionId
    ?? connectionSession.documentConnections.get(documentKey)
    ?? connectionSession.defaultConnectionId;
  const profile = context?.connection
    ? findDirectiveConnection(manager.getProfiles(), context.connection)
    : await chooseProfile(manager, id, cancelSource.token);
  if (!profile || operation.cancelled) {
    return;
  }
  if (details) {
    details.connectionName = profile.name;
    details.databaseType = profile.type;
  }
  // Build before touching the session: malformed / already-EXPLAIN input must
  // never fall through to executing the original statement.
  const explainSql = explain ? buildExplainSql(statement, profile.type) : undefined;
  const targetPath = outputMode
    ? await chooseDirectExportPath(context?.output, sourceUri, context?.name ?? profile.name, cancelSource.token)
    : undefined;
  if (outputMode && (!targetPath || operation.cancelled)) return;
  connectionSession.documentConnections.set(documentKey, profile.id);
  connectionSession.defaultConnectionId = profile.id;
  onStateChanged?.();

  const startedAt = Date.now();
  if (feedback) feedback.startedAt = startedAt;
  let progressHandle: vscode.Progress<{ message?: string }> | undefined;
  let entry: SessionEntry | undefined;
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
        title: `${explain ? '查看计划' : outputMode ? '执行并导出' : '执行'} ${context?.name ?? profile.name}`,
        cancellable: true,
      },
      async (progress, token) => {
        progressHandle = progress;
        if (token.isCancellationRequested) cancelSource.cancel();
        subscriptions.push(token.onCancellationRequested(() => cancelSource.cancel()));
        let fileWriter: TsvFileWriter | undefined;
        try {
          if (targetPath) {
            fileWriter = createTsvFileWriter(targetPath, {
              chunkRows: configuredExportChunkRows(),
              escapeFormulas: configuredEscapeFormulas(),
              token: cancelSource.token,
              onProgress: (rows) => progress.report({ message: `已写入 ${rows} 行…` }),
            });
            progress.report({ message: '准备输出文件…' });
            await fileWriter.begin();
          }
          progress.report({ message: '准备当前文件的数据源会话…' });
          entry = await connectionSession.sessions.open(operation, profile.id, async () => {
            const current = manager.getProfiles().find((item) => item.id === profile.id);
            if (!current || !sameConnectionTarget(profile, current) || profile.hiveAuth !== current.hiveAuth) {
              throw new Error('连接配置已变化，请重新执行。');
            }
            return manager.open(profile, configuredQueryIdleTimeoutMs(), cancelSource.token);
          });
          if (details) details.sessionState = 'retained';
          if (operation.cancelled || token.isCancellationRequested) throw new QueryCancelledError();
          if (explainSql !== undefined) {
            // Plans are text, often many rows long. Never apply the result
            // display/read cap or append a LIMIT to this request.
            const collector = createRowCollector(Number.MAX_SAFE_INTEGER);
            progress.report({ message: '正在获取完整执行计划…' });
            const session = connectionSession.sessions.startStatement(operation, entry);
            if (details) {
              details.submitted = true;
              details.explainKind = explainSql.split('\n')[0];
            }
            await session.execute(explainSql, signal, collector);
            if (signal.requested || operation.cancelled) return;
            const result = collector.toView();
            const plan = planText(result.columns, result.rows);
            if (details) details.status = 'success';
            if (feedback) feedback.planText = plan;
            openPlanPanel({
              name: context?.name ?? sourceLabel,
              source: `${details?.source.path ?? sourceUri.toString()}:${context?.line ?? 1}-${context?.endLine ?? 1}`,
              connectionName: profile.name,
              databaseType: profile.type,
              parameters: prepared.used,
              sql: statement,
              explainSql,
              plan,
              generatedAt: new Date().toISOString(),
            }, sourceUri, feedback);
            return;
          }
          if (fileWriter) {
            const writer = fileWriter;
            let noResultSet = false;
            progress.report({ message: '正在执行并读取完整结果…' });
            const session = connectionSession.sessions.startStatement(operation, entry);
            if (details) { details.submitted = true; details.rowsRead = 0; details.totalRows = null; details.readComplete = false; }
            const protectedRows = protectSink({
              onColumns: (columns) => writer.onColumns(columns),
              onRow: (row) => { if (details) details.rowsRead = (details.rowsRead ?? 0) + 1; return writer.write(row); },
              onAffectedRows: () => { noResultSet = true; },
            }, protection, prepared.used);
            await session.execute(statement, signal, protectedRows.sink);
            protectedRows.check();
            throwIfCancelled(cancelSource.token);
            if (details) { details.readComplete = true; details.totalRows = details.rowsRead ?? 0; }
            if (noResultSet) throw new Error('语句没有返回可导出的结果集，未生成 TSV 文件。');
            const written = await writer.finish();
            if (details) { details.status = 'success'; details.resultFile = targetPath; details.warning = writer.cleanupWarning; }
            void vscode.window.showInformationMessage(
              `已导出 ${written} 行到 ${targetPath}，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒。${modeLabel(protection)}`,
              '复制 AI 反馈', '保存 AI 反馈…',
            ).then(async (answer) => {
              try {
                if (answer === '复制 AI 反馈') await copyFeedback(feedback);
                if (answer === '保存 AI 反馈…') await saveFeedback(feedback);
              } catch (error) { showError('反馈操作失败', error); }
            });
            if (writer.cleanupWarning) void vscode.window.showWarningMessage(protectedMessage(writer.cleanupWarning, protection));
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
          // Push the cap into the statement itself so the server bounds the work
          // while it is still planning, instead of being interrupted after it has
          // already produced the answer. Measured on real servers this is worth
          // 5-12x on Spark and 3.5-8x on Doris for ORDER BY; interrupting is
          // nearly worthless there because the answer is materialised before the
          // first row is sent. applyRowLimit refuses anything it cannot rewrite
          // safely (writes, multi-statement, an existing LIMIT), and those fall
          // back to the interrupt path below.
          const injectedSql =
            readLimit === undefined ? undefined : applyRowLimit(statement, readLimit);
          const executedSql = injectedSql ?? statement;
          if (details) {
            details.rowsRead = 0; details.totalRows = null; details.readComplete = false;
            details.previewLimit = injectedSql !== undefined ? readLimit : undefined;
          }
          let reportedRows = 0;
          const collector = createRowCollector(
            maxRows,
            readLimit === undefined ? {} : { onLimitReached: () => stop('limit') },
          );
          const protectedRows = protectSink({
            onColumns: (columns) => { collector.onColumns(columns); if (details) details.hasResultSet = true; },
            onAffectedRows: (count) => { collector.onAffectedRows(count); if (details) details.hasResultSet = false; },
            onRow: (row) => {
              collector.onRow(row);
              const total = collector.totalRows();
              if (details) details.rowsRead = total;
              if (total - reportedRows >= 1000) {
                reportedRows = total;
                progress.report({ message: `已读取 ${total} 行…` });
              }
            },
          }, protection, prepared.used, false);

          progress.report({ message: '正在执行…' });
          const session = connectionSession.sessions.startStatement(operation, entry);
          if (details) details.submitted = true;
          const summary = await session.execute(executedSql, signal, protectedRows.sink);
          protectedRows.check();
          if (details) details.hasResultSet = summary.hasResultSet;
          // Only a user cancel abandons the result here. A limit stop returns
          // the rows on purpose: they are exactly what was asked for.
          if ((stopReason === 'user' || operation.cancelled) && summary.hasResultSet !== false) {
            if (details) {
              details.status = 'cancelled';
              details.needsReview = details.submitted && details.hasResultSet !== true;
            }
            notifyWithFeedback(`已取消「${context?.name ?? profile.name}」，耗时 ${formatDuration(Date.now() - startedAt)}。`
              + (details?.needsReview ? ' 已提交操作的完成情况需核对。' : ''), feedback);
            return;
          }
          // An injected statement ends by itself, so stopReason stays undefined
          // and there is nothing in the interrupt path to mark the answer as cut
          // short. Without this the panel would report the cap as if it were the
          // real total. Reaching the cap is the only evidence available: a result
          // that happens to end exactly at the cap reads as truncated, which is
          // the safe direction to be wrong in.
          const capReached =
            injectedSql !== undefined &&
            readLimit !== undefined &&
            collector.totalRows() >= readLimit;
          const view = collector.toView();
          view.hasResultSet = summary.hasResultSet ?? view.hasResultSet;
          view.affectedRows = summary.affectedRows;
          const readComplete = stopReason !== 'limit' && !capReached;
          // An injected LIMIT can stop exactly at the panel cap, without an
          // extra row reaching the collector. The full answer is still unknown
          // and must be rerun for an export instead of saving only that preview.
          if (!readComplete) view.truncated = true;
          if (details) {
            details.status = 'success'; details.readComplete = readComplete;
            details.hasResultSet = view.hasResultSet;
            details.totalRows = details.readComplete ? view.totalRows : null;
            details.displayedRows = view.rows.length; details.truncated = view.truncated;
            if (!view.hasResultSet) details.affectedRows = view.affectedRows;
          }
          if (!view.hasResultSet) {
            notifyWithFeedback(
              `「${context?.name ?? profile.name}」执行成功，${view.affectedRows === null ? '影响行数未知' : `影响 ${view.affectedRows} 行`}，耗时 ${formatDuration(Date.now() - startedAt)}。`, feedback,
            );
            return;
          }
          // Check supported types before publishing a result. Keep only the
          // bounded raw preview in the extension host for subsequent toggles.
          for (const row of view.rows) protection?.withMode('encrypted').row(row);
          ResultPanel.open(view, {
            connectionName: profile.name,
            databaseType: profile.type,
            statementName: context?.name,
            database: profile.database,
            durationMs: Date.now() - startedAt,
            maxRows,
            parameters: prepared.used,
            feedback,
            protection,
            // False when the answer was cut short, so the panel can say "已读取
            // N 行" instead of claiming an exact total it does not have.
            readComplete,
            // The resolved statement, not the template, and deliberately not the
            // injected one: an export that has to run the query again wants every
            // row, so it must not inherit this run's cap.
            origin: { state: connectionSession, documentKey, onStateChanged },
            rerun: { state: connectionSession, documentKey, onStateChanged, snapshot: connectionSession.sessions.snapshot(entry), sql: statement,
              protection, parameters: prepared.used },
          });
        } catch (error) {
          if (fileWriter) {
            try {
              await fileWriter.abort();
            } catch (cleanupError) {
              const reason = error instanceof Error ? error.message : String(error);
              const cleanupReason = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
              if (details) { details.status = 'failed'; details.error = formatDatabaseError(error); details.warning = cleanupReason; details.temporaryFile = fileWriter.temporaryPath; }
              showError('执行并导出未完成', new Error(protectedMessage(`${reason}；${cleanupReason}`, protection)));
              return;
            }
          }
          if (isQueryCancelled(error) || (!outputMode && isCancelled(token))) {
            if (details) { details.status = 'cancelled'; details.needsReview = !outputMode && details.submitted && details.hasResultSet !== true; }
            notifyWithFeedback(outputMode
              ? '已取消执行并导出，未完成的临时文件已清理。'
              : `已取消「${context?.name ?? profile.name}」，耗时 ${formatDuration(Date.now() - startedAt)}。`
                + (details?.needsReview ? ' 已提交操作的完成情况需核对。' : ''), feedback);
          } else {
            if (details) {
              details.status = 'failed'; details.error = formatDatabaseError(error);
              details.needsReview = !outputMode && details.submitted && (entry?.session?.broken === true || classifyDatabaseError(error).kind === 'network');
            }
            if (outputMode) showError(`执行并导出失败（${profile.name}）`, new Error(protectedMessage(error, protection)));
            else notifyWithFeedback(
              `「${context?.name ?? profile.name}」执行失败，耗时 ${formatDuration(Date.now() - startedAt)}。 ${protectedMessage(error, protection)}`
                + (details?.needsReview ? ' 已提交操作的写入结果需核对。' : ''), feedback, 'error',
            );
          }
        }
      },
    );
  } finally {
    for (const subscription of subscriptions) {
      subscription.dispose();
    }
    cancelListeners.clear();
    // A session that already had to be torn down (or was dropped to cancel) must
    // not be handed to the next statement.
    if (entry?.valid && entry.session?.broken) {
      await connectionSession.sessions.discard(entry);
      void vscode.window.showWarningMessage('连接会话已断开，USE、SET 等状态已丢失，请重新初始化后查询；失败语句不会自动重试。');
    }
    if (details && entry) details.sessionState = entry.valid && !entry.session?.broken ? 'retained' : 'lost';
  }
}

// The status bar item and the menu entries are global, so with two files
// running at once there is no way to tell which query was meant. Prefer the
// document the user is looking at, then the only one there is, then ask.
async function pickRunningQuery(
  connectionSession: ConnectionSessionState,
): Promise<{ label: string; source: vscode.CancellationTokenSource } | undefined> {
  const entries = [...connectionSession.cancellationSources.entries()];
  if (entries.length === 0) {
    return undefined;
  }

  const activeKey = vscode.window.activeTextEditor?.document.uri.toString();
  const preferred = entries.find(([key]) => key === activeKey);
  if (preferred) {
    return { label: documentLabel(preferred[0]), source: preferred[1] };
  }
  if (entries.length === 1) {
    return { label: documentLabel(entries[0][0]), source: entries[0][1] };
  }

  const candidates = entries.map(([key, source]) => ({ label: documentLabel(key), source }));
  return vscode.window.showQuickPick(candidates, { title: '取消哪个文件上的查询？' });
}

function documentLabel(documentKey: string): string {
  const uri = vscode.Uri.parse(documentKey);
  return basename(uri.path) || documentKey;
}

async function chooseProfile(
  manager: ConnectionManager,
  preferredId?: string,
  token?: vscode.CancellationToken,
): Promise<ConnectionProfile | undefined> {
  const profiles = manager.getProfiles();
  if (preferredId) {
    const preferred = profiles.find((profile) => profile.id === preferredId);
    if (preferred) {
      return preferred;
    }
  }
  if (profiles.length === 0) {
    vscode.window.showInformationMessage('还没有连接，请先执行 Doris SQL Lite: 添加连接。');
    return undefined;
  }
  const selected = await vscode.window.showQuickPick(
    profiles.map((profile) => ({
      label: profile.name,
      description: `${profile.type} · ${profile.host}:${profile.port}`,
      detail: `${profile.username}${profile.database ? ` · ${profile.database}` : ' · 未指定数据库'} · ${tlsTooltip(profile)}`,
      profile,
    })),
    { title: '选择数据库连接' }, token,
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
