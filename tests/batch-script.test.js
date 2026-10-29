const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { runBatchScript } = require('../out/batchScript');
const { neverCancelled, QueryCancelledError } = require('../out/querySession');
const diagnosticValue = randomUUID();
const diagnosticPhrase = `${randomUUID()} with spaces`;

const tick = () => new Promise((done) => setImmediate(done));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function cancellation() {
  const listeners = new Set();
  let requested = false;
  return {
    get requested() { return requested; },
    get reason() { return requested ? 'user' : undefined; },
    onRequest(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    cancel() { requested = true; for (const listener of [...listeners]) listener(); },
    get listenerCount() { return listeners.size; },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, source = '# fake process fixture', filename = "参数 ' $(); [x].ps1") {
  const directory = await fs.mkdtemp(join(tmpdir(), 'doris-batch-script-'));
  const script = join(directory, filename);
  await fs.writeFile(script, '\ufeff' + source, 'utf8');
  t.after(async () => {
    // Verify the resolved deletion target stays in the system temporary folder.
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('doris-batch-script-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, script };
}

function childProcess(pid = 12345) {
  const child = new EventEmitter();
  Object.assign(child, {
    pid, stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null, directKills: [],
    kill(signal) { this.directKills.push(signal); finish(this, null, signal); return true; },
  });
  return child;
}

function exit(child, code = 0, signal = null) {
  child.exitCode = code;
  child.signalCode = signal;
  child.emit('exit', code, signal);
}

function close(child, code = child.exitCode, signal = child.signalCode) {
  child.stdout.end();
  child.stderr.end();
  child.emit('close', code, signal);
}

function finish(child, code = 0, signal = null) {
  exit(child, code, signal);
  close(child, code, signal);
}

function runtime(onScript, platform = 'win32') {
  const calls = [];
  const ready = deferred();
  const children = [];
  const dependencies = {
    platform,
    spawn(command, args, options) {
      calls.push({ command, args, options });
      const child = childProcess(12345 + children.length);
      children.push(child);
      if (command === 'taskkill') {
        queueMicrotask(() => { finish(children[0], null, 'SIGKILL'); finish(child); });
      } else {
        queueMicrotask(() => { child.emit('spawn'); onScript(child, calls.length); ready.resolve(child); });
      }
      return child;
    },
    kill(pid, signal) { calls.push({ pid, signal }); finish(children[0], null, signal); return true; },
  };
  return { dependencies, calls, children, ready: ready.promise };
}

test('rejects non-ps1 paths, missing files and directory paths before spawning', async (t) => {
  const f = await fixture(t);
  let spawned = false;
  const dependencies = { spawn() { spawned = true; throw new Error('unexpected spawn'); } };
  await assert.rejects(runBatchScript('params.sh', f.directory, neverCancelled, dependencies), /\.ps1/);
  await assert.rejects(runBatchScript('missing.ps1', f.directory, neverCancelled, dependencies), /文件不存在/);
  const directory = join(f.directory, 'directory.ps1');
  await fs.mkdir(directory);
  await assert.rejects(runBatchScript(directory, f.directory, neverCancelled, dependencies), /不是文件/);
  assert.equal(spawned, false);
});

test('an already cancelled request never starts a process', async () => {
  const signal = cancellation();
  signal.cancel();
  await assert.rejects(runBatchScript('missing.ps1', tmpdir(), signal, {
    spawn() { assert.fail('cancelled script must not start'); },
  }), QueryCancelledError);
  assert.equal(signal.listenerCount, 0);
});

test('returns stdout verbatim, reconstructs split UTF-8 and permits stderr with exit zero', async (t) => {
  const f = await fixture(t, '', '中文.PS1');
  const signal = cancellation();
  const expected = '  [{"name":"中文😀"}]\r\n';
  const h = runtime((child) => {
    const bytes = Buffer.from(expected);
    for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
    child.stderr.write('普通诊断');
    finish(child);
  });
  assert.equal(await runBatchScript(basename(f.script), f.directory, signal, h.dependencies), expected);
  const launch = h.calls[0];
  assert.equal(launch.command, 'pwsh');
  assert.equal(launch.options.cwd, f.directory);
  assert.equal(launch.options.shell, false);
  assert.equal(launch.options.windowsHide, true);
  assert.equal(launch.options.stdio[0], 'ignore');
  assert.equal(launch.options.env.DORIS_SQLTOOLS_BATCH_SCRIPT_PATH, f.script);
  assert.equal(launch.args.some((arg) => /ExecutionPolicy/i.test(arg)), false);
  const bootstrap = Buffer.from(launch.args.at(-1), 'base64').toString('utf16le');
  assert.equal(bootstrap.includes(f.script), false);
  assert.equal(signal.listenerCount, 0);
  signal.cancel();
  assert.equal(h.calls.length, 1);
});

test('leaves JSON validation to the caller', async (t) => {
  const f = await fixture(t);
  const h = runtime((child) => { child.stdout.write('not JSON\n'); finish(child); });
  assert.equal(await runBatchScript(f.script, f.directory, neverCancelled, h.dependencies), 'not JSON\n');
});

test('Windows falls back only after pwsh ENOENT has closed', async (t) => {
  const f = await fixture(t);
  const calls = [];
  const failed = childProcess();
  failed.pid = undefined;
  const fallback = childProcess();
  const errorSeen = deferred();
  const dependencies = {
    platform: 'win32',
    spawn(command) {
      calls.push(command);
      if (command === 'pwsh') {
        queueMicrotask(() => {
          failed.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' }));
          errorSeen.resolve();
        });
        return failed;
      }
      queueMicrotask(() => { fallback.emit('spawn'); fallback.stdout.write('[]'); finish(fallback); });
      return fallback;
    },
  };
  const running = runBatchScript(f.script, f.directory, neverCancelled, dependencies);
  await errorSeen.promise;
  await tick();
  assert.deepEqual(calls, ['pwsh']);
  close(failed, -2);
  assert.equal(await running, '[]');
  assert.deepEqual(calls, ['pwsh', 'powershell.exe']);
});

test('Windows also handles a synchronous ENOENT without replaying a started script', async (t) => {
  const f = await fixture(t);
  const h = runtime((child) => { child.stdout.write('[]'); finish(child); });
  const spawn = h.dependencies.spawn;
  h.dependencies.spawn = (command, ...args) => {
    if (command === 'pwsh') {
      h.calls.push({ command });
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    }
    return spawn(command, ...args);
  };
  assert.equal(await runBatchScript(f.script, f.directory, neverCancelled, h.dependencies), '[]');
  assert.deepEqual(h.calls.map((call) => call.command), ['pwsh', 'powershell.exe']);
});

for (const scenario of ['permission', 'exit', 'running ENOENT']) {
  test(`does not fall back for ${scenario} failure and redacts diagnostics`, async (t) => {
    const f = await fixture(t);
    const h = runtime((child) => {
      if (scenario === 'exit') {
        child.stderr.write(`失败 password="${diagnosticPhrase}" token=${diagnosticValue}`);
        finish(child, 7);
      } else if (scenario === 'running ENOENT') {
        child.emit('error', Object.assign(new Error(`password=${diagnosticValue}`), { code: 'ENOENT' }));
      } else {
        assert.fail('permission failure must occur before spawn');
      }
    });
    if (scenario === 'permission') {
      h.dependencies.spawn = () => {
        h.calls.push({ command: 'pwsh' });
        throw Object.assign(new Error(`EACCES password=${diagnosticValue}`), { code: 'EACCES' });
      };
    }
    await assert.rejects(runBatchScript(f.script, f.directory, neverCancelled, h.dependencies), (error) => {
      assert.match(error.message, /\[redacted\]/);
      assert.ok(!error.message.includes(diagnosticPhrase) && !error.message.includes(diagnosticValue));
      if (scenario === 'exit') assert.match(error.message, /退出码 7/);
      return true;
    });
    assert.equal(h.calls.filter((call) => call.command === 'pwsh').length, 1);
    assert.equal(h.calls.some((call) => call.command === 'powershell.exe'), false);
  });
}

test('non-Windows ENOENT reports missing pwsh without attempting Windows PowerShell', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  await assert.rejects(runBatchScript(f.script, f.directory, neverCancelled, {
    platform: 'linux',
    spawn() { calls++; throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  }), /未找到 PowerShell/);
  assert.equal(calls, 1);
});

test('missing both Windows interpreters reports an understandable error', async (t) => {
  const f = await fixture(t);
  const commands = [];
  await assert.rejects(runBatchScript(f.script, f.directory, neverCancelled, {
    platform: 'win32',
    spawn(command) { commands.push(command); throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  }), /未找到 PowerShell/);
  assert.deepEqual(commands, ['pwsh', 'powershell.exe']);
});

test('accepts output exactly at both byte limits', async (t) => {
  const f = await fixture(t);
  const h = runtime((child) => {
    child.stdout.write(Buffer.alloc(4 * 1024 * 1024, 'x'));
    child.stderr.write(Buffer.alloc(8 * 1024, 'e'));
    finish(child);
  });
  assert.equal((await runBatchScript(f.script, f.directory, neverCancelled, h.dependencies)).length, 4 * 1024 * 1024);
  assert.equal(h.calls.length, 1);
});

for (const stream of ['stdout', 'stderr']) {
  test(`${stream} overflow kills once and rejects after the script and taskkill close`, async (t) => {
    const f = await fixture(t);
    const signal = cancellation();
    const child = childProcess();
    const killer = childProcess(12346);
    const killed = deferred();
    const calls = [];
    const dependencies = {
      platform: 'win32',
      spawn(command, args, options) {
        calls.push({ command, args, options });
        if (command === 'taskkill') { killed.resolve(); return killer; }
        queueMicrotask(() => {
          child.emit('spawn');
          if (stream === 'stdout') child.stdout.write(Buffer.alloc(4 * 1024 * 1024 + 1, 'x'));
          else child.stderr.write('password="' + `${diagnosticPhrase} `.repeat(1000));
          // Further output is discarded, including any additional overflow.
          child[stream].write(Buffer.alloc(64 * 1024, 'y'));
        });
        return child;
      },
    };
    const running = runBatchScript(f.script, f.directory, signal, dependencies);
    let settled = false;
    const rejected = assert.rejects(running, (error) => {
      assert.match(error.message, stream === 'stdout' ? /stdout 超过 4 MiB/ : /stderr 超过 8 KiB/);
      if (stream === 'stderr') {
        assert.match(error.message, /\[redacted\]/);
        assert.match(error.message, /已截断/);
        assert.ok(!error.message.includes(diagnosticPhrase));
        assert.ok(Buffer.byteLength(error.message) < 8 * 1024 + 256);
      }
      settled = true;
      return true;
    });
    await killed.promise;
    await tick();
    assert.equal(settled, false);
    finish(child, null, 'SIGKILL');
    await tick();
    assert.equal(settled, false, 'taskkill must close too');
    finish(killer);
    await rejected;
    assert.deepEqual(calls.map((call) => call.command), ['pwsh', 'taskkill']);
    assert.equal(signal.listenerCount, 0);
  });
}

test('cancellation terminates the Windows tree and waits for both close events', async (t) => {
  const f = await fixture(t);
  const signal = cancellation();
  const child = childProcess();
  const killer = childProcess(12346);
  const ready = deferred();
  const calls = [];
  const dependencies = {
    platform: 'win32',
    spawn(command, args, options) {
      calls.push({ command, args, options });
      if (command === 'taskkill') return killer;
      queueMicrotask(() => { child.emit('spawn'); ready.resolve(); });
      return child;
    },
  };
  let settled = false;
  const running = runBatchScript(f.script, f.directory, signal, dependencies);
  const rejected = assert.rejects(running, QueryCancelledError).then(() => { settled = true; });
  await ready.promise;
  signal.cancel();
  signal.cancel();
  assert.deepEqual(calls.map((call) => call.command), ['pwsh', 'taskkill']);
  assert.deepEqual(calls[1].args, ['/PID', '12345', '/T', '/F']);
  assert.equal(calls[1].options.windowsHide, true);
  assert.equal(calls[1].options.shell, false);
  finish(killer);
  exit(child, null, 'SIGKILL');
  await tick();
  assert.equal(settled, false, 'exit is not close');
  close(child);
  await rejected;
  assert.equal(signal.listenerCount, 0);
  signal.cancel();
  assert.equal(calls.length, 2);
});

test('cancellation after exit waits for output closure without killing a reused PID', async (t) => {
  const f = await fixture(t);
  const signal = cancellation();
  const h = runtime((child) => { child.stdout.write('[]'); exit(child); });
  let settled = false;
  const running = runBatchScript(f.script, f.directory, signal, h.dependencies);
  const rejected = assert.rejects(running, QueryCancelledError).then(() => { settled = true; });
  const child = await h.ready;
  signal.cancel();
  await tick();
  assert.equal(settled, false);
  assert.equal(h.calls.length, 1);
  close(child);
  await rejected;
  assert.equal(h.calls.length, 1);
});

test('cancellation during failed startup waits for close and suppresses fallback', async (t) => {
  const f = await fixture(t);
  const signal = cancellation();
  const failed = childProcess();
  failed.pid = undefined;
  const ready = deferred();
  let calls = 0;
  const running = runBatchScript(f.script, f.directory, signal, {
    platform: 'win32',
    spawn() {
      calls++;
      queueMicrotask(() => {
        failed.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
        ready.resolve();
      });
      return failed;
    },
  });
  const rejected = assert.rejects(running, QueryCancelledError);
  await ready.promise;
  signal.cancel();
  close(failed, -2);
  await rejected;
  assert.equal(calls, 1);
  assert.equal(signal.listenerCount, 0);
});

test('cancellation before the spawn event is handled once a PID becomes available', async (t) => {
  const f = await fixture(t);
  const signal = cancellation();
  const child = childProcess();
  child.pid = undefined;
  const killer = childProcess(12346);
  let kills = 0;
  const running = runBatchScript(f.script, f.directory, signal, {
    platform: 'win32',
    spawn(command) {
      if (command === 'taskkill') {
        kills++;
        queueMicrotask(() => { finish(child, null, 'SIGKILL'); finish(killer); });
        return killer;
      }
      signal.cancel();
      queueMicrotask(() => { child.pid = 12345; child.emit('spawn'); });
      return child;
    },
  });
  await assert.rejects(running, QueryCancelledError);
  assert.equal(kills, 1);
});

test('non-Windows cancellation kills the detached process group', async (t) => {
  const f = await fixture(t);
  const signal = cancellation();
  const h = runtime(() => {}, 'linux');
  const running = runBatchScript(f.script, f.directory, signal, h.dependencies);
  const rejected = assert.rejects(running, QueryCancelledError);
  await h.ready;
  signal.cancel();
  await rejected;
  assert.equal(h.calls[0].options.detached, true);
  assert.deepEqual(h.calls[1], { pid: -12345, signal: 'SIGKILL' });
  assert.equal(h.calls.length, 2);
});

test('a late taskkill failure never directly kills an exited child', async (t) => {
  const f = await fixture(t);
  const signal = cancellation();
  const child = childProcess();
  const killer = childProcess(12346);
  const ready = deferred();
  const running = runBatchScript(f.script, f.directory, signal, {
    platform: 'win32',
    spawn(command) {
      if (command === 'taskkill') return killer;
      queueMicrotask(() => { child.emit('spawn'); ready.resolve(); });
      return child;
    },
  });
  const rejected = assert.rejects(running, QueryCancelledError);
  await ready.promise;
  signal.cancel();
  finish(child);
  killer.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' }));
  finish(killer, 128);
  await rejected;
  assert.deepEqual(child.directKills, []);
});

test('a failed taskkill reports cleanup failure and waits for the direct child to close', async (t) => {
  const f = await fixture(t);
  const signal = cancellation();
  const child = childProcess();
  const killer = childProcess(12346);
  const ready = deferred();
  const running = runBatchScript(f.script, f.directory, signal, {
    platform: 'win32',
    spawn(command) {
      if (command === 'taskkill') {
        queueMicrotask(() => { killer.emit('error', new Error(`password=${diagnosticValue}`)); finish(killer, 1); });
        return killer;
      }
      queueMicrotask(() => { child.emit('spawn'); ready.resolve(); });
      return child;
    },
  });
  const rejected = assert.rejects(running, (error) => {
    assert.ok(error instanceof QueryCancelledError);
    assert.match(error.message, /进程树终止失败/);
    assert.ok(!error.message.includes(diagnosticValue));
    return true;
  });
  await ready.promise;
  signal.cancel();
  await rejected;
  assert.deepEqual(child.directKills, ['SIGKILL']);
});

const pwsh = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
  windowsHide: true, stdio: 'ignore', timeout: 10000,
});
const realPowerShell = { skip: pwsh.error || pwsh.status !== 0 ? 'pwsh is unavailable' : false, timeout: 20000 };

test('real pwsh supports Chinese and punctuation in paths, UTF-8 output and the SQL directory', realPowerShell, async (t) => {
  const f = await fixture(t, `
[Console]::Error.WriteLine('普通诊断')
$items = @([ordered]@{ name = '中文😀'; directory = (Get-Location).Path })
[Console]::Out.Write((ConvertTo-Json -InputObject $items -Compress))
exit 0
`);
  const result = await runBatchScript(basename(f.script), f.directory, neverCancelled);
  assert.deepEqual(JSON.parse(result), [{ name: '中文😀', directory: f.directory }]);
});

test('real pwsh preserves explicit exit failure and terminating errors', realPowerShell, async (t) => {
  const f = await fixture(t, "[Console]::Error.WriteLine('中文失败'); exit 7");
  await assert.rejects(runBatchScript(f.script, f.directory, neverCancelled), /退出码 7[\s\S]*中文失败/);
  await fs.writeFile(f.script, "\ufeffthrow '脚本抛错'", 'utf8');
  await assert.rejects(runBatchScript(f.script, f.directory, neverCancelled), /退出码 1[\s\S]*脚本抛错/);
});

test('real pwsh rejects Write-Error even after the script has emitted valid JSON', realPowerShell, async (t) => {
  const f = await fixture(t, `
[Console]::Out.Write('[{"biz_date":"2026-10-01"}]')
Write-Error '参数生成失败'
exit 0
`);
  await assert.rejects(runBatchScript(f.script, f.directory, neverCancelled), /退出码 1[\s\S]*参数生成失败/);
});

test('real pwsh cancellation closes the script and its child process before rejecting', realPowerShell, async (t) => {
  const f = await fixture(t, `
$start = [System.Diagnostics.ProcessStartInfo]::new()
$start.FileName = (Get-Process -Id $PID).Path
$start.Arguments = '-NoLogo -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 60"'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$child = [System.Diagnostics.Process]::Start($start)
$ready = @{ parent = $PID; child = $child.Id } | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText((Join-Path (Get-Location).Path 'ready.json'), $ready, [System.Text.UTF8Encoding]::new($false))
Start-Sleep -Seconds 60
`);
  const signal = cancellation();
  const running = runBatchScript(f.script, f.directory, signal);
  const rejected = assert.rejects(running, QueryCancelledError);
  t.after(async () => { signal.cancel(); await rejected; });
  let pids;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { pids = JSON.parse(await fs.readFile(join(f.directory, 'ready.json'), 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await sleep(50);
  }
  assert.ok(pids, 'script did not start its child');
  signal.cancel();
  await rejected;
  for (const pid of [pids.parent, pids.child]) {
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `process ${pid} must have closed`);
  }
  assert.equal(signal.listenerCount, 0);
});
