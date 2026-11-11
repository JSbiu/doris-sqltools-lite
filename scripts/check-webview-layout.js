'use strict';

// Renders the real Webview HTML in headless Chrome and checks that page-level
// horizontal overflow stays at zero across the release widths. It uses the
// Chrome DevTools Protocol directly so the release check needs no npm package.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

const WIDTHS = [320, 420, 720, 1200];
const PAGES = ['connection', 'parameters', 'plan', 'results', 'error'];
const DEVICE_SCALE_FACTORS = [1, 2];
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);

// Standalone previews inherit a dark palette. These overrides exercise the
// same VS Code theme variables under light and high-contrast palettes; they do
// not replace a real VS Code window check.
const THEMES = {
  dark: '',
  light: `:root {
    color-scheme: light;
    --vscode-foreground: #1f2328;
    --vscode-descriptionForeground: #59636e;
    --vscode-editor-background: #ffffff;
    --vscode-editor-foreground: #1f2328;
    --vscode-editorWidget-background: #f6f8fa;
    --vscode-panel-border: #d0d7de;
    --vscode-focusBorder: #0969da;
    --vscode-button-background: #0969da;
    --vscode-button-foreground: #ffffff;
    --vscode-button-hoverBackground: #0757b5;
    --vscode-button-secondaryBackground: #f6f8fa;
    --vscode-button-secondaryForeground: #1f2328;
    --vscode-button-secondaryHoverBackground: #eaeef2;
    --vscode-input-background: #ffffff;
    --vscode-input-foreground: #1f2328;
    --vscode-input-border: #d0d7de;
    --vscode-input-placeholderForeground: #6e7781;
    --vscode-testing-iconPassed: #1a7f37;
    --vscode-editorWarning-foreground: #9a6700;
    --vscode-errorForeground: #cf222e;
    --vscode-textCodeBlock-background: #f6f8fa;
    --vscode-list-hoverBackground: #f6f8fa;
    --vscode-list-activeSelectionBackground: #0969da;
    --vscode-list-activeSelectionForeground: #ffffff;
    --vscode-editorGroupHeader-tabsBackground: #f6f8fa;
    --vscode-badge-background: #eaeef2;
  }`,
  highContrast: `:root {
    color-scheme: dark;
    --vscode-foreground: #ffffff;
    --vscode-descriptionForeground: #ffffff;
    --vscode-editor-background: #000000;
    --vscode-editor-foreground: #ffffff;
    --vscode-editorWidget-background: #000000;
    --vscode-panel-border: #ffffff;
    --vscode-focusBorder: #ffff00;
    --vscode-button-background: #000000;
    --vscode-button-foreground: #ffff00;
    --vscode-button-hoverBackground: #222222;
    --vscode-button-secondaryBackground: #000000;
    --vscode-button-secondaryForeground: #ffffff;
    --vscode-button-secondaryHoverBackground: #222222;
    --vscode-input-background: #000000;
    --vscode-input-foreground: #ffffff;
    --vscode-input-border: #ffffff;
    --vscode-input-placeholderForeground: #cccccc;
    --vscode-testing-iconPassed: #00ff00;
    --vscode-editorWarning-foreground: #ffff00;
    --vscode-errorForeground: #ff8080;
    --vscode-textCodeBlock-background: #000000;
    --vscode-list-hoverBackground: #222222;
    --vscode-list-activeSelectionBackground: #ffff00;
    --vscode-list-activeSelectionForeground: #000000;
    --vscode-editorGroupHeader-tabsBackground: #000000;
    --vscode-badge-background: #000000;
  }`,
};

const EXPECTED_FOCUS_BORDER = {
  dark: '#4ea1ff',
  light: '#0969da',
  highContrast: '#ffff00',
};

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Chrome or Edge was not found for Webview layout checks');
}

function generatePreview() {
  const output = childProcess.execFileSync(
    process.execPath,
    [path.join(__dirname, 'preview-webviews.js')],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const { target } = JSON.parse(output);
  return target;
}

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

async function waitForPort(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetchJson(`http://127.0.0.1:${port}/json/version`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('headless Chrome did not expose the DevTools endpoint');
}

class DevTools {
  constructor(webSocket) {
    this.webSocket = webSocket;
    this.nextId = 0;
    this.pending = new Map();
    webSocket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.webSocket.send(JSON.stringify({ id, method, params }));
    }).catch((error) => {
      throw new Error(`${method}: ${error.message}`);
    });
  }
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('DevTools socket failed')), { once: true });
  });
  return new DevTools(socket);
}

async function waitForDocument(devtools) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await devtools.send('Runtime.evaluate', {
      expression: "document.readyState === 'complete' && !!document.querySelector('.page-header')",
      returnByValue: true,
    });
    if (result.result.value === true) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('preview HTML did not finish loading');
}

async function applyTheme(devtools, css) {
  await devtools.send('Runtime.evaluate', {
    expression: `(() => {
      document.getElementById('release-theme-override')?.remove();
      if (!${JSON.stringify(css)}) return true;
      const style = document.createElement('style');
      style.id = 'release-theme-override';
      style.textContent = ${JSON.stringify(css)};
      document.head.append(style);
      return true;
    })()`,
    returnByValue: true,
  });
}

function sourceForPage(directory, page) {
  const original = fs.readFileSync(path.join(directory, `${page}.html`), 'utf8');
  // The preview is a standalone HTML page; acquireVsCodeApi only exists inside
  // a VS Code Webview. Stub it out so the real inline script still executes.
  return original.replace(
    /const api = acquireVsCodeApi\(\);/,
    'const api = { postMessage() {}, getState() { return undefined; }, setState() {} };',
  );
}

async function checkLayout() {
  const directory = generatePreview();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'doris-sqltools-webview-chrome-'));
  const port = 9200 + (process.pid % 1000);
  const chrome = childProcess.spawn(findChrome(), [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });
  let devtools;
  const problems = [];
  try {
    await waitForPort(port);
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
    const pageTarget = targets.find((target) => target.type === 'page');
    if (!pageTarget) throw new Error('no DevTools page target available');
    devtools = await connect(pageTarget.webSocketDebuggerUrl);
    await devtools.send('Page.enable');
    await devtools.send('Runtime.enable');

    for (const page of PAGES) {
      const html = sourceForPage(directory, page);
      await devtools.send('Page.navigate', { url: 'data:text/html,' + encodeURIComponent(html) });
      await waitForDocument(devtools);
      for (const [theme, css] of Object.entries(THEMES)) {
        await applyTheme(devtools, css);
        let checked = 0;
        for (const width of WIDTHS) {
          for (const deviceScaleFactor of DEVICE_SCALE_FACTORS) {
            await devtools.send('Emulation.setDeviceMetricsOverride', {
              width,
              height: 900,
              deviceScaleFactor,
              mobile: false,
            });
            const result = await devtools.send('Runtime.evaluate', {
              expression: `JSON.stringify((() => {
                const root = document.documentElement;
                const wrap = document.querySelector('.table-wrap');
                const menu = document.querySelector('#more-actions');
                if (menu) menu.open = true;
                const menuBox = menu && menu.querySelector('#action-menu')?.getBoundingClientRect();
                const focusBorder = getComputedStyle(root).getPropertyValue('--vscode-focusBorder').trim();
                return {
                  scrollWidth: root.scrollWidth,
                  clientWidth: root.clientWidth,
                  overflow: root.scrollWidth - root.clientWidth,
                  focusBorder,
                  ariaLive: document.querySelectorAll('[aria-live]').length,
                  tableOverflowX: wrap ? getComputedStyle(wrap).overflowX : null,
                  menuInView: !menuBox || (menuBox.left >= 0 && menuBox.right <= ${width}),
                };
              })())`,
              returnByValue: true,
            });
            if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
            const state = JSON.parse(result.result.value);
            const scale = deviceScaleFactor === 2 ? '200%' : '100%';
            const label = `${page}/${theme}/${width}px/${scale}`;
            const expectedFocusBorder = EXPECTED_FOCUS_BORDER[theme];
            if (state.overflow !== 0) problems.push(`${label}: page overflow ${state.overflow}px`);
            if (state.focusBorder !== expectedFocusBorder) {
              problems.push(`${label}: unexpected focus border ${state.focusBorder || '(empty)'}`);
            }
            if (state.ariaLive === 0) problems.push(`${label}: no aria-live status region`);
            if (page === 'results' && state.tableOverflowX !== 'auto') problems.push(`${label}: result table does not scroll in its own container`);
            if (!state.menuInView) problems.push(`${label}: more-actions menu leaves the viewport`);
            checked += 1;
          }
        }
        console.log(`  ${problems.some((problem) => problem.startsWith(`${page}/${theme}/`)) ? 'FAIL' : 'ok  '}  ${page}/${theme}: ${checked} layouts`);
      }
    }
  } finally {
    if (devtools) devtools.webSocket.close();
    chrome.kill();
    // Chrome can still hold its profile handles immediately after kill();
    // a best-effort cleanup avoids failing an otherwise successful check.
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* cleaned by the OS temp directory */ }
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`  FAIL  ${problem}`);
    process.exitCode = 1;
  } else {
    console.log('all good');
  }
}

checkLayout().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
