import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type mysql from 'mysql2/promise';
import type { ConnectionProfile } from './connectionSecurity';
import { ConnectionManager, showError } from './connectionManager';

import {
  DEFAULT_PORTS,
  draftFromProfile,
  draftToProfile,
  emptyDraft,
  parseConnectionUrl,
  validateDraft,
  type ConnectionDraft,
  type ConnectionFormMode,
  type DraftField,
  type ParsedConnectionUrl,
} from './connectionDraft';

// ------------------------------------------------------------- form plumbing

export interface ConnectionFormOptions {
  context: vscode.ExtensionContext;
  manager: ConnectionManager;
  mode: ConnectionFormMode;
  existing?: ConnectionProfile;
  onSaved: (profile: ConnectionProfile, info: ConnectionFormResult) => void | Promise<void>;
}

export interface ConnectionFormResult {
  passwordSaved: boolean;
  passwordCleared: boolean;
}

let currentPanel: vscode.WebviewPanel | undefined;

export function openConnectionForm(options: ConnectionFormOptions): void {
  if (currentPanel) {
    currentPanel.reveal(currentPanel.viewColumn ?? vscode.ViewColumn.Active, false);
    return;
  }

  const { context, manager, mode, existing } = options;
  const draft = existing ? draftFromProfile(existing) : emptyDraft();
  const title = mode === 'edit' && existing ? `编辑连接 · ${existing.name}` : '添加连接';

  const panel = vscode.window.createWebviewPanel(
    'dorisSqlLiteConnectionForm',
    title,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  currentPanel = panel;
  panel.onDidDispose(() => {
    if (currentPanel === panel) {
      currentPanel = undefined;
    }
  });

  const post = (message: FormOutbound): Thenable<boolean> => panel.webview.postMessage(message);
  let busy = false;

  panel.webview.html = renderForm(draft, mode);

  panel.webview.onDidReceiveMessage(async (message: FormInbound) => {
    if (message.type === 'cancel') {
      panel.dispose();
      return;
    }

    if (message.type === 'parseUrl') {
      const parsed = parseConnectionUrl(text(message.url));
      await post({ type: 'parsed', parsed });
      return;
    }

    if (busy) {
      return;
    }

    if (message.type === 'test') {
      busy = true;
      try {
        await post({ type: 'testing' });
        const result = await testDraft(manager, coerceDraft(message.draft), existing);
        await post({ type: 'testResult', ok: result.ok, message: result.message });
      } finally {
        busy = false;
      }
      return;
    }

    if (message.type === 'save') {
      busy = true;
      try {
        const next = coerceDraft(message.draft);
        const profile = draftToProfile(next, existing?.id ?? randomUUID());
        if (!profile) {
          await post({ type: 'issues', ...validateDraft(next, manager.getProfiles(), existing?.id) });
          return;
        }
        const issues = validateDraft(next, manager.getProfiles(), existing?.id);
        if (Object.keys(issues.errors).length > 0) {
          await post({ type: 'issues', ...issues });
          return;
        }

        const profiles = manager.getProfiles();
        const nextProfiles = existing
          ? profiles.map((item) => (item.id === existing.id ? profile : item))
          : [...profiles, profile];
        await manager.saveProfiles(nextProfiles);

        const passwordSaved = next.password.length > 0;
        const passwordCleared = next.clearSavedPassword;
        if (passwordCleared) {
          await manager.deletePassword(profile.id);
          if (passwordSaved) {
            await manager.savePassword(profile.id, next.password);
          }
        } else if (passwordSaved) {
          await manager.savePassword(profile.id, next.password);
        }

        await options.onSaved(profile, { passwordSaved, passwordCleared });
        panel.dispose();
      } catch (error) {
        showError(mode === 'edit' ? '保存连接失败' : '添加连接失败', error);
      } finally {
        busy = false;
      }
    }
  });

  context.subscriptions.push(panel);
}

type FormOutbound =
  | { type: 'parsed'; parsed: ParsedConnectionUrl | undefined }
  | { type: 'testing' }
  | { type: 'testResult'; ok: boolean; message: string }
  | { type: 'issues'; errors: Partial<Record<DraftField, string>>; warnings: string[] };

type FormInbound =
  | { type: 'cancel' }
  | { type: 'parseUrl'; url?: unknown }
  | { type: 'test'; draft?: unknown }
  | { type: 'save'; draft?: unknown };

function coerceDraft(raw: unknown): ConnectionDraft {
  const source = (raw ?? {}) as Record<string, unknown>;
  return {
    name: text(source.name),
    type: text(source.type) === 'MySQL' ? 'MySQL' : 'Doris',
    host: text(source.host),
    port: text(source.port),
    database: text(source.database),
    username: text(source.username),
    // Never trimmed: leading or trailing spaces can be part of a password.
    password: typeof source.password === 'string' ? source.password : '',
    ssl: source.ssl === true,
    clearSavedPassword: source.clearSavedPassword === true,
  };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function testDraft(
  manager: ConnectionManager,
  draft: ConnectionDraft,
  existing?: ConnectionProfile,
): Promise<{ ok: boolean; message: string }> {
  const profile = draftToProfile(draft, existing?.id ?? 'test-only');
  if (!profile) {
    return { ok: false, message: '请先补全名称、主机、端口和用户名。' };
  }

  let password = draft.password;
  if (!password && existing) {
    password = (await manager.readPassword(existing.id)) ?? '';
  }
  if (!password) {
    return {
      ok: false,
      message: existing
        ? '本机没有保存该连接的密码，请填写后再测试。'
        : '请填写密码后再测试（测试不会保存密码）。',
    };
  }

  let connection: mysql.Connection | undefined;
  try {
    connection = await manager.connect(profile, password);
    await connection.query('SELECT 1');
    return { ok: true, message: `连接成功：${profile.host}:${profile.port}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message };
  } finally {
    await connection?.end().catch(() => undefined);
  }
}

// ------------------------------------------------------------------ rendering

function renderForm(draft: ConnectionDraft, mode: ConnectionFormMode): string {
  const nonce = randomUUID().replace(/-/g, '');
  const isEdit = mode === 'edit';
  const heading = isEdit ? '编辑连接' : '添加连接';
  const subtitle = isEdit
    ? '只改动需要改的字段。密码留空表示保持已保存的密码不变。'
    : '密码保存到 VS Code SecretStorage，不会写进 settings.json。';
  const passwordHint = isEdit
    ? '留空 = 保持已保存的密码；填写 = 覆盖。'
    : '留空则先不保存，首次连接时会提示输入。';

  const clearPasswordBlock = isEdit
    ? `
    <label class="check">
      <input type="checkbox" id="f-clear-pwd" />
      保存时清除已保存的密码
    </label>
    <p class="hint">勾选后下次连接会重新询问密码。若同时填写了新密码，则以新密码为准。</p>`
    : '';

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
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; }
    .field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .field.wide { grid-column: 1 / -1; }
    label { display: block; }
    .hint { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 0; }
    label > .hint { display: inline; margin-left: 6px; }
    input[type="text"], input[type="password"], select {
      width: 100%; min-height: 28px; padding: 5px 8px; font-family: inherit; font-size: 13px;
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; outline: none;
    }
    input:focus, select:focus { border-color: var(--vscode-focusBorder); }
    .err { color: var(--vscode-errorForeground, var(--vscode-editorError-foreground)); font-size: 12px; min-height: 0; }
    .check { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
    .check input { width: auto; }
    .inline { display: flex; gap: 8px; align-items: stretch; }
    .inline input { flex: 1 1 auto; }
    #warnings:not(:empty) { margin-bottom: 10px; padding: 8px 10px; color: var(--vscode-editorWarning-foreground); background: var(--vscode-inputValidation-warningBackground); border-left: 3px solid var(--vscode-editorWarning-foreground); }
    #status:not(:empty) { margin: 0 0 10px; padding: 8px 10px; border-left: 3px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background); }
    #status.ok { color: var(--vscode-testing-iconPassed); }
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
  <h1>${escapeHtml(heading)}</h1>
  <p class="sub">${escapeHtml(subtitle)}</p>

  <section class="card">
    <label for="f-url">从连接串导入<span class="hint">可选</span></label>
    <div class="inline">
      <input id="f-url" type="text" spellcheck="false" autocomplete="off" placeholder="mysql://user:password@host:9030/db" />
      <button class="secondary" id="b-parse">解析并填充</button>
    </div>
    <p class="hint">支持 mysql://、jdbc:mysql:// 或直接粘贴 host:port；密码只留在 SecretStorage。</p>
  </section>

  <section class="card">
    <div class="grid">
      <div class="field">
        <label for="f-type">类型</label>
        <select id="f-type">
          <option value="Doris"${draft.type === 'Doris' ? ' selected' : ''}>Doris（默认 9030）</option>
          <option value="MySQL"${draft.type === 'MySQL' ? ' selected' : ''}>MySQL（默认 3306）</option>
        </select>
      </div>
      <div class="field">
        <label for="f-name">连接名称</label>
        <input id="f-name" type="text" spellcheck="false" autocomplete="off" value="${escapeHtml(draft.name)}" placeholder="例如：本地 Doris" />
        <span class="err" data-err="name"></span>
      </div>
      <div class="field">
        <label for="f-host">主机</label>
        <input id="f-host" type="text" spellcheck="false" autocomplete="off" value="${escapeHtml(draft.host)}" placeholder="127.0.0.1" />
        <span class="err" data-err="host"></span>
      </div>
      <div class="field">
        <label for="f-port">端口</label>
        <input id="f-port" type="text" inputmode="numeric" spellcheck="false" autocomplete="off" value="${escapeHtml(draft.port)}" />
        <span class="err" data-err="port"></span>
      </div>
      <div class="field">
        <label for="f-database">默认数据库<span class="hint">可留空</span></label>
        <input id="f-database" type="text" spellcheck="false" autocomplete="off" value="${escapeHtml(draft.database)}" />
      </div>
      <div class="field">
        <label for="f-username">用户名</label>
        <input id="f-username" type="text" spellcheck="false" autocomplete="off" value="${escapeHtml(draft.username)}" />
        <span class="err" data-err="username"></span>
      </div>
      <div class="field wide">
        <label for="f-password">密码</label>
        <input id="f-password" type="password" spellcheck="false" autocomplete="off" placeholder="${isEdit ? '留空保持原密码' : '留空则首次连接时再输入'}" />
        <p class="hint">${escapeHtml(passwordHint)}</p>
      </div>
    </div>
  </section>

  <section class="card">
    <label class="check">
      <input type="checkbox" id="f-ssl"${draft.ssl ? ' checked' : ''} />
      使用 SSL (TLS)
    </label>
    <p class="hint">启用后加密传输链路，但不校验服务端证书链（mysql2 的默认行为）。</p>
    ${clearPasswordBlock}
  </section>

  <div id="warnings"></div>
  <p id="status"></p>

  <div class="bar">
    <button class="secondary" id="b-test">测试连接</button>
    <span class="spacer"></span>
    <button class="secondary" id="b-cancel">取消</button>
    <button id="b-save">保存</button>
  </div>

  <script nonce="${nonce}">
    const api = acquireVsCodeApi();
    const id = (name) => document.getElementById(name);
    const DEFAULT_PORTS = ${JSON.stringify(DEFAULT_PORTS)};
    const testButton = id('b-test');
    const saveButton = id('b-save');
    const statusEl = id('status');
    const warningsEl = id('warnings');

    const collect = () => ({
      name: id('f-name').value,
      type: id('f-type').value,
      host: id('f-host').value,
      port: id('f-port').value,
      database: id('f-database').value,
      username: id('f-username').value,
      password: id('f-password').value,
      ssl: id('f-ssl').checked,
      clearSavedPassword: id('f-clear-pwd') ? id('f-clear-pwd').checked : false,
    });

    const localErrors = () => {
      const errors = {};
      if (!id('f-name').value.trim()) errors.name = '连接名称不能为空。';
      if (!id('f-host').value.trim()) errors.host = '主机不能为空。';
      if (!id('f-username').value.trim()) errors.username = '用户名不能为空。';
      const portText = id('f-port').value.trim();
      const port = Number(portText);
      if (!portText) errors.port = '端口不能为空。';
      else if (!Number.isInteger(port) || port < 1 || port > 65535) errors.port = '端口必须是 1 到 65535 之间的整数。';
      return errors;
    };

    const paint = (errors) => {
      ['name', 'host', 'port', 'username'].forEach((field) => {
        const slot = document.querySelector('[data-err="' + field + '"]');
        if (slot) slot.textContent = errors[field] || '';
      });
    };

    const setWarnings = (list) => {
      warningsEl.textContent = (list || []).join(' ');
    };

    const setStatus = (text, kind) => {
      statusEl.textContent = text || '';
      statusEl.className = kind || '';
    };

    ['f-name', 'f-host', 'f-port', 'f-username', 'f-database', 'f-password'].forEach((fieldId) => {
      id(fieldId).addEventListener('input', () => paint(localErrors()));
    });

    id('f-type').addEventListener('change', (event) => {
      const portField = id('f-port');
      const targetDefault = String(DEFAULT_PORTS[event.target.value]);
      const currentValue = portField.value.trim();
      if (!currentValue || Object.values(DEFAULT_PORTS).includes(Number(currentValue))) {
        portField.value = targetDefault;
      }
      paint(localErrors());
    });

    id('b-parse').addEventListener('click', () => {
      api.postMessage({ type: 'parseUrl', url: id('f-url').value });
    });

    id('b-cancel').addEventListener('click', () => api.postMessage({ type: 'cancel' }));

    testButton.addEventListener('click', () => {
      const errors = localErrors();
      paint(errors);
      if (Object.keys(errors).length) {
        setStatus('请先修正标红的字段。', 'bad');
        return;
      }
      testButton.disabled = true;
      testButton.textContent = '正在测试…';
      setStatus('', '');
      api.postMessage({ type: 'test', draft: collect() });
    });

    const save = () => {
      const errors = localErrors();
      paint(errors);
      if (Object.keys(errors).length) {
        setStatus('请先修正标红的字段。', 'bad');
        return;
      }
      saveButton.disabled = true;
      saveButton.textContent = '正在保存…';
      api.postMessage({ type: 'save', draft: collect() });
    };

    saveButton.addEventListener('click', save);

    document.body.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target && event.target.tagName === 'INPUT') {
        event.preventDefault();
        save();
      }
      if (event.key === 'Escape') {
        api.postMessage({ type: 'cancel' });
      }
    });

    window.addEventListener('message', (event) => {
      const data = event.data || {};
      if (data.type === 'parsed') {
        const parsed = data.parsed;
        if (!parsed) {
          setStatus('没能识别这个连接串，请检查格式。', 'bad');
          return;
        }
        if (parsed.host) id('f-host').value = parsed.host;
        if (parsed.port) id('f-port').value = parsed.port;
        if (parsed.username) id('f-username').value = parsed.username;
        if (parsed.password) id('f-password').value = parsed.password;
        if (parsed.database) id('f-database').value = parsed.database;
        if (parsed.ssl) id('f-ssl').checked = true;
        if (!id('f-name').value.trim()) id('f-name').value = parsed.host;
        id('f-url').value = '';
        paint(localErrors());
        setStatus('已从连接串填充字段。', 'ok');
        return;
      }
      if (data.type === 'testing') {
        setStatus('正在连接…', '');
        return;
      }
      if (data.type === 'testResult') {
        testButton.disabled = false;
        testButton.textContent = '测试连接';
        setStatus(data.message, data.ok ? 'ok' : 'bad');
        return;
      }
      if (data.type === 'issues') {
        saveButton.disabled = false;
        saveButton.textContent = '保存';
        paint(data.errors || {});
        setWarnings(data.warnings || []);
        if (Object.keys(data.errors || {}).length) setStatus('请先修正标红的字段。', 'bad');
      }
    });
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
