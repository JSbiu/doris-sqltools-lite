const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');
const { parseSqlParameters } = require('../out/sqlParameters');

function projection(mode = 'encrypted', rules = { remembered: 'id', fixed: 'id', inline: 'id', choice: 'id', needed: 'id' }) {
  const ciphers = new Map();
  const make = (mode) => ({
    mode, rules, info: { mode, keyId: 'test-key', fields: rules },
    value(name, value) {
      if (mode !== 'encrypted' || !Object.hasOwn(rules, name)) return value;
      if (!ciphers.has(value)) ciphers.set(value, `cipher-${ciphers.size + 1}`);
      return ciphers.get(value);
    },
    parameters(values) { return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, this.value(name, value)])); },
    withMode: make,
  });
  return make(mode);
}

function inputs(protection) {
  const sql = [
    '-- @param: fixed = sensitive-fixed-291',
    "SELECT 'hardcoded-sql-453', '${remembered}', '${fixed}',",
    "'${inline=sensitive-default-728(default-label)}',",
    "'${choice=sensitive-choice-852(choice-label-852), sensitive-choice-973(choice-label-973)}',",
    "'${needed}', '${day=2026-10-30(today-label)}';",
  ].join('\n');
  return { documentLabel: 'query.sql', sql, parameters: parseSqlParameters(sql), protection,
    initialValues: { remembered: 'sensitive-remembered-184' }, fixedValues: { fixed: 'sensitive-fixed-291' } };
}

function openForm(inputs) {
  const calls = { messages: [] };
  let handler;
  let dispose;
  const panel = {
    webview: { html: '', onDidReceiveMessage(callback) { handler = callback; },
      postMessage: async (message) => { calls.messages.push(message); } },
    onDidDispose(callback) { dispose = callback; },
    dispose() { dispose(); },
  };
  const filename = path.resolve(__dirname, '../out/parameterForm.js');
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports,
    require: (id) => id === 'vscode'
      ? { ViewColumn: { Active: 1 }, window: { createWebviewPanel: () => panel } } : realRequire(id),
  });
  const decision = module.exports.openParameterForm(inputs);
  return { panel, calls, decision, send: (type, values) => handler({ type, values }) };
}

function pageScript(panel) {
  const decode = (text) => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const element = () => ({ listeners: {}, textContent: '', disabled: false,
    addEventListener(event, callback) { this.listeners[event] = callback; }, focus() {} });
  const elements = new Map([...panel.webview.html.matchAll(/\bid="([^"]+)"/g)].map((match) => [match[1], element()]));
  const fields = [...panel.webview.html.matchAll(/<input\b([^>]+)>/g)].map((match) => {
    const attrs = new Map([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((attr) => [attr[1], decode(attr[2])]));
    return { ...element(), value: attrs.get('value'), getAttribute: (name) => attrs.get(name) };
  });
  const posted = [];
  let receive;
  vm.runInNewContext(/<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(panel.webview.html)[1], {
    acquireVsCodeApi: () => ({ postMessage: (message) => posted.push(message) }),
    document: { getElementById: (id) => elements.get(id), querySelectorAll: () => fields },
    window: { addEventListener: (_event, callback) => { receive = callback; } },
  });
  return { elements, fields, posted, receive: (data) => receive({ data }) };
}

const sensitive = ['sensitive-remembered-184', 'sensitive-fixed-291', 'sensitive-default-728',
  'sensitive-choice-852', 'sensitive-choice-973', 'default-label', 'choice-label-852', 'choice-label-973', 'hardcoded-sql-453'];

function assertProtected(value) {
  for (const text of sensitive) assert.ok(!value.includes(text), `leaked ${text}`);
}

test('encrypted form projects remembered, fixed, inline and candidate values before any HTML or page message', async () => {
  const protection = projection();
  const h = openForm(inputs(protection));
  assertProtected(h.panel.webview.html);
  assert.match(h.panel.webview.html, /加密模式下不展示 SQL/);
  assert.match(h.panel.webview.html, /<option value="cipher-\d+">/);
  const page = pageScript(h.panel);
  const values = page.posted[0].values;
  assert.equal(values.remembered, protection.value('remembered', sensitive[0]));
  assert.equal(values.fixed, protection.value('fixed', sensitive[1]));
  assert.equal(values.inline, protection.value('inline', sensitive[2]));
  assert.equal(values.choice, '');
  assert.equal(values.needed, '');
  assert.equal(values.day, '2026-10-30');
  assertProtected(JSON.stringify(page.posted));
  h.send('preview', values);
  const preview = h.calls.messages.at(-1);
  assertProtected(JSON.stringify(preview));
  assert.deepEqual([...preview.missing], ['choice', 'needed']);
  page.receive(preview);
  assert.equal(page.elements.get('b-run').disabled, true);
  assert.match(page.elements.get('preview').textContent, /明文模式/);
  h.send('cancel');
  assert.equal(await h.decision, undefined);
});

test('encrypted execution returns ciphers, enforces fixed values and leaves SQL comment authority untouched', async () => {
  const protection = projection();
  const original = inputs(protection);
  Object.freeze(original.fixedValues);
  Object.freeze(original.initialValues);
  const before = JSON.stringify(original);
  const h = openForm(original);
  const page = pageScript(h.panel);
  const values = { ...page.posted[0].values, fixed: 'forged',
    choice: protection.value('choice', sensitive[3]), needed: 'cipher-manual', extra: 'ignored' };
  h.send('preview', values);
  assertProtected(JSON.stringify(h.calls.messages));
  assert.equal(h.calls.messages.at(-1).missing.length, 0);
  page.receive(h.calls.messages.at(-1));
  assert.equal(page.elements.get('b-run').disabled, false);
  h.send('run', values);
  const decision = await h.decision;
  assert.equal(decision.action, 'execute');
  assert.equal(decision.values.fixed, protection.value('fixed', sensitive[1]));
  assert.equal(decision.values.choice, protection.value('choice', sensitive[3]));
  assert.equal(Object.hasOwn(decision.values, 'extra'), false);
  assertProtected(JSON.stringify(decision));
  assert.equal(JSON.stringify(original), before);
  assert.equal(original.fixedValues.fixed, sensitive[1]);
});

test('parameter form keeps the mode captured at creation and a reopened plain form restores values and SQL preview', async () => {
  const protection = projection();
  const original = inputs(protection);
  const encrypted = openForm(original);
  protection.mode = 'plain';
  encrypted.send('preview', {});
  assertProtected(JSON.stringify(encrypted.calls.messages));
  encrypted.send('cancel');
  await encrypted.decision;
  const plain = openForm({ ...original, protection: protection.withMode('plain') });
  for (const value of sensitive.slice(0, -1)) assert.ok(plain.panel.webview.html.includes(value));
  const page = pageScript(plain.panel);
  plain.send('preview', { ...page.posted[0].values, choice: sensitive[3], needed: 'entered-value' });
  assert.ok(plain.calls.messages.at(-1).sql.includes('hardcoded-sql-453'));
  assert.ok(plain.calls.messages.at(-1).sql.includes(sensitive[1]));
  assert.equal(plain.calls.messages.at(-1).missing.length, 0);
  plain.send('run', { ...page.posted[0].values, fixed: 'forged', choice: sensitive[3], needed: 'entered-value' });
  assert.equal((await plain.decision).values.fixed, sensitive[1]);
});

test('unconfigured and empty-rule forms retain candidates, labels, SQL preview and raw-send behavior', async () => {
  const normal = openForm(inputs());
  const noRules = openForm(inputs(projection('encrypted', {})));
  const normalizeNonce = (html) => html.replace(/nonce-[a-f0-9]+/g, 'nonce-test').replace(/nonce="[a-f0-9]+"/g, 'nonce="test"');
  assert.equal(normalizeNonce(normal.panel.webview.html), normalizeNonce(noRules.panel.webview.html));
  assert.match(normal.panel.webview.html, /choice-label-852/);
  assert.match(normal.panel.webview.html, /value="sensitive-fixed-291" readonly/);
  const page = pageScript(normal.panel);
  normal.send('preview', page.posted[0].values);
  assert.ok(normal.calls.messages.at(-1).sql.includes('hardcoded-sql-453'));
  normal.send('raw');
  assert.equal((await normal.decision).action, 'raw');
  noRules.send('cancel');
  await noRules.decision;
});
