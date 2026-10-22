import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { buildPlanReview, type PlanSnapshot } from './executionPlan';

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function openPlanPanel(snapshot: PlanSnapshot, sourceUri: vscode.Uri): void {
  const panel = vscode.window.createWebviewPanel(
    'dorisSqlLitePlan', `Plan · ${snapshot.name}`, vscode.ViewColumn.Beside,
    { enableScripts: true },
  );
  const nonce = randomUUID().replace(/-/g, '');
  const review = buildPlanReview(snapshot);
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
p { color: var(--vscode-descriptionForeground); }
pre { white-space: pre; overflow: auto; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); padding: 12px; border: 1px solid var(--vscode-panel-border); }
</style></head><body>
<h2>${escapeHtml(snapshot.name)}</h2>
<div class="toolbar"><span>${escapeHtml(snapshot.databaseType)} · ${escapeHtml(snapshot.connectionName)}</span>
<button id="copy-review" type="button">复制 AI 审核材料</button>
<button id="save-review" type="button">保存 AI 审核材料…</button><span id="action-status" role="status"></span></div>
<p>按原 SQL 生成，未追加预览 LIMIT。修改 SQL、参数或连接后请重新生成计划。</p>
<pre>${escapeHtml(snapshot.plan || '服务端未返回计划文本。')}</pre>
<details><summary>本次 SQL 与参数</summary><pre>${escapeHtml(snapshot.sql)}</pre><pre>${escapeHtml(JSON.stringify(snapshot.parameters, null, 2))}</pre></details>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const copy = document.getElementById('copy-review');
const save = document.getElementById('save-review');
const status = document.getElementById('action-status');
function request(type) { copy.disabled = true; save.disabled = true; status.textContent = ''; vscode.postMessage({type}); }
copy.addEventListener('click', () => request('copy'));
save.addEventListener('click', () => request('save'));
window.addEventListener('message', (event) => { copy.disabled = false; save.disabled = false; status.textContent = event.data.status || ''; });
</script></body></html>`;
  const subscription = panel.webview.onDidReceiveMessage(async (message: { type?: unknown }) => {
    try {
      if (message.type === 'copy') {
        await vscode.env.clipboard.writeText(review);
        await panel.webview.postMessage({ status: '已复制' });
      } else if (message.type === 'save') {
        const safeName = [...snapshot.name].map((character) => character.charCodeAt(0) < 32 ? '_' : character).join('')
          .replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').slice(0, 80) || 'query';
        const folder = sourceUri.scheme === 'untitled'
          ? vscode.workspace.workspaceFolders?.[0]?.uri
          : vscode.Uri.joinPath(sourceUri, '..');
        const target = await vscode.window.showSaveDialog({
          defaultUri: folder ? vscode.Uri.joinPath(folder, `query-${safeName}.plan.md`) : undefined,
          filters: { Markdown: ['md'] }, saveLabel: '保存审核材料',
        });
        if (target) {
          if (target.toString() === sourceUri.toString()) throw new Error('请选择其他文件，不能覆盖原 SQL 文件。');
          await vscode.workspace.fs.writeFile(target, Buffer.from(review, 'utf8'));
          await panel.webview.postMessage({ status: '已保存' });
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target), { preview: false, preserveFocus: true });
        } else {
          await panel.webview.postMessage({ status: '' });
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await panel.webview.postMessage({ status: `操作失败：${reason}` });
    }
  });
  panel.onDidDispose(() => subscription.dispose());
}
