import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { ProtectionProjection } from './dataProtection';
import {
  resolveSqlParameters,
  type SqlParameter,
} from './sqlParameters';
import { WEBVIEW_BASE_CSS, escapeHtml } from './webviewTheme';

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
  // Values declared in SQL comments stay authoritative in the missing-value form.
  fixedValues?: Readonly<Record<string, string>>;
  protection?: ProtectionProjection;
  cancellationToken?: vscode.CancellationToken;
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
  if (inputs.cancellationToken?.isCancellationRequested) return Promise.resolve(undefined);
  // One panel at a time: a second run while the first is unresolved would have
  // no way to tell the two apart. Revealing the existing one is the honest
  // behaviour, and the caller simply does not run.
  if (currentPanel) {
    currentPanel.reveal(currentPanel.viewColumn ?? vscode.ViewColumn.Active, false);
    return Promise.resolve(undefined);
  }
  const formInputs = { ...inputs, protection: inputs.protection?.withMode(inputs.protection.mode) };

  const panel = vscode.window.createWebviewPanel(
    'dorisSqlLiteParameterForm',
    `查询参数 · ${inputs.documentLabel}`,
    vscode.ViewColumn.Active,
    { enableScripts: true },
  );
  currentPanel = panel;

  return new Promise<ParameterFormDecision | undefined>((resolve) => {
    let settled = false;
    const cancellation: { subscription?: vscode.Disposable } = {};
    const finish = (decision: ParameterFormDecision | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(decision);
      panel.dispose();
    };

    panel.onDidDispose(() => {
      cancellation.subscription?.dispose();
      if (currentPanel === panel) {
        currentPanel = undefined;
      }
      if (!settled) {
        settled = true;
        resolve(undefined);
      }
    });

    panel.webview.html = renderParameterForm(formInputs);

    panel.webview.onDidReceiveMessage((message: { type?: string; values?: unknown }) => {
      if (message.type === 'cancel') {
        finish(undefined);
        return;
      }
      if (message.type === 'run') {
        finish({ action: 'execute', values: pickValues(formInputs, message.values) });
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
          ...previewFor(formInputs, pickValues(formInputs, message.values)),
        });
      }
    });
    cancellation.subscription = inputs.cancellationToken?.onCancellationRequested(() => finish(undefined));
    if (inputs.cancellationToken?.isCancellationRequested) finish(undefined);
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
    const fixed = inputs.fixedValues && Object.hasOwn(inputs.fixedValues, parameter.name)
      ? inputs.fixedValues[parameter.name] : undefined;
    Object.defineProperty(values, parameter.name, {
      value: fixed !== undefined ? projectValue(inputs, parameter.name, fixed)
        : typeof value === 'string' ? value : '', enumerable: true,
    });
  }
  return values;
}

const PROTECTED_SQL_NOTICE = '当前显示字段密文。切换到字段原文模式后重新打开参数表单，即可查看 SQL 原文和替换预览。';

function encryptedForm(inputs: ParameterFormInputs): boolean {
  return inputs.protection?.mode === 'encrypted' && Object.keys(inputs.protection.rules).length > 0;
}

function projectValue(inputs: ParameterFormInputs, name: string, value: string): string {
  return inputs.protection ? inputs.protection.parameters({ [name]: value }, true)[name] : value;
}

function previewFor(inputs: ParameterFormInputs, values: Readonly<Record<string, string>>): {
  sql: string;
  missing: string[];
} {
  const resolution = resolveSqlParameters(inputs.sql, values);
  return { sql: encryptedForm(inputs) ? PROTECTED_SQL_NOTICE : resolution.sql, missing: [...resolution.missing] };
}

// ------------------------------------------------------------------ rendering

interface DisplayParameter {
  name: string;
  value: string;
  candidates: readonly string[];
  labels: readonly (string | undefined)[];
  source: 'used' | 'default' | 'choose' | 'needed' | 'comment';
}

function displayParameters(inputs: ParameterFormInputs): DisplayParameter[] {
  return inputs.parameters.map((parameter) => {
    const remembered = Object.hasOwn(inputs.initialValues, parameter.name) ? inputs.initialValues[parameter.name] : undefined;
    const inlineDefault = parameter.candidates.length === 1 ? parameter.candidates[0] : undefined;
    const fixed = inputs.fixedValues && Object.hasOwn(inputs.fixedValues, parameter.name)
      ? inputs.fixedValues[parameter.name] : undefined;
    const value = fixed ?? remembered ?? inlineDefault;
    const source: DisplayParameter['source'] =
      fixed !== undefined ? 'comment' : remembered !== undefined
        ? 'used'
        : inlineDefault !== undefined
          ? 'default'
          : parameter.candidates.length > 1
            ? 'choose'
            : 'needed';
    return {
      name: parameter.name,
      value: value === undefined ? '' : projectValue(inputs, parameter.name, value),
      candidates: parameter.candidates.map((candidate) => projectValue(inputs, parameter.name, candidate)),
      labels: encryptedForm(inputs) ? [] : parameter.labels,
      source,
    };
  });
}

const SOURCE_LABEL: Record<DisplayParameter['source'], string> = {
  comment: '来自 SQL 注释，请在编辑器修改',
  used: '上次使用',
  default: '来自 SQL 默认值',
  choose: '请选择',
  needed: '需要填写',
};

export function renderParameterForm(inputs: ParameterFormInputs): string {
  const nonce = randomUUID().replace(/-/g, '');
  const parameters = displayParameters(inputs);
  const hasProtection = inputs.protection !== undefined && Object.keys(inputs.protection.rules).length > 0;

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
    <div class="param-card">
      <div class="param-head">
        <span class="param-name">${escapeHtml(parameter.name)}</span>
        <span class="badge ${parameter.source === 'needed' ? 'warning' : parameter.source === 'comment' ? 'accent' : ''}">${SOURCE_LABEL[parameter.source]}</span>
      </div>
      <input type="text" spellcheck="false" autocomplete="off" data-value="${escapeHtml(parameter.name)}"${listAttribute} value="${escapeHtml(parameter.value)}"${parameter.source === 'comment' ? ' readonly' : ''} />
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
    ${WEBVIEW_BASE_CSS}
    .parameter-stack { display: grid; gap: 10px; }
    .param-card { padding: 11px 12px; background: var(--ui-surface-strong); border: 1px solid var(--ui-line-soft); border-radius: var(--ui-radius-sm); }
    .param-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
    .param-card .param-name { color: var(--vscode-foreground); font-family: var(--vscode-editor-font-family); font-size: 12.5px; font-weight: 650; }
    .param-card input { font-family: var(--vscode-editor-font-family); }
    #preview { max-height: 260px; white-space: pre-wrap; word-break: break-word; }
    #status { margin-top: 12px; }
    .action-bar button { min-width: 82px; }
  </style>
</head>
<body>
  <div class="page-shell">
  <header class="page-header">
    <div class="page-heading">
      <div class="eyebrow">Doris SQLTools Lite · ${escapeHtml(inputs.documentLabel)}</div>
      <h1>确认本次 SQL 参数</h1>
      <p class="sub">参数替换在本机完成。核对实际发送的 SQL 后，再提交给数据库。</p>
    </div>
    <div class="badge-row">
      <span class="badge">${parameters.length} 个参数</span>
      <span class="badge ${hasProtection ? 'accent' : ''}">${hasProtection ? (encryptedForm(inputs) ? '字段密文' : '字段原文') : '普通输出'}</span>
    </div>
  </header>

  <section class="section">
    <div class="section-header">
      <span class="section-title">参数值</span>
      <span class="section-note">注释值只读，其余值可在本次执行前调整</span>
    </div>
    <div class="parameter-stack">${rows}</div>
  </section>

  <section class="section">
    <div class="section-header">
      <span class="section-title">实际发送的 SQL</span>
      <span class="section-note">引用、引号和替换结果以这里为准</span>
    </div>
    <pre id="preview" class="code-surface">${encryptedForm(inputs) ? PROTECTED_SQL_NOTICE : ''}</pre>
  </section>

  <p id="status" class="status-banner" role="status" aria-live="polite"></p>

  <div class="action-bar">
    <button class="secondary" id="b-raw">原样发送</button>
    <span class="spacer"></span>
    <button class="secondary" id="b-cancel">取消</button>
    <button id="b-run">执行</button>
  </div>
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
      statusEl.className = 'status-banner' + (missing.length > 0 ? ' bad' : '');
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
