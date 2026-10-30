// Shared visual language for every Webview. Colors and typography come from the
// active VS Code theme; the structure adds a consistent hierarchy and density.
export const WEBVIEW_BASE_CSS = `
  :root {
    color-scheme: light dark;
    --ui-radius: 8px;
    --ui-radius-sm: 5px;
    --ui-gap: 12px;
    --ui-line: color-mix(in srgb, var(--vscode-panel-border) 78%, var(--vscode-foreground));
    --ui-line-soft: color-mix(in srgb, var(--vscode-panel-border) 74%, transparent);
    --ui-surface: color-mix(in srgb, var(--vscode-editorWidget-background) 88%, transparent);
    --ui-surface-strong: color-mix(in srgb, var(--vscode-editorWidget-background) 96%, var(--vscode-editor-background));
    --ui-accent-soft: color-mix(in srgb, var(--vscode-focusBorder) 16%, transparent);
    --ui-warning-soft: color-mix(in srgb, var(--vscode-editorWarning-foreground) 12%, var(--vscode-editor-background));
    --ui-error-soft: color-mix(in srgb, var(--vscode-errorForeground) 10%, var(--vscode-editor-background));
    --ui-code: var(--vscode-textCodeBlock-background, var(--vscode-editorWidget-background));
  }
  * { box-sizing: border-box; }
  html { min-height: 100%; }
  body {
    min-height: 100vh;
    margin: 0;
    padding: clamp(16px, 2.4vw, 28px);
    color: var(--vscode-foreground);
    background:
      radial-gradient(1100px 420px at 8% -12%, var(--ui-accent-soft), transparent 62%),
      linear-gradient(180deg, color-mix(in srgb, var(--vscode-editor-background) 92%, transparent), var(--vscode-editor-background));
    font-family: var(--vscode-font-family);
    font-size: 13px;
    line-height: 1.55;
  }
  button, input, select, textarea { font: inherit; }
  button {
    min-height: 30px;
    padding: 5px 12px;
    border: 1px solid transparent;
    border-radius: var(--ui-radius-sm);
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    cursor: pointer;
    transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.ghost {
    color: var(--vscode-foreground);
    background: transparent;
    border-color: var(--ui-line-soft);
  }
  button.ghost:hover { background: var(--vscode-list-hoverBackground); }
  button:focus-visible, input:focus-visible, select:focus-visible {
    outline: 2px solid var(--vscode-focusBorder);
    outline-offset: 2px;
  }
  button:disabled { cursor: default; opacity: .62; }
  input[type="text"], input[type="password"], input[type="search"], select {
    width: 100%;
    min-height: 31px;
    padding: 5px 9px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--ui-line-soft));
    border-radius: var(--ui-radius-sm);
    outline: none;
  }
  input:focus, select:focus { border-color: var(--vscode-focusBorder); }
  input::placeholder { color: var(--vscode-input-placeholderForeground); }
  .page-shell { width: min(100%, 1080px); margin: 0 auto; }
  .page-shell.wide { max-width: none; }
  .page-header {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px 24px;
    margin-bottom: 18px;
  }
  .page-heading { flex: 1 1 420px; min-width: 0; }
  .eyebrow {
    margin-bottom: 4px;
    color: var(--vscode-descriptionForeground);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: .14em;
    text-transform: uppercase;
  }
  h1, h2, h3, p { margin-top: 0; }
  h1 {
    margin-bottom: 5px;
    font-size: 20px;
    font-weight: 650;
    letter-spacing: -.02em;
  }
  .sub {
    max-width: 72ch;
    margin-bottom: 0;
    color: var(--vscode-descriptionForeground);
  }
  .section {
    margin-bottom: var(--ui-gap);
    padding: 15px 16px;
    background: var(--ui-surface);
    border: 1px solid var(--ui-line-soft);
    border-radius: var(--ui-radius);
  }
  .section.compact { padding: 12px 14px; }
  .section-header {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }
  .section-title { font-size: 13px; font-weight: 650; }
  .section-note { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .field-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 12px 16px;
  }
  .field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .field.wide { grid-column: 1 / -1; }
  .field[hidden] { display: none; }
  label { display: block; }
  .label-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    font-size: 12px;
    font-weight: 600;
  }
  .hint {
    margin: 0;
    color: var(--vscode-descriptionForeground);
    font-size: 11.5px;
  }
  label > .hint { display: inline; margin-left: 6px; font-weight: 400; }
  .err { min-height: 0; color: var(--vscode-errorForeground); font-size: 11.5px; }
  .inline { display: flex; gap: 8px; align-items: stretch; }
  .inline > input { flex: 1 1 auto; min-width: 0; }
  .inline > button { flex: 0 0 auto; white-space: nowrap; }
  .check {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    min-height: 24px;
    font-weight: 500;
  }
  .check input { flex: 0 0 auto; margin-top: 3px; }
  .status-banner {
    padding: 9px 11px;
    color: var(--vscode-foreground);
    background: var(--ui-surface-strong);
    border: 1px solid var(--ui-line-soft);
    border-left: 3px solid var(--ui-line);
    border-radius: var(--ui-radius-sm);
  }
  .status-banner:empty { display: none; }
  .status-banner.ok { border-left-color: var(--vscode-testing-iconPassed); }
  .status-banner.bad { color: var(--vscode-errorForeground); background: var(--ui-error-soft); border-left-color: var(--vscode-errorForeground); }
  .status-banner.warning { background: var(--ui-warning-soft); border-left-color: var(--vscode-editorWarning-foreground); }
  .badge-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .badge {
    display: inline-flex;
    align-items: center;
    min-height: 22px;
    padding: 1px 8px;
    color: var(--vscode-descriptionForeground);
    background: color-mix(in srgb, var(--vscode-badge-background) 12%, transparent);
    border: 1px solid var(--ui-line-soft);
    border-radius: 999px;
    font-size: 11px;
    white-space: nowrap;
  }
  .badge.accent { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }
  .badge.warning { color: var(--vscode-editorWarning-foreground); border-color: color-mix(in srgb, var(--vscode-editorWarning-foreground) 45%, transparent); }
  .action-bar {
    position: sticky;
    z-index: 20;
    bottom: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 18px -2px -2px;
    padding: 12px 2px calc(12px + env(safe-area-inset-bottom));
    background: color-mix(in srgb, var(--vscode-editor-background) 97%, var(--vscode-editorWidget-background));
    border-top: 1px solid var(--ui-line-soft);
    box-shadow: 0 -8px 18px color-mix(in srgb, var(--vscode-editor-background) 65%, transparent);
  }
  .action-bar .spacer { flex: 1 1 auto; }
  .code-surface {
    margin: 0;
    padding: 12px;
    overflow: auto;
    color: var(--vscode-editor-foreground);
    background: var(--ui-code);
    border: 1px solid var(--ui-line-soft);
    border-radius: var(--ui-radius-sm);
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
    line-height: 1.45;
    tab-size: 2;
  }
  .action-feedback { color: var(--vscode-descriptionForeground); font-size: 11.5px; }
  @media (max-width: 680px) {
    body { padding: 14px; }
    .page-header { gap: 10px; }
    .field-grid { grid-template-columns: 1fr; }
    .action-bar { flex-wrap: wrap; }
  }
  @media (prefers-reduced-motion: reduce) {
    * { scroll-behavior: auto !important; transition: none !important; animation: none !important; }
  }
`;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
