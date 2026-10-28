'use strict';

// These tests drive the real result-panel HTML and its real inline script.
// The panel class is private, so the compiled module is loaded into a vm
// context with a small hook that exposes the class for the test only; the
// production surface stays untouched. A minimal DOM stub is enough because the
// panel only uses element lookup, attributes, textContent, hidden and
// appendChild.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const Module = require('node:module');
const { createRequire } = require('node:module');

const projectRoot = path.join(__dirname, '..');
const extensionPath = path.join(projectRoot, 'out', 'extension.js');
const extensionRequire = createRequire(extensionPath);

class TreeItemStub {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

const clipboard = {
  text: undefined,
  async writeText(text) {
    clipboard.text = text;
  },
};

const vscodeStub = {
  TreeItem: TreeItemStub,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  EventEmitter: class EventEmitterStub {
    constructor() {
      this.event = () => {};
    }

    fire() {}
  },
  ThemeIcon: class ThemeIconStub {
    constructor(id) {
      this.id = id;
    }
  },
  workspace: {
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
  },
  env: { clipboard },
};

function loadResultPanel() {
  const source = `${fs.readFileSync(extensionPath, 'utf8')}\nmodule.exports.__test = { ResultPanel };\n`;
  const module = { exports: {} };
  const context = {
    module,
    exports: module.exports,
    require: (id) => (id === 'vscode' ? vscodeStub : extensionRequire(id)),
    __filename: extensionPath,
    __dirname: path.dirname(extensionPath),
    console,
    process,
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    TextEncoder,
    TextDecoder,
  };
  context.global = context;
  vm.createContext(context);

  // The modules extension.ts pulls in import vscode themselves; a temporary
  // loader hook keeps that dependency out of the CLI test run.
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscodeStub;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    vm.runInContext(source, context, { filename: extensionPath });
  } finally {
    Module._load = originalLoad;
  }
  return module.exports.__test.ResultPanel;
}

const ResultPanel = loadResultPanel();

const VOID_TAGS = new Set(['meta', 'link', 'input', 'br', 'img', 'hr']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };

function decodeEntities(text) {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_whole, name) => ENTITIES[name]);
}

function parseAttributes(source) {
  const attributes = {};
  for (const match of source.matchAll(/([^\s=]+)(?:\s*=\s*"([^"]*)")?/g)) {
    if (!match[1]) continue;
    attributes[match[1]] = match[2] === undefined ? '' : decodeEntities(match[2]);
  }
  return attributes;
}

class FakeElement {
  constructor(tagName, attributes = {}, parent = null) {
    this.tagName = tagName.toUpperCase();
    this.nodeName = this.tagName;
    this.attributes = { ...attributes };
    this.parentNode = parent;
    this.children = [];
    this.hidden = Object.prototype.hasOwnProperty.call(attributes, 'hidden');
    this.listeners = new Map();
    this.value = attributes.value ?? '';
  }

  get id() {
    return this.attributes.id ?? '';
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  get dataset() {
    const data = {};
    for (const [name, value] of Object.entries(this.attributes)) {
      if (!name.startsWith('data-')) continue;
      const key = name.slice(5).replace(/-([a-z])/g, (_whole, letter) => letter.toUpperCase());
      data[key] = value;
    }
    return data;
  }

  get textContent() {
    return this.children
      .map((child) => (typeof child === 'string' ? child : child.textContent))
      .join('');
  }

  set textContent(value) {
    this.children = value === '' ? [] : [String(value)];
  }

  appendChild(child) {
    if (child.parentNode) {
      const index = child.parentNode.children.indexOf(child);
      if (index >= 0) child.parentNode.children.splice(index, 1);
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  dispatch(type) {
    for (const handler of this.listeners.get(type) ?? []) {
      handler.call(this, { type, target: this, preventDefault() {} });
    }
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    const found = [];
    walk(this, (node) => {
      if (matches(node, selector)) found.push(node);
    });
    return found;
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node instanceof FakeElement && matches(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
}

function walk(node, visit) {
  for (const child of node.children) {
    if (child instanceof FakeElement) {
      visit(child);
      walk(child, visit);
    }
  }
}

function matchesCompound(node, compound) {
  if (!(node instanceof FakeElement)) return false;
  const shape = /^([a-zA-Z][\w-]*)?((?:[.#][\w-]+|\[[^\]]+\])*)$/.exec(compound);
  if (!shape) return false;
  const [, tag, rest] = shape;
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  for (const part of rest.matchAll(/[.#][\w-]+|\[[^\]]+\]/g)) {
    const token = part[0];
    if (token.startsWith('#')) {
      if (node.getAttribute('id') !== token.slice(1)) return false;
    } else if (token.startsWith('.')) {
      const classes = (node.getAttribute('class') ?? '').split(/\s+/);
      if (!classes.includes(token.slice(1))) return false;
    } else {
      const attribute = /^\[([^\]=]+)(?:="([^"]*)")?\]$/.exec(token);
      if (!attribute) return false;
      if (!node.hasAttribute(attribute[1])) return false;
      if (attribute[2] !== undefined && node.getAttribute(attribute[1]) !== attribute[2]) return false;
    }
  }
  return true;
}

function matches(node, selector) {
  if (!(node instanceof FakeElement)) return false;
  const parts = selector.trim().split(/\s+/);
  let current = node;
  if (!matchesCompound(current, parts[parts.length - 1])) return false;
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    current = current.parentNode;
    while (current && !matchesCompound(current, parts[index])) current = current.parentNode;
    if (!current) return false;
  }
  return true;
}

function appendText(parent, text) {
  if (text) parent.children.push(decodeEntities(text));
}

function parseHtml(html) {
  const root = new FakeElement('#document');
  const stack = [root];
  let cursor = 0;

  while (cursor < html.length) {
    const open = html.indexOf('<', cursor);
    if (open === -1) {
      appendText(stack[stack.length - 1], html.slice(cursor));
      break;
    }
    if (open > cursor) appendText(stack[stack.length - 1], html.slice(cursor, open));

    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open);
      cursor = end === -1 ? html.length : end + 3;
      continue;
    }

    const close = html.indexOf('>', open);
    if (close === -1) break;
    const raw = html.slice(open + 1, close).trim();
    if (raw.startsWith('!')) {
      cursor = close + 1;
      continue;
    }
    if (raw.startsWith('/')) {
      if (stack.length > 1) stack.pop();
      cursor = close + 1;
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const content = selfClosing ? raw.slice(0, -1).trim() : raw;
    const nameEnd = content.search(/\s/);
    const tag = (nameEnd === -1 ? content : content.slice(0, nameEnd)).toLowerCase();
    const element = new FakeElement(tag, parseAttributes(nameEnd === -1 ? '' : content.slice(nameEnd)), stack[stack.length - 1]);
    stack[stack.length - 1].children.push(element);
    cursor = close + 1;

    if (tag === 'script' || tag === 'style') {
      const terminator = `</${tag}>`;
      const end = html.toLowerCase().indexOf(terminator, cursor);
      const rawText = html.slice(cursor, end === -1 ? html.length : end);
      if (rawText) element.children.push(rawText);
      cursor = end === -1 ? html.length : end + terminator.length;
      continue;
    }

    if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(element);
  }

  root.getElementById = (id) => {
    let found = null;
    walk(root, (node) => {
      if (!found && node.getAttribute('id') === id) found = node;
    });
    return found;
  };
  return root;
}

function inlineScript(html) {
  return /<script[^>]*>([\s\S]*?)<\/script>/.exec(html)[1];
}

function renderPanel(result, metadata = {}) {
  const webview = { html: '', postMessage: async () => {}, onDidReceiveMessage: () => {} };
  const panel = new ResultPanel({
    webview,
    title: '',
    reveal() {},
    onDidDispose() {},
  });
  panel.update(result, {
    connectionName: 'demo',
    durationMs: 5,
    maxRows: result.rows.length || 1000,
    readComplete: true,
    ...metadata,
  });
  return { panel, html: webview.html };
}

function openPanel(html) {
  const document = parseHtml(html);
  const messages = [];
  let receiveMessage;
  const sandbox = {
    acquireVsCodeApi: () => ({ postMessage: (message) => messages.push(message) }),
    document,
    window: {
      addEventListener: (event, callback) => { if (event === 'message') receiveMessage = callback; },
      setTimeout: (handler) => {
        handler();
        return 0;
      },
    },
    console,
  };
  vm.runInNewContext(inlineScript(html), sandbox, { filename: 'result-panel-inline.js' });

  return {
    document,
    messages,
    receive: (data) => receiveMessage({ data }),
    rows: () => document.querySelectorAll('tbody tr[data-row]'),
    rowNumbers: () => document.querySelectorAll('tbody tr[data-row]')
      .map((row) => Number(row.querySelector('td').textContent)),
    values: (column = 0) => document.querySelectorAll('tbody tr[data-row]')
      .map((row) => row.querySelectorAll('td')[column + 1]?.textContent),
    sortButtons: () => document.querySelectorAll('th button[data-sort-column]'),
    headerSort: (column) => document.querySelectorAll('th[data-sort-header]')[column].getAttribute('aria-sort'),
    indicator: (column) => document.querySelectorAll('th[data-sort-header]')[column].querySelector('.sort-indicator').textContent,
    status: () => document.getElementById('sort-status')?.textContent,
    visibleCount: () => document.getElementById('visible-count')?.textContent,
    filter: () => document.getElementById('result-filter'),
    button: (selector) => document.querySelector(selector),
  };
}

function resultOf(values, column = 'v') {
  return {
    rows: values.map((value) => ({ [column]: value })),
    columns: [column],
    affectedRows: 0,
    truncated: false,
    totalRows: values.length,
  };
}

test('cycles a numeric column through ascending, descending and the original order', () => {
  const { html } = renderPanel(resultOf([2, 10, -3, 1.5, 0]));
  const view = openPanel(html);
  const [button] = view.sortButtons();

  assert.deepEqual(view.rowNumbers(), [1, 2, 3, 4, 5]);
  assert.equal(view.headerSort(0), 'none');
  assert.equal(view.indicator(0), '↕');
  assert.equal(view.status(), '原始顺序');

  button.dispatch('click');
  assert.deepEqual(view.rowNumbers(), [3, 5, 4, 1, 2]);
  assert.deepEqual(view.values(), ['-3', '0', '1.5', '2', '10']);
  assert.equal(view.headerSort(0), 'ascending');
  assert.equal(view.indicator(0), '↑');
  assert.equal(view.status(), '按“v”升序');

  button.dispatch('click');
  assert.deepEqual(view.rowNumbers(), [2, 1, 4, 5, 3]);
  assert.deepEqual(view.values(), ['10', '2', '1.5', '0', '-3']);
  assert.equal(view.headerSort(0), 'descending');
  assert.equal(view.indicator(0), '↓');
  assert.equal(view.status(), '按“v”降序');

  button.dispatch('click');
  assert.deepEqual(view.rowNumbers(), [1, 2, 3, 4, 5]);
  assert.deepEqual(view.values(), ['2', '10', '-3', '1.5', '0']);
  assert.equal(view.headerSort(0), 'none');
  assert.equal(view.indicator(0), '↕');
  assert.equal(view.status(), '原始顺序');
  assert.equal(view.messages.length, 0, 'sorting must never post a message');
});

test('sorts text as case-sensitive UTF-16 text, including numeric-looking strings', () => {
  const { html } = renderPanel(resultOf(['2', '10', 'apple', 'Banana', '']));
  const view = openPanel(html);
  const [button] = view.sortButtons();

  button.dispatch('click');
  assert.deepEqual(view.rowNumbers(), [5, 2, 1, 4, 3]);
  assert.deepEqual(view.values(), ['', '10', '2', 'Banana', 'apple']);

  button.dispatch('click');
  assert.deepEqual(view.rowNumbers(), [3, 4, 1, 2, 5]);
  assert.deepEqual(view.values(), ['apple', 'Banana', '2', '10', '']);
});

test('keeps NULL last in both directions and treats an empty string as the smallest text', () => {
  const { html } = renderPanel(resultOf([null, '', 'b', undefined, 'a']));
  const view = openPanel(html);
  const [button] = view.sortButtons();

  const cells = () => view.rows().map((row) => row.querySelectorAll('td')[1]);
  assert.ok(cells()[0].hasAttribute('data-sort-null'));
  assert.equal(cells()[1].getAttribute('data-sort-kind'), 'text');
  assert.equal(cells()[1].getAttribute('data-sort-value'), '');

  button.dispatch('click');
  assert.deepEqual(view.rowNumbers(), [2, 5, 3, 1, 4]);
  assert.deepEqual(view.values(), ['', 'a', 'b', 'NULL', 'NULL']);

  button.dispatch('click');
  assert.deepEqual(view.rowNumbers(), [3, 5, 2, 1, 4]);
  assert.deepEqual(view.values(), ['b', 'a', '', 'NULL', 'NULL']);
});

test('orders mixed columns numbers then text then NULL ascending, and text then numbers then NULL descending', () => {
  const { html } = renderPanel(resultOf(['10', 2, null, 'abc', 1.5, undefined, '']));
  const view = openPanel(html);
  const [button] = view.sortButtons();

  button.dispatch('click');
  assert.deepEqual(view.rowNumbers(), [5, 2, 7, 1, 4, 3, 6]);
  assert.deepEqual(view.values(), ['1.5', '2', '', '10', 'abc', 'NULL', 'NULL']);

  button.dispatch('click');
  assert.deepEqual(view.rowNumbers(), [4, 1, 7, 2, 5, 3, 6]);
  assert.deepEqual(view.values(), ['abc', '10', '', '2', '1.5', 'NULL', 'NULL']);
});

test('keeps duplicate values in original order in both directions and starts a new column ascending', () => {
  const result = {
    rows: [
      { a: 2, b: 'x' },
      { a: 1, b: 'y' },
      { a: 1, b: 'x' },
      { a: 1, b: 'x' },
    ],
    columns: ['a', 'b'],
    affectedRows: 0,
    truncated: false,
    totalRows: 4,
  };
  const { html } = renderPanel(result);
  const view = openPanel(html);
  const [first, second] = view.sortButtons();

  first.dispatch('click');
  assert.deepEqual(view.rowNumbers(), [2, 3, 4, 1]);

  first.dispatch('click');
  assert.deepEqual(view.rowNumbers(), [1, 2, 3, 4], 'ties keep original order when descending');

  second.dispatch('click');
  assert.deepEqual(view.rowNumbers(), [1, 3, 4, 2]);
  assert.equal(view.headerSort(0), 'none');
  assert.equal(view.headerSort(1), 'ascending');
  assert.equal(view.status(), '按“b”升序');

  second.dispatch('click');
  assert.deepEqual(view.rowNumbers(), [2, 1, 3, 4], 'ties keep original order in the new column');
});

test('sorting and filtering coexist without clearing either state', () => {
  const { html } = renderPanel(resultOf(['b1', 'a2', 'b3', 'a4']));
  const view = openPanel(html);
  const filter = view.filter();
  const [button] = view.sortButtons();

  filter.value = 'b';
  filter.dispatch('input');
  assert.equal(view.visibleCount(), '2');
  assert.deepEqual(view.rows().map((row) => row.hidden), [false, true, false, true]);

  button.dispatch('click');
  assert.equal(filter.value, 'b', 'sorting does not clear the filter');
  assert.equal(view.visibleCount(), '2');
  assert.deepEqual(view.rowNumbers(), [2, 4, 1, 3]);
  assert.deepEqual(view.rows().map((row) => row.hidden), [true, true, false, false]);

  filter.value = '';
  filter.dispatch('input');
  assert.equal(view.visibleCount(), '4');
  assert.deepEqual(view.rowNumbers(), [2, 4, 1, 3], 'clearing the filter keeps the sort');

  filter.value = 'a';
  filter.dispatch('input');
  assert.equal(view.visibleCount(), '2');
  button.dispatch('click');
  assert.deepEqual(view.rowNumbers(), [3, 1, 4, 2]);
  assert.equal(filter.value, 'a');
  assert.equal(view.visibleCount(), '2');
});

test('shows the loaded-row scope and resets sort and filter on a re-render', () => {
  const { panel, html } = renderPanel(resultOf(['b1', 'a2', 'b3', 'a4']));
  assert.match(html, /排序与筛选仅作用于已加载的 4 行/);
  assert.match(html, /不改变复制和导出内容\/顺序/);

  const view = openPanel(html);
  view.filter().value = 'b';
  view.filter().dispatch('input');
  view.sortButtons()[0].dispatch('click');
  assert.equal(view.visibleCount(), '2');

  panel.update(resultOf(['z3', 'y1', 'x2']), {
    connectionName: 'demo',
    durationMs: 5,
    maxRows: 1000,
    readComplete: true,
  });
  const freshHtml = panel.panel.webview.html;
  assert.match(freshHtml, /已加载的 3 行/);
  const fresh = openPanel(freshHtml);
  assert.deepEqual(fresh.values(), ['z3', 'y1', 'x2'], 'a new query replaces the rendered rows');
  assert.deepEqual(fresh.rowNumbers(), [1, 2, 3]);
  assert.equal(fresh.status(), '原始顺序');
  assert.equal(fresh.headerSort(0), 'none');
  assert.equal(fresh.filter().value, '');
  assert.equal(fresh.visibleCount(), '3');
});

test('sorting and filtering never change copied content or the copy/export messages', async () => {
  const result = resultOf(['b1', 'a2', 'b3', 'a4']);
  const { panel, html } = renderPanel(result);
  const view = openPanel(html);

  view.filter().value = 'a';
  view.filter().dispatch('input');
  view.sortButtons()[0].dispatch('click');
  assert.deepEqual(view.values(), ['a2', 'a4', 'b1', 'b3']);
  assert.equal(view.visibleCount(), '2');
  assert.deepEqual(result.rows.map((row) => row.v), ['b1', 'a2', 'b3', 'a4'], 'DOM sorting never mutates the result rows');
  assert.equal(view.messages.length, 0);

  clipboard.text = undefined;
  await panel.copyToClipboard();
  assert.equal(
    clipboard.text,
    'v\r\nb1\r\na2\r\nb3\r\na4',
    'copy keeps every loaded row in its original order, ignoring sort and filter',
  );

  view.button('button[data-action="copy"]').dispatch('click');
  assert.deepEqual({ ...view.messages[0] }, { type: 'copy' });

  view.button('button[data-export="default"]').dispatch('click');
  assert.deepEqual({ ...view.messages[1] }, { type: 'export', format: 'tsv' });

  view.button('button[data-export="custom"]').dispatch('click');
  assert.deepEqual({ ...view.messages[2] }, { type: 'export', format: 'tsv', chooseLocation: true });
  assert.deepEqual(panel.result.rows.map((row) => row.v), ['b1', 'a2', 'b3', 'a4']);
});

test('feedback actions block overlapping toolbar actions and release them after cancellation or failure', () => {
  const view = openPanel(renderPanel(resultOf([1])).html);
  const copy = view.button('button[data-action="copy-feedback"]');
  const save = view.button('button[data-action="save-feedback"]');
  copy.dispatch('click');
  assert.equal(view.messages[0].type, 'copy-feedback');
  assert.equal(save.disabled, true);
  assert.equal(view.button('button[data-export="default"]').disabled, true);
  view.receive({ type: 'actionCancelled', action: 'feedback' });
  assert.equal(copy.disabled, false);
  assert.equal(save.disabled, false);
  save.dispatch('click');
  assert.equal(view.messages[1].type, 'save-feedback');
  view.receive({ type: 'actionFailed', action: 'feedback' });
  assert.equal(copy.disabled, false);
  assert.equal(save.disabled, false);
  assert.equal(save.textContent, save.dataset.defaultLabel);
});

test('renders safely escaped sort attributes and cell text', () => {
  const values = ['<img src=x onerror="alert(1)">', "O'Brien & <b>"];
  const result = resultOf(values, '<script>bad()</script>');
  const { html } = renderPanel(result);

  assert.ok(!html.includes('<img'), 'raw HTML from a value must never reach the markup');
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('data-sort-value="&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"'));
  assert.ok(html.includes('&lt;script&gt;bad()&lt;/script&gt;'));
  assert.ok(!inlineScript(html).includes('alert(1)'));

  const view = openPanel(html);
  assert.deepEqual(view.values(), values);
  view.sortButtons()[0].dispatch('click');
  assert.deepEqual(view.rowNumbers(), [1, 2]);
});

test('has no sortable table for DML and tolerates an empty SELECT', () => {
  const dml = renderPanel({ rows: [], columns: [], affectedRows: 3, truncated: false, totalRows: 0 });
  assert.ok(!dml.html.includes('id="result-filter"'));
  assert.ok(!dml.html.includes('id="sort-status"'));
  assert.doesNotThrow(() => openPanel(dml.html));

  const emptySelect = renderPanel({ rows: [], columns: ['x'], affectedRows: 0, truncated: false, totalRows: 0 });
  const view = openPanel(emptySelect.html);
  assert.match(emptySelect.html, /已加载的 0 行/);
  assert.equal(view.sortButtons().length, 1);
  assert.doesNotThrow(() => view.sortButtons()[0].dispatch('click'));
  assert.equal(view.status(), '按“x”升序');
  assert.deepEqual(view.rowNumbers(), []);
  assert.equal(view.visibleCount(), '0');
});
