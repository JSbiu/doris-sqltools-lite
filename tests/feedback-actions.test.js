const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const test = require('node:test');

function deferred() {
  let resolve;
  return { promise: new Promise((done) => { resolve = done; }), resolve: (value) => resolve(value) };
}

function fixture(t, options = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sqltools-feedback-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const uri = (file) => {
    const fsPath = path.resolve(file);
    const url = pathToFileURL(fsPath);
    return { scheme: 'file', fsPath, path: url.pathname, toString: () => url.href };
  };
  const source = uri(path.join(folder, 'orders.sql'));
  const script = path.join(folder, 'params.ps1');
  const report = uri(path.join(folder, 'orders.batch-report.json'));
  const summary = uri(path.join(folder, 'orders.feedback.md'));
  fs.writeFileSync(source.fsPath, 'source SQL');
  fs.writeFileSync(script, 'parameter script');
  const calls = { dialogs: [], clipboard: [], notices: [], providerWrites: [] };
  const sourceFlags = { path: source.fsPath, startLine: 1, endLine: 20,
    savedAtExecution: true, changedSinceExecution: false };
  const records = [
    { phase: 'init', name: '设置', parameters: {} },
    { phase: 'batch', batchIndex: 1, name: '清理', parameters: { day: '2026-10-29' } },
    { phase: 'batch', batchIndex: 1, name: '回填', parameters: { day: '2026-10-29' } },
  ].map((item) => ({ ...item, connectionName: '数仓', databaseType: 'Doris', startLine: 1, endLine: 4,
    status: 'success', submitted: true, durationMs: 2, affectedRows: null, sessionState: 'retained' }));
  const record = { sourceUri: source, currentSource: () => ({ ...sourceFlags }), startedAt: 0,
    value: { name: '补数', connectionName: '数仓', databaseType: 'Doris', parameters: {}, source: { ...sourceFlags },
      action: 'batch', status: 'success', submitted: true, generatedAt: '2026-10-29T01:00:00Z', durationMs: 6,
      batch: { script, batchCount: 1, completedBatches: 1, initSteps: ['设置'], steps: ['清理', '回填'], records } } };
  const vscode = {
    Uri: { file: uri, joinPath: (base, ...segments) => uri(path.resolve(base.fsPath, ...segments)) },
    env: { clipboard: { writeText: async (text) => calls.clipboard.push(text) } },
    workspace: { fs: { writeFile: async (target, bytes) => {
      calls.providerWrites.push(target);
      await fsp.writeFile(target.fsPath, bytes);
    } } },
    window: {
      showSaveDialog: async (request) => {
        calls.dialogs.push(request);
        return options.dialog ? options.dialog(request) : options.target;
      },
      showInformationMessage: async (text) => calls.notices.push(text),
    },
  };
  const filename = path.resolve(__dirname, '../out/feedbackActions.js');
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, Buffer, process,
    require: (id) => id === 'vscode' ? vscode
      : id === 'node:fs/promises' ? { ...fsp, ...options.fs } : realRequire(id),
  });
  module.exports.rememberFeedback(record);
  return { folder, source, script, report, summary, record, sourceFlags, calls, options, actions: module.exports };
}

function contents(markdown) { return JSON.parse(/```json\n([^\n]+)/.exec(markdown)[1]); }

test('first copy saves a full local report and later copies reuse it with current source flags', async (t) => {
  const h = fixture(t);
  h.options.target = h.report;
  assert.equal(await h.actions.copyFeedback(), true);
  const report = JSON.parse(fs.readFileSync(h.report.fsPath, 'utf8'));
  const summary = contents(h.calls.clipboard[0]);
  assert.equal(report.batch.records.length, 3);
  assert.equal(report.batch.records[2].affectedRows, null);
  assert.equal(summary.batch.records, undefined);
  assert.equal(summary.batchReportFile, h.report.fsPath);
  assert.equal(summary.source.path, h.source.fsPath);
  h.sourceFlags.changedSinceExecution = true;
  assert.equal(await h.actions.copyFeedback(), true);
  assert.equal(h.calls.dialogs.length, 1);
  assert.equal(contents(h.calls.clipboard[1]).source.changedSinceExecution, true);
  assert.equal(h.record.value.status, 'success');
});

test('saving Markdown first creates a companion report with one dialog and later reuses it', async (t) => {
  const h = fixture(t);
  h.options.target = h.summary;
  assert.equal(await h.actions.saveFeedback(), true);
  const data = contents(fs.readFileSync(h.summary.fsPath, 'utf8'));
  assert.match(data.batchReportFile, /\.batch-report\.json$/);
  assert.equal(path.dirname(data.batchReportFile), h.folder);
  assert.equal(JSON.parse(fs.readFileSync(data.batchReportFile, 'utf8')).batch.records.length, 3);
  assert.equal(h.calls.dialogs.length, 1);
  await h.actions.copyFeedback();
  assert.equal(h.calls.dialogs.length, 1);
  assert.equal(contents(h.calls.clipboard[0]).batchReportFile, data.batchReportFile);
  assert.equal(h.calls.providerWrites.length, 0);
});

test('cancelled dialogs leave no files or clipboard summary and release the action lock', async (t) => {
  const h = fixture(t);
  assert.equal(await h.actions.copyFeedback(), false);
  assert.equal(await h.actions.saveFeedback(), false);
  assert.equal(h.calls.clipboard.length, 0);
  assert.equal(h.record.value.batchReportFile, undefined);
  assert.deepEqual(fs.readdirSync(h.folder).sort(), ['orders.sql', 'params.ps1']);
  h.options.target = h.report;
  assert.equal(await h.actions.copyFeedback(), true);
});

test('unsubmitted tasks copy short feedback without requiring a report', async (t) => {
  const h = fixture(t);
  h.record.value.submitted = false;
  h.record.value.status = 'cancelled';
  for (const record of h.record.value.batch.records) Object.assign(record, { status: 'not-run', submitted: false });
  await h.actions.copyFeedback();
  assert.equal(h.calls.dialogs.length, 0);
  assert.equal(contents(h.calls.clipboard[0]).batchReportFile, undefined);
  assert.ok(contents(h.calls.clipboard[0]).batch.firstBatch.steps.every((step) => !step.submitted));
});

test('report writes protect SQL, parameter scripts and existing material', async (t) => {
  const h = fixture(t);
  fs.writeFileSync(h.report.fsPath, 'existing report');
  for (const target of [h.source, { ...h.source, fsPath: h.script, path: pathToFileURL(h.script).pathname }, h.report]) {
    h.options.target = target;
    await assert.rejects(h.actions.copyFeedback(), /报告未保存/);
    assert.equal(h.record.value.batchReportFile, undefined);
  }
  assert.equal(fs.readFileSync(h.source.fsPath, 'utf8'), 'source SQL');
  assert.equal(fs.readFileSync(h.script, 'utf8'), 'parameter script');
  assert.equal(fs.readFileSync(h.report.fsPath, 'utf8'), 'existing report');
  assert.equal(h.calls.clipboard.length, 0);
});

test('an existing summary is refused before creating a companion report', async (t) => {
  const h = fixture(t);
  fs.writeFileSync(h.summary.fsPath, 'existing Markdown');
  h.options.target = h.summary;
  await assert.rejects(h.actions.saveFeedback(), /已存在/);
  assert.equal(fs.readFileSync(h.summary.fsPath, 'utf8'), 'existing Markdown');
  assert.equal(fs.readdirSync(h.folder).filter((name) => name.endsWith('.json')).length, 0);
});

test('unsubmitted batch summaries also refuse existing paths and preserve hard-linked source files', async (t) => {
  const h = fixture(t);
  h.record.value.submitted = false;
  h.record.value.status = 'cancelled';
  for (const record of h.record.value.batch.records) Object.assign(record, { status: 'not-run', submitted: false });
  fs.linkSync(h.source.fsPath, h.summary.fsPath);
  h.options.target = h.summary;
  await assert.rejects(h.actions.saveFeedback(), /已存在/);
  assert.equal(fs.readFileSync(h.source.fsPath, 'utf8'), 'source SQL');
  fs.unlinkSync(h.summary.fsPath);
  await h.actions.saveFeedback();
  assert.equal(contents(fs.readFileSync(h.summary.fsPath, 'utf8')).submitted, false);
  assert.equal(h.record.value.batchReportFile, undefined);
  assert.equal(fs.readdirSync(h.folder).filter((name) => name.endsWith('.json')).length, 0);
});

test('non-local report paths are refused without claiming an artifact', async (t) => {
  const h = fixture(t);
  h.options.target = { scheme: 'memory', path: '/report.json', toString: () => 'memory:/report.json' };
  await assert.rejects(h.actions.copyFeedback(), /本地文件/);
  assert.equal(h.record.value.batchReportFile, undefined);
  assert.equal(h.calls.clipboard.length, 0);
});

test('a permission failure preserves the SQL result and allows retrying only the report save', async (t) => {
  let denied = true;
  let attempts = 0;
  const h = fixture(t, { fs: { open: async (...args) => {
    attempts++;
    if (denied) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return fsp.open(...args);
  } } });
  h.options.target = h.report;
  await assert.rejects(h.actions.copyFeedback(), /报告未保存/);
  assert.equal(h.record.value.status, 'success');
  assert.equal(h.record.value.submitted, true);
  assert.equal(h.record.value.batchReportFile, undefined);
  denied = false;
  await h.actions.copyFeedback();
  assert.equal(attempts, 2);
  assert.equal(h.calls.clipboard.length, 1);
});

for (const fault of ['write', 'close']) {
  test(`a ${fault} failure removes the owned incomplete report and publishes no path`, async (t) => {
    let failed = false;
    const h = fixture(t, { fs: { open: async (...args) => {
      const file = await fsp.open(...args);
      return {
        writeFile: async (text, encoding) => {
          await file.writeFile(fault === 'write' ? 'partial' : text, encoding);
          if (fault === 'write') throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        },
        close: async () => {
          if (fault === 'close' && !failed) { failed = true; throw new Error('close failed'); }
          await file.close();
        },
      };
    } } });
    h.options.target = h.report;
    await assert.rejects(h.actions.copyFeedback(), /报告未保存/);
    assert.equal(fs.existsSync(h.report.fsPath), false);
    assert.equal(h.record.value.batchReportFile, undefined);
    assert.equal(h.calls.clipboard.length, 0);
    assert.equal(h.record.value.status, 'success');
  });
}

test('cleanup failure exposes the incomplete residue without marking it as a completed report', async (t) => {
  const h = fixture(t, { fs: {
    open: async (...args) => {
      const file = await fsp.open(...args);
      return { writeFile: async () => { await file.writeFile('partial'); throw new Error('disk full'); }, close: () => file.close() };
    },
    unlink: async () => { throw new Error('cleanup denied'); },
  } });
  h.options.target = h.report;
  await assert.rejects(h.actions.copyFeedback(), (error) => {
    assert.match(error.message, /报告未保存.*残留文件无法清理/);
    assert.ok(error.message.includes(h.report.fsPath));
    return true;
  });
  assert.equal(h.record.value.batchReportFile, undefined);
  assert.equal(fs.readFileSync(h.report.fsPath, 'utf8'), 'partial');
});

test('duplicate copy and save clicks share one pending action and another record remains independent', async (t) => {
  const prompt = deferred();
  const shown = deferred();
  const h = fixture(t, { dialog: () => { shown.resolve(); return prompt.promise; } });
  const copying = h.actions.copyFeedback();
  await shown.promise;
  assert.equal(await h.actions.copyFeedback(), false);
  assert.equal(await h.actions.saveFeedback(), false);
  assert.equal(h.calls.dialogs.length, 1);
  const ordinary = { ...h.record, value: { ...h.record.value, action: 'query', batch: undefined } };
  assert.equal(await h.actions.copyFeedback(ordinary), true);
  prompt.resolve(h.report);
  assert.equal(await copying, true);
  assert.equal(h.calls.clipboard.length, 2);
});

test('a removed saved report is recreated before another summary is copied', async (t) => {
  const h = fixture(t);
  h.options.target = h.report;
  await h.actions.copyFeedback();
  fs.unlinkSync(h.report.fsPath);
  await h.actions.copyFeedback();
  assert.equal(h.calls.dialogs.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(h.report.fsPath, 'utf8')).batch.records.length, 3);
});

test('Markdown write failure retains a successful report for a later save or copy', async (t) => {
  const h = fixture(t, { fs: { open: async (filePath, ...args) => {
    if (filePath.endsWith('.md')) throw new Error('summary permission denied');
    return fsp.open(filePath, ...args);
  } } });
  h.options.target = h.summary;
  await assert.rejects(h.actions.saveFeedback(), /summary permission denied/);
  assert.equal(fs.existsSync(h.record.value.batchReportFile), true);
  assert.equal(h.record.value.status, 'success');
  await h.actions.copyFeedback();
  assert.equal(h.calls.dialogs.length, 1);
  assert.equal(contents(h.calls.clipboard[0]).batchReportFile, h.record.value.batchReportFile);
});
