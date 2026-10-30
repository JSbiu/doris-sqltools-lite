import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { buildPlanReview, type PlanSnapshot } from './executionPlan';
import { copyFeedback, saveFeedback, type FeedbackRecord } from './feedbackActions';
import { getDataMode, onDataModeChange } from './dataProtection';
import { WEBVIEW_BASE_CSS, escapeHtml } from './webviewTheme';

const PROTECTED_PLAN_NOTICE = '当前显示字段密文。切换到字段原文模式后，可查看完整计划。';

export function openPlanPanel(snapshot: PlanSnapshot, sourceUri: vscode.Uri, feedback?: FeedbackRecord): void {
  const panel = vscode.window.createWebviewPanel(
    'dorisSqlLitePlan', `执行计划 · ${snapshot.name}`, vscode.ViewColumn.Beside,
    { enableScripts: true },
  );
  const nonce = randomUUID().replace(/-/g, '');
  const source = { path: sourceUri.scheme === 'file' ? sourceUri.fsPath : sourceUri.toString(),
    startLine: 1, endLine: 1, savedAtExecution: sourceUri.scheme !== 'untitled', changedSinceExecution: null };
  const record: FeedbackRecord = feedback ?? {
    sourceUri, currentSource: () => source, startedAt: Date.now(), planText: snapshot.plan,
    value: { name: snapshot.name, connectionName: snapshot.connectionName, databaseType: snapshot.databaseType,
      parameters: snapshot.parameters, source, action: 'explain', status: 'success', submitted: true,
      generatedAt: snapshot.generatedAt, durationMs: 0, explainKind: snapshot.explainSql.split('\n')[0] },
  };
  const protection = record.protection && Object.keys(record.protection.rules).length > 0 ? record.protection : undefined;
  const renderContent = (): void => {
    const projection = protection?.withMode(getDataMode());
    const encrypted = projection?.mode === 'encrypted';
    const parameters = projection ? projection.parameters(snapshot.parameters) : snapshot.parameters;
    panel.webview.html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>执行计划</title>
<style>
${WEBVIEW_BASE_CSS}
.plan-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 14px; }
.plan-toolbar .spacer { flex: 1 1 auto; }
.plan-code { max-height: calc(100vh - 330px); min-height: 220px; white-space: pre; }
.meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.meta-card { padding: 10px 12px; background: var(--ui-surface-strong); border: 1px solid var(--ui-line-soft); border-radius: var(--ui-radius-sm); }
.meta-card .label { display: block; margin-bottom: 4px; color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
.meta-card code { word-break: break-all; }
.source-line { margin: 0; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); word-break: break-all; }
details summary { cursor: pointer; font-weight: 600; }
details[open] summary { margin-bottom: 10px; }
#action-status { min-height: 18px; margin-top: 10px; }
</style></head><body>
<div class="page-shell wide">
<header class="page-header">
  <div class="page-heading">
    <div class="eyebrow">执行计划 · ${escapeHtml(snapshot.databaseType)}</div>
    <h1>${escapeHtml(snapshot.name)}</h1>
    <p class="sub">按原 SQL 生成，未追加预览 LIMIT。修改 SQL、参数或连接后重新获取计划。</p>
  </div>
  <div class="badge-row">
    <span class="badge accent">${escapeHtml(snapshot.databaseType)}</span>
    <span class="badge">${escapeHtml(snapshot.connectionName)}</span>
    ${projection ? `<button id="toggle-data-mode" class="ghost" type="button">${encrypted ? '字段密文 · 切换原文' : '字段原文 · 切换密文'}</button>` : ''}
  </div>
</header>
<div class="plan-toolbar">
  <button id="copy-review" type="button">复制 AI 反馈</button>
  <button id="save-review" class="secondary" type="button">保存 AI 反馈…</button>
  <span class="spacer"></span>
  <button id="copy-full" class="ghost" type="button">复制完整材料</button>
</div>
<section class="section">
  <div class="section-header"><span class="section-title">计划正文</span><span class="section-note">${encrypted ? '字段密文模式' : '保留原始缩进'}</span></div>
  <pre class="code-surface plan-code">${escapeHtml(encrypted ? PROTECTED_PLAN_NOTICE : snapshot.plan || '服务端未返回计划文本。')}</pre>
</section>
<section class="section compact">
  <details><summary>SQL 来源与参数</summary>
    <div class="meta-grid">
      <div class="meta-card"><span class="label">SQL 来源</span><p class="source-line">${escapeHtml(record.value.source.path)}:${record.value.source.startLine}-${record.value.source.endLine}</p></div>
      <div class="meta-card"><span class="label">实际参数</span><pre class="code-surface">${escapeHtml(JSON.stringify(parameters, null, 2))}</pre></div>
    </div>
  </details>
</section>
<p id="action-status" class="status-banner" role="status" aria-live="polite"></p>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const copy = document.getElementById('copy-review');
const save = document.getElementById('save-review');
const full = document.getElementById('copy-full');
const mode = document.getElementById('toggle-data-mode');
const status = document.getElementById('action-status');
function request(type) { copy.disabled = true; save.disabled = true; full.disabled = true; if (mode) mode.disabled = true; status.textContent = ''; vscode.postMessage({type}); }
copy.addEventListener('click', () => request('copy'));
save.addEventListener('click', () => request('save'));
full.addEventListener('click', () => request('copy-full'));
if (mode) mode.addEventListener('click', () => request('toggle-data-mode'));
window.addEventListener('message', (event) => { copy.disabled = false; save.disabled = false; full.disabled = false; if (mode) mode.disabled = false; status.textContent = event.data.status || ''; });
</script></body></html>`;
  };
  const render = (): void => {
    try { renderContent(); }
    catch (error) {
      if (!protection) throw error;
      panel.webview.html = '<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\';"></head><body>受保护计划暂时无法显示，请通过状态栏切换模式或重新生成计划。</body></html>';
    }
  };
  render();
  const subscription = panel.webview.onDidReceiveMessage(async (message: { type?: unknown }) => {
    try {
      const encrypted = protection && getDataMode() === 'encrypted';
      if (message.type === 'copy') {
        const copied = await copyFeedback(record);
        await panel.webview.postMessage({ status: copied
          ? encrypted ? '已复制简短反馈（字段密文）' : '已复制简短反馈（完整计划见文件）' : '已取消' });
      } else if (message.type === 'save') {
        const saved = await saveFeedback(record);
        await panel.webview.postMessage({ status: saved ? encrypted ? '已保存字段密文反馈' : '已保存反馈和完整计划' : '已取消' });
      } else if (message.type === 'copy-full') {
        if (encrypted) {
          await panel.webview.postMessage({ status: '复制完整材料前，请切换到字段原文模式。' });
          return;
        }
        await vscode.env.clipboard.writeText(buildPlanReview(snapshot));
        await panel.webview.postMessage({ status: '已复制完整材料' });
      } else if (message.type === 'toggle-data-mode' && protection) {
        await vscode.commands.executeCommand('dorisSqlLite.toggleDataMode');
        await panel.webview.postMessage({ status: '' });
      }
    } catch (error) {
      const reason = protection && getDataMode() === 'encrypted' ? '切换到字段原文模式后，可查看详细错误。'
        : error instanceof Error ? error.message : String(error);
      await panel.webview.postMessage({ status: `操作失败：${reason}` });
    }
  });
  const modeSubscription = protection ? onDataModeChange(render) : undefined;
  panel.onDidDispose(() => { subscription.dispose(); modeSubscription?.dispose(); });
}
