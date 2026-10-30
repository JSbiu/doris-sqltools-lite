import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { buildPlanReview, type PlanSnapshot } from './executionPlan';
import { copyFeedback, saveFeedback, type FeedbackRecord } from './feedbackActions';
import { getDataMode, onDataModeChange } from './dataProtection';

const PROTECTED_PLAN_NOTICE = '加密模式下不展示计划和 SQL 原文，请切换到明文模式查看。';

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function openPlanPanel(snapshot: PlanSnapshot, sourceUri: vscode.Uri, feedback?: FeedbackRecord): void {
  const panel = vscode.window.createWebviewPanel(
    'dorisSqlLitePlan', `Plan · ${snapshot.name}`, vscode.ViewColumn.Beside,
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
body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); padding: 16px; }
.toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 7px 12px; cursor: pointer; }
button:disabled { opacity: .6; cursor: wait; }
button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
.data-mode { font-weight: bold; border: 2px solid var(--vscode-focusBorder); }
p { color: var(--vscode-descriptionForeground); }
pre { white-space: pre; overflow: auto; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); padding: 12px; border: 1px solid var(--vscode-panel-border); }
</style></head><body>
<h2>${escapeHtml(snapshot.name)}</h2>
<div class="toolbar"><span>${escapeHtml(snapshot.databaseType)} · ${escapeHtml(snapshot.connectionName)}</span>
${projection ? `<button id="toggle-data-mode" class="data-mode" type="button">显示模式：${encrypted ? '加密 · 切换明文' : '明文 · 切换加密'}</button>` : ''}
<button id="copy-review" type="button">复制 AI 反馈</button>
<button id="save-review" type="button">保存 AI 反馈…</button>
<button id="copy-full" type="button">复制完整材料</button><span id="action-status" role="status"></span></div>
<p>按原 SQL 生成，未追加预览 LIMIT。修改 SQL、参数或连接后请重新生成计划。</p>
<pre>${escapeHtml(encrypted ? PROTECTED_PLAN_NOTICE : snapshot.plan || '服务端未返回计划文本。')}</pre>
<details><summary>SQL 来源与参数</summary><pre>${escapeHtml(record.value.source.path)}:${record.value.source.startLine}-${record.value.source.endLine}</pre><pre>${escapeHtml(JSON.stringify(parameters, null, 2))}</pre></details>
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
          ? encrypted ? '已复制简短反馈（加密模式）' : '已复制简短反馈（完整计划见文件）' : '已取消' });
      } else if (message.type === 'save') {
        const saved = await saveFeedback(record);
        await panel.webview.postMessage({ status: saved ? encrypted ? '已保存加密反馈' : '已保存反馈和完整计划' : '已取消' });
      } else if (message.type === 'copy-full') {
        if (encrypted) {
          await panel.webview.postMessage({ status: '加密模式下不能复制完整材料，请切换到明文模式后重试。' });
          return;
        }
        await vscode.env.clipboard.writeText(buildPlanReview(snapshot));
        await panel.webview.postMessage({ status: '已复制完整材料' });
      } else if (message.type === 'toggle-data-mode' && protection) {
        await vscode.commands.executeCommand('dorisSqlLite.toggleDataMode');
        await panel.webview.postMessage({ status: '' });
      }
    } catch (error) {
      const reason = protection && getDataMode() === 'encrypted' ? '加密模式下仅提供结构化错误，请在明文模式查看详情。'
        : error instanceof Error ? error.message : String(error);
      await panel.webview.postMessage({ status: `操作失败：${reason}` });
    }
  });
  const modeSubscription = protection ? onDataModeChange(render) : undefined;
  panel.onDidDispose(() => { subscription.dispose(); modeSubscription?.dispose(); });
}
