const assert = require('node:assert/strict');
const test = require('node:test');
const { BatchProgress } = require('../out/batchProgress');

function virtualClock() {
  let now = 0;
  const timers = new Set();
  const callbacks = [];
  const intervals = [];
  let disposals = 0;
  return {
    options: {
      now: () => now,
      schedule(callback, intervalMs) {
        const timer = { callback, intervalMs, next: now + intervalMs };
        timers.add(timer);
        callbacks.push(callback);
        intervals.push(intervalMs);
        return { dispose() { timers.delete(timer); disposals++; } };
      },
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = Math.min(...[...timers].map((timer) => timer.next));
        if (next > end) break;
        now = next;
        for (const timer of timers) {
          if (timer.next !== now) continue;
          timer.next += timer.intervalMs;
          timer.callback();
        }
      }
      now = end;
    },
    callbacks,
    intervals,
    get pending() { return timers.size; },
    get disposals() { return disposals; },
  };
}

function step(overrides = {}) {
  return {
    phase: 'batch', batchIndex: 1, name: '回填当天', connectionName: '数仓测试', databaseType: 'Doris',
    parameters: { biz_date: '2026-10-18' }, startLine: 10, endLine: 12,
    status: 'not-run', submitted: false, durationMs: 0, sessionState: 'not-opened', ...overrides,
  };
}

function feedback(records = [step()]) {
  return { script: 'params.ps1', batchCount: 60, completedBatches: 0, initSteps: [], steps: ['回填当天'], records };
}

function fixture(t, clock = virtualClock()) {
  const messages = [];
  const progress = new BatchProgress((message) => messages.push(message), clock.options);
  t.after(() => progress.dispose());
  return { clock, messages, progress, latest: () => messages.at(-1) };
}

test('live mode changes replace parameter text immediately without changing execution records or task counters', (t) => {
  const { createDataKey } = require('../out/fieldEncryption');
  const { createProtection, setDataMode, getDataMode } = require('../out/dataProtection');
  const key = createDataKey();
  const protection = createProtection({ biz_date: 'date' }, [], key, () => key, 'encrypted');
  const clock = virtualClock(); const messages = [];
  const progress = new BatchProgress((message) => messages.push(message), { ...clock.options,
    parameters: (record) => protection.withMode(getDataMode()).parameters(record.parameters) });
  t.after(() => { progress.dispose(); setDataMode('encrypted'); });
  const record = step({ parameters: { biz_date: 'private-parameter' } });
  const live = feedback([record]); progress.prepare(live); progress.startTask();
  setDataMode('plain'); progress.setStep(record); assert.match(messages.at(-1), /private-parameter/);
  setDataMode('encrypted'); progress.refresh();
  assert.ok(!messages.at(-1).includes('private-parameter')); assert.match(messages.at(-1), /enc:v1:/);
  live.completedBatches = 1; clock.advance(1000); assert.match(messages.at(-1), /已完成 1\/60 批/);
  assert.equal(record.parameters.biz_date, 'private-parameter');
});

test('generation and confirmation refresh elapsed time without starting the task clock', (t) => {
  const { clock, messages, progress, latest } = fixture(t);
  assert.match(latest(), /^生成参数 · 任务未启动 · 阶段 0秒$/);
  assert.deepEqual(clock.intervals, [1000]);
  clock.advance(999);
  assert.equal(messages.length, 1);
  clock.advance(1);
  assert.match(latest(), /生成参数.*阶段 1秒$/);
  progress.prepare(feedback());
  assert.match(latest(), /^等待启动 · 已完成 0\/60 批 · 任务未启动 · 阶段 0秒$/);
  clock.advance(10_000);
  assert.match(latest(), /等待启动.*任务未启动 · 阶段 10秒$/);
  progress.startTask();
  assert.match(latest(), /^执行 SQL.*任务 0秒$/);
  assert.doesNotMatch(latest(), /任务未启动|本步/);
});

test('a silent SQL step refreshes every second and a new step resets only its own elapsed time', (t) => {
  const { clock, messages, progress, latest } = fixture(t);
  const first = step();
  const second = step({ name: '核对当天', parameters: { biz_date: '2026-10-19' } });
  const batch = feedback([first, second]);
  progress.prepare(batch);
  progress.startTask();
  clock.advance(2000);
  progress.setStep(first);
  const count = messages.length;
  clock.advance(65_000);
  assert.equal(messages.length - count, 65);
  assert.match(messages[count], /任务 3秒 · 本步 1秒$/);
  assert.match(latest(), /第 1 批 · 步骤：回填当天 · 连接：数仓测试 · 参数：biz_date=2026-10-18/);
  assert.match(latest(), /任务 1分7秒 · 本步 1分5秒$/);
  progress.setStep(second);
  assert.match(latest(), /核对当天.*biz_date=2026-10-19.*任务 1分7秒 · 本步 0秒$/);
  assert.doesNotMatch(latest(), /2026-10-18|%|ETA|预计/);
  clock.advance(1000);
  assert.match(latest(), /任务 1分8秒 · 本步 1秒$/);
});

test('connection preparation and cancellation retain the current step and keep timing until disposal', (t) => {
  const { clock, progress, latest } = fixture(t);
  const record = step();
  progress.prepare(feedback([record]));
  progress.startTask();
  progress.setStep(record);
  clock.advance(2000);
  progress.setPhase('connecting', '备用测试');
  assert.match(latest(), /^准备会话.*连接：备用测试.*任务 2秒 · 本步 2秒$/);
  clock.advance(1000);
  progress.setPhase('executing');
  assert.match(latest(), /^执行 SQL.*连接：备用测试.*本步 3秒$/);
  progress.setPhase('cancelling');
  clock.advance(3000);
  assert.match(latest(), /^取消收尾.*第 1 批.*biz_date=2026-10-18.*任务 6秒 · 本步 6秒$/);
  assert.equal(clock.pending, 1);
  assert.equal(record.connectionName, '数仓测试');
});

test('cancellation during parameter generation also refreshes without claiming SQL was started', (t) => {
  const { clock, progress, latest } = fixture(t);
  clock.advance(2000);
  progress.setPhase('cancelling');
  clock.advance(3000);
  assert.match(latest(), /^取消收尾 · 任务未启动 · 阶段 3秒$/);
  assert.doesNotMatch(latest(), /已完成|第 .* 批|本步/);
});

test('initialization uses its own actual parameters and is distinct from a numbered batch', (t) => {
  const { progress, latest } = fixture(t);
  const init = step({ phase: 'init', batchIndex: undefined, name: '设置会话', parameters: {} });
  progress.prepare(feedback([init, step()]));
  progress.startTask();
  progress.setStep(init);
  assert.match(latest(), /已完成 0\/60 批 · 初始化 · 步骤：设置会话.*参数：无.*本步 0秒$/);
  assert.doesNotMatch(latest(), /第 .* 批|undefined|biz_date/);
});

test('completion follows the live whole-batch counter rather than successful steps', (t) => {
  const { clock, progress, latest } = fixture(t);
  const records = [step({ name: '清理' }), step(), step({ batchIndex: 2 })];
  const batch = feedback(records);
  progress.prepare(batch);
  progress.startTask();
  progress.setStep(records[0]);
  records[0].status = 'success';
  clock.advance(1000);
  assert.match(latest(), /已完成 0\/60 批/);
  records[1].status = 'success';
  batch.completedBatches = 1;
  clock.advance(1000);
  assert.match(latest(), /已完成 1\/60 批/);
  progress.setStep(records[2]);
  assert.match(latest(), /已完成 1\/60 批 · 第 2 批/);
  assert.doesNotMatch(latest(), /%|ETA|预计/);
});

test('many parameters are explicitly omitted from the notification and remain intact in feedback', (t) => {
  const { progress, latest } = fixture(t);
  const record = step({ parameters: { day: '2026-10-18', region: 'east', kind: 'sales', extra: 'fourth-value' } });
  const batch = feedback([record]);
  const original = structuredClone(batch);
  progress.prepare(batch);
  progress.startTask();
  progress.setStep(record);
  assert.match(latest(), /参数：day=2026-10-18，region=east，kind=sales（已省略，完整参数见报告）/);
  assert.doesNotMatch(latest(), /extra|fourth-value/);
  assert.deepEqual(batch, original);
});

test('long and multiline parameters have bounded single-line summaries with an explicit omission notice', (t) => {
  const { clock, progress, latest } = fixture(t);
  const record = step({ parameters: {
    long: 'x'.repeat(10_000), multiline: 'first\r\nHIDDEN_LINE', unicode: 'visible\u2028HIDDEN_UNICODE_LINE',
  } });
  const batch = feedback([record]);
  const original = structuredClone(batch);
  progress.prepare(batch);
  progress.startTask();
  progress.setStep(record);
  clock.advance(1000);
  assert.match(latest(), /long=x+…，multiline=first…，unicode=visible…（已省略，完整参数见报告）/);
  assert.doesNotMatch(latest(), /[\r\n\u2028\u2029]|HIDDEN/);
  assert.ok(latest().length < 300);
  assert.deepEqual(batch, original);
});

test('a long parameter name is also bounded and short actual values are displayed without omission', (t) => {
  const { progress, latest } = fixture(t);
  progress.prepare(feedback());
  progress.startTask();
  progress.setStep(step({ parameters: { ['long_key'.repeat(1000)]: 'retained-in-report' } }));
  assert.ok(latest().length < 250);
  assert.match(latest(), /已省略，完整参数见报告/);
  progress.setStep(step({ parameters: { flag: 'false', count: '0', day: '2026-10-18' } }));
  assert.match(latest(), /参数：flag=false，count=0，day=2026-10-18/);
  assert.doesNotMatch(latest(), /省略|…/);
});

test('dispose clears its timer once and blocks late callbacks and all later updates', (t) => {
  const { clock, messages, progress } = fixture(t);
  const batch = feedback();
  progress.prepare(batch);
  progress.startTask();
  progress.setStep(batch.records[0]);
  const count = messages.length;
  progress.dispose();
  progress.dispose();
  assert.equal(clock.pending, 0);
  assert.equal(clock.disposals, 1);
  clock.advance(5000);
  clock.callbacks[0]();
  progress.prepare(feedback());
  progress.startTask();
  progress.setStep(step());
  progress.setPhase('cancelling');
  assert.equal(messages.length, count);
  assert.equal(clock.pending, 0);
});

test('parallel file notifications keep independent clocks, parameters, counts and timer lifetimes', (t) => {
  const clock = virtualClock();
  const first = fixture(t, clock);
  const second = fixture(t, clock);
  const a = feedback([step({ connectionName: '文件A连接', parameters: { day: 'A' } })]);
  const b = feedback([step({ connectionName: '文件B连接', parameters: { day: 'B' } })]);
  b.batchCount = 3;
  first.progress.prepare(a);
  first.progress.startTask();
  first.progress.setStep(a.records[0]);
  clock.advance(2000);
  second.progress.prepare(b);
  second.progress.startTask();
  second.progress.setStep(b.records[0]);
  a.completedBatches = 1;
  clock.advance(1000);
  assert.match(first.latest(), /已完成 1\/60 批.*文件A连接.*day=A.*任务 3秒 · 本步 3秒$/);
  assert.match(second.latest(), /已完成 0\/3 批.*文件B连接.*day=B.*任务 1秒 · 本步 1秒$/);
  assert.doesNotMatch(first.latest(), /文件B|day=B/);
  assert.doesNotMatch(second.latest(), /文件A|day=A/);
  first.progress.dispose();
  const count = first.messages.length;
  second.progress.setPhase('cancelling');
  clock.advance(2000);
  clock.callbacks[0]();
  assert.equal(first.messages.length, count);
  assert.equal(clock.pending, 1);
  assert.match(second.latest(), /^取消收尾.*任务 3秒 · 本步 3秒$/);
  second.progress.dispose();
  assert.equal(clock.pending, 0);
});
