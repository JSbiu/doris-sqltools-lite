import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import {
  resolveSqlParameters,
  unescapeDollarPlaceholders,
  type SqlParameter,
} from './sqlParameters';

// The parameter panel shown before a statement that contains ${...} runs.
//
// It exists because a placeholder is a question, and answering it wrong is quiet:
// Spark resolves ${x} against its own conf and turns an unknown name into an
// empty string, so a mistyped timestamp does not fail -- it silently becomes
// NULL and the query returns nothing. Showing the substituted SQL before the
// query leaves the machine is therefore the point of this panel, not a nicety.

export interface ParameterFormInputs {
  // Used in the title so several SQL files are told apart.
  documentLabel: string;
  // The chosen statement, exactly as written in the editor.
  sql: string;
  parameters: readonly SqlParameter[];
  // Remembered values, already filtered against the template's declarations.
  initialValues: Readonly<Record<string, string>>;
}

export interface ParameterFormDecision {
  // 'execute' substitutes the values; 'raw' sends the template untouched, which
  // is how a `${spark.conf.key}` reference reaches Spark's own substitution.
  action: 'execute' | 'raw';
  values: Record<string, string>;
}

let currentPanel: vscode.WebviewPanel | undefined;

export function openParameterForm(
  inputs: ParameterFormInputs,
): Promise<ParameterFormDecision | undefined> {
  // One panel at a time: a second run while the first is unresolved would have
  // no way to tell the two apart. Revealing the existing one is the honest
  // behaviour, and the caller simply does not run.
  if (currentPanel) {
    currentPanel.reveal(currentPanel.viewColumn ?? vscode.ViewColumn.Active, false);
    return Promise.resolve(undefined);
  }

  const panel = vscode.window.createWebviewPanel(
    'dorisSqlLiteParameterForm',
    `查询参数 · ${inputs.documentLabel}`,
    vscode.ViewColumn.Active,
    { enableScripts: true },
  );
  currentPanel = panel;

  return new Promise<ParameterFormDecision | undefined>((resolve) => {
    let settled = false;
    const finish = (decision: ParameterFormDecision | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(decision);
      panel.dispose();
    };

    panel.onDidDispose(() => {
      if (currentPanel === panel) {
        currentPanel = undefined;
      }
      if (!settled) {
        settled = true;
        resolve(undefined);
      }
    });

    panel.webview.html = renderParameterForm(inputs);

    panel.webview.onDidReceiveMessage((message: { type?: string; values?: unknown }) => {
      if (message.type === 'cancel') {
        finish(undefined);
        return;
      }
      if (message.type === 'run') {
        finish({ action: 'execute', values: pickValues(inputs, message.values) });
        return;
      }
      if (message.type === 'raw') {
        finish({ action: 'raw', values: {} });
        return;
      }
      if (message.type === 'preview') {
        // The substitution lives in one place only -- here. Echoing it back for
        // display keeps the webview from carrying a second implementation that
        // could drift from the real one.
        void panel.webview.postMessage({
          type: 'preview',
          ...previewFor(inputs.sql, pickValues(inputs, message.values)),
        });
      }
    });
  });
}

// Only strings for parameters this statement actually declares can come back, so
// a malformed or stale message cannot inject anything into the SQL.
function pickValues(
  inputs: ParameterFormInputs,
  raw: unknown,
): Record<string, string> {
  const source = (raw ?? {}) as Record<string, unknown>;
  const values: Record<string, string> = {};
  for (const parameter of inputs.parameters) {
    const value = source[parameter.name];
    values[parameter.name] = typeof value === 'string' ? value : '';
  }
  return values;
}

function previewFor(sql: string, values: Readonly<Record<string, string>>): {
  sql: string;
  missing: string[];
} {
  const resolution = resolveSqlParameters(unescapeDollarPlaceholders(sql), values);
  return { sql: resolution.sql, missing: [...resolution.missing] };
}

// ------------------------------------------------------------------ rendering

interface DisplayParameter {
  name: string;
  value: string;
  candidates: readonly string[];
  labels: readonly (string | undefined)[];
  source: 'used' | 'default' | 'choose' | 'needed';
}

function displayParameters(inputs: ParameterFormInputs): DisplayParameter[] {
  return inputs.parameters.map((parameter) => {
    const remembered = inputs.initialValues[parameter.name];
    const inlineDefault = parameter.candidates.length === 1 ? parameter.candidates[0] : undefined;
    const value = remembered ?? inlineDefault ?? '';
    const source: DisplayParameter['source'] =
      remembered !== undefined
        ? 'used'
        : inlineDefault !== undefined
          ? 'default'
          : parameter.candidates.length > 1
            ? 'choose'
            : 'needed';
    return {
      name: parameter.name,
      value,
      candidates: parameter.candidates,
      labels: parameter.labels,
      source,
    };
  });
}

const SOURCE_LABEL: Record<DisplayParameter['source'], string> = {
  used: '上次使用',
  default: '来自 SQL 默认值',
  choose: '请选择',
  needed: '需要填写',
};

function renderParameterForm(inputs: ParameterFormInputs): string {
  const nonce = randomUUID().replace(/-/g, '');
  const parameters = displayParameters(inputs);

  const rows = parameters
    .map((parameter) => {
      const listId = `cand-${parameter.name.replace(/[^A-Za-z0-9_-]/g, '_')}`;
      const options = parameter.candidates
        .map((candidate) => `<option value="${escapeHtml(candidate)}"></option>`)
        .join('');
      const list = parameter.candidates.length > 1 ? `<datalist id="${listId}">${options}</datalist>` : '';
      const listAttribute = parameter.candidates.length > 1 ? ` list="${listId}"` : '';
      const labels = parameter.labels
        .map((label, index) => (label ? `${parameter.candidates[index]} = ${label}` : ''))
        .filter(Boolean)
        .join('、');

      return `
    <div class="param">
      <div class="head">
        <span class="name">${escapeHtml(parameter.name)}</span>
        <span class="tag tag-${parameter.source}">${SOURCE_LABEL[parameter.source]}</span>
      </div>
      <input type="text" spellcheck="false" autocomplete="off" data-value="${escapeHtml(parameter.name)}"${listAttribute} value="${escapeHtml(parameter.value)}" />
      ${list}
      ${labels ? `<p class="hint">可选：${escapeHtml(labels)}</p>` : ''}
    </div>`;
    })
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 18px 20px 96px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); font-size: 13px; line-height: 1.6; }
    h1 { margin: 0 0 4px; font-size: 15px; font-weight: 500; }
    .sub { margin: 0 0 16px; color: var(--vscode-descriptionForeground); }
    .card { padding: 14px 16px; margin-bottom: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
    .param + .param { margin-top: 12px; }
    .head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
    .name { font-family: var(--vscode-editor-font-family, monospace); }
    .tag { font-size: 12px; color: var(--vscode-descriptionForeground); }
    .tag-needed { color: var(--vscode-editorWarning-foreground); }
    input[type="text"] { width: 100%; min-height: 28px; padding: 5px 8px; font-family: var(--vscode-editor-font-family, monospace); font-size: 13px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; outline: none; }
    input:focus { border-color: var(--vscode-focusBorder); }
    .hint { margin: 4px 0 0; color: var(--vscode-descriptionForeground); font-size: 12px; }
    #preview { margin: 0; padding: 10px; max-height: 220px; overflow: auto; white-space: pre-wrap; word-break: break-all; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; background: var(--vscode-textCodeBlock-background, var(--vscode-editorWidget-background)); border-radius: 4px; }
    #status { margin: 0; color: var(--vscode-descriptionForeground); min-height: 0; }
    #status.bad { color: var(--vscode-errorForeground, var(--vscode-editorError-foreground)); }
    .bar { position: sticky; bottom: 0; display: flex; align-items: center; gap: 8px; padding: 12px 0 0; background: var(--vscode-editor-background); }
    .spacer { flex: 1 1 auto; }
    button { min-height: 28px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 1px solid transparent; border-radius: 2px; padding: 5px 14px; cursor: pointer; font-family: inherit; font-size: 13px; }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button:disabled { cursor: default; opacity: .65; }
  </style>
</head>
<body>
  <h1>查询参数</h1>
  <p class="sub">替换在本地完成，值只保存在本机（不进 settings.json、不参与 Settings Sync）。</p>

  <section class="card">${rows}
  </section>

  <section class="card">
    <p class="sub" style="margin:0 0 8px;">实际发送的 SQL</p>
    <pre id="preview"></pre>
  </section>

  <p id="status"></p>

  <div class="bar">
    <button class="secondary" id="b-raw">原样发送</button>
    <span class="spacer"></span>
    <button class="secondary" id="b-cancel">取消</button>
    <button id="b-run">执行</button>
  </div>

  <script nonce="${nonce}">
    const api = acquireVsCodeApi();
    const id = (name) => document.getElementById(name);
    const runButton = id('b-run');
    const statusEl = id('status');
    const previewEl = id('preview');
    const VALUE_INPUTS = Array.from(document.querySelectorAll('[data-value]'));

    const collect = () => {
      const values = {};
      VALUE_INPUTS.forEach((input) => {
        values[input.getAttribute('data-value')] = input.value;
      });
      return values;
    };

    const refresh = () => {
      api.postMessage({ type: 'preview', values: collect() });
    };

    const applyPreview = (message) => {
      previewEl.textContent = message.sql;
      const missing = message.missing || [];
      runButton.disabled = missing.length > 0;
      statusEl.className = missing.length > 0 ? 'bad' : '';
      statusEl.textContent = missing.length > 0
        ? '还有 ' + missing.length + ' 个参数没有值：' + missing.join('、') + '。填写后再执行，或点「原样发送」。'
        : '';
    };

    VALUE_INPUTS.forEach((input) => {
      input.addEventListener('input', refresh);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !runButton.disabled) {
          api.postMessage({ type: 'run', values: collect() });
        }
      });
    });

    runButton.addEventListener('click', () => api.postMessage({ type: 'run', values: collect() }));
    id('b-raw').addEventListener('click', () => api.postMessage({ type: 'raw' }));
    id('b-cancel').addEventListener('click', () => api.postMessage({ type: 'cancel' }));

    window.addEventListener('message', (event) => {
      const message = event.data || {};
      if (message.type === 'preview') {
        applyPreview(message);
      }
    });

    refresh();
    if (VALUE_INPUTS.length > 0) {
      VALUE_INPUTS[0].focus();
    }
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
