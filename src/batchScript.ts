import { spawn, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { redactErrorMessage } from './connectionSecurity';
import { QueryCancelledError, type CancelSignal } from './querySession';

const STDOUT_LIMIT = 4 * 1024 * 1024;
const STDERR_LIMIT = 8 * 1024;
const SCRIPT_VARIABLE = 'DORIS_SQLTOOLS_BATCH_SCRIPT_PATH';
// The path travels as data in the environment, never as PowerShell source.
const BOOTSTRAP = Buffer.from([
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '$OutputEncoding = [Console]::OutputEncoding',
  '$LASTEXITCODE = 0',
  `try { & $env:${SCRIPT_VARIABLE}; exit $LASTEXITCODE } catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }`,
].join('; '), 'utf16le').toString('base64');

interface ScriptRuntime {
  spawn: typeof spawn;
  kill: typeof process.kill;
  platform: NodeJS.Platform;
}

interface ScriptOutput {
  stdout: string;
  stderr: string;
  stderrTruncated: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: NodeJS.ErrnoException;
  failure?: Error;
}

function safeStderr(output: ScriptOutput): string {
  if (!output.stderr) return '';
  // Complete any quote cut by the byte limit before applying the shared
  // redactor, so a truncated quoted password cannot expose its trailing words.
  const safe = redactErrorMessage(output.stderr + (output.stderrTruncated ? '"\'' : ''));
  const bounded = Buffer.from(safe, 'utf8').subarray(0, STDERR_LIMIT).toString('utf8').trim();
  return `\nstderr: ${bounded}${output.stderrTruncated ? '\n（stderr 已截断）' : ''}`;
}

async function terminateTree(
  child: ChildProcess,
  runtime: ScriptRuntime,
  isRunning: () => boolean,
): Promise<void> {
  if (!isRunning() || child.pid === undefined) return;
  if (runtime.platform !== 'win32') {
    // Each script has its own process group; descendants inherit that group.
    runtime.kill(-child.pid, 'SIGKILL');
    return;
  }
  // Launch immediately while the child is live. Never schedule a later PID
  // kill or retry it after exit, when Windows might have reused the PID.
  await new Promise<void>((done, reject) => {
    const killer = runtime.spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    let error: Error | undefined;
    killer.on('error', (caught: Error) => { error = caught; });
    killer.once('close', (code) => {
      if (!isRunning() || (!error && code === 0)) done();
      else reject(error ?? new Error(`taskkill 退出码 ${String(code)}`));
    });
  });
}

async function capture(
  executable: string,
  scriptPath: string,
  workingDirectory: string,
  signal: CancelSignal,
  runtime: ScriptRuntime,
): Promise<ScriptOutput> {
  if (signal.requested) throw new QueryCancelledError('参数脚本已取消。');
  let child: ChildProcess;
  try {
    child = runtime.spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', BOOTSTRAP], {
      cwd: workingDirectory,
      env: { ...process.env, [SCRIPT_VARIABLE]: scriptPath },
      shell: false,
      windowsHide: true,
      detached: runtime.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return { stdout: '', stderr: '', stderrTruncated: false, code: null, signal: null,
      spawnError: error as NodeJS.ErrnoException };
  }

  const stdout = Buffer.allocUnsafe(STDOUT_LIMIT);
  const stderr = Buffer.allocUnsafe(STDERR_LIMIT);
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stderrTruncated = false;
  let cancelled = false;
  let exited = false;
  let closed = false;
  let spawned = false;
  let spawnError: NodeJS.ErrnoException | undefined;
  let failure: Error | undefined;
  let termination: Promise<void> | undefined;
  let terminationError: Error | undefined;
  const isRunning = () => !exited && !closed && child.exitCode === null && child.signalCode === null;
  const stop = () => {
    if (termination || !isRunning() || child.pid === undefined) return;
    termination = terminateTree(child, runtime, isRunning).catch((error: Error) => {
      terminationError = error;
      // If tree termination failed, still close the direct child. The error
      // remains visible; this fallback is never attempted after its exit.
      if (isRunning()) {
        try { child.kill('SIGKILL'); } catch { /* Report the tree termination error. */ }
      }
    });
  };
  const onCancel = () => {
    if (closed) return;
    cancelled = true;
    stop();
  };
  const onStdout = (chunk: Buffer) => {
    if (cancelled || failure) return;
    const copied = chunk.copy(stdout, stdoutBytes, 0, STDOUT_LIMIT - stdoutBytes);
    stdoutBytes += copied;
    if (copied < chunk.length) {
      failure = new Error('参数脚本 stdout 超过 4 MiB，已停止脚本。');
      stop();
    }
  };
  const onStderr = (chunk: Buffer) => {
    if (cancelled || failure) return;
    const copied = chunk.copy(stderr, stderrBytes, 0, STDERR_LIMIT - stderrBytes);
    stderrBytes += copied;
    if (copied < chunk.length) {
      stderrTruncated = true;
      failure = new Error('参数脚本 stderr 超过 8 KiB，已停止脚本。');
      stop();
    }
  };
  const onStreamError = (error: Error) => {
    failure ??= new Error(`读取参数脚本输出失败：${redactErrorMessage(error.message)}`);
    stop();
  };
  const onSpawn = () => {
    spawned = true;
    if (cancelled || failure) stop();
  };
  const onError = (error: NodeJS.ErrnoException) => {
    if (!spawned) spawnError = error;
    else onStreamError(error);
  };
  const onExit = () => { exited = true; };
  child.once('spawn', onSpawn);
  child.on('error', onError);
  child.once('exit', onExit);
  child.stdout?.on('data', onStdout);
  child.stderr?.on('data', onStderr);
  child.stdout?.on('error', onStreamError);
  child.stderr?.on('error', onStreamError);
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.once('close', (code, exitSignal) => {
      exited = true;
      closed = true;
      done({ code, signal: exitSignal });
    });
  });
  const subscription = signal.onRequest(onCancel);
  try {
    if (signal.requested) onCancel();
    const result = await completion;
    await termination;
    const cleanup = terminationError ? `进程树终止失败：${redactErrorMessage(terminationError.message)}` : '';
    if (cancelled || signal.requested) throw new QueryCancelledError(`参数脚本已取消。${cleanup}`);
    if (cleanup) failure = new Error(`${failure?.message ?? '参数脚本失败。'}${cleanup}`);
    return {
      ...result,
      stdout: stdout.subarray(0, stdoutBytes).toString('utf8'),
      stderr: stderr.subarray(0, stderrBytes).toString('utf8'),
      stderrTruncated, spawnError, failure,
    };
  } finally {
    subscription.dispose();
    child.removeListener('spawn', onSpawn);
    child.removeListener('error', onError);
    child.removeListener('exit', onExit);
    child.stdout?.removeListener('data', onStdout);
    child.stderr?.removeListener('data', onStderr);
    child.stdout?.removeListener('error', onStreamError);
    child.stderr?.removeListener('error', onStreamError);
  }
}

/** Execute once and return stdout verbatim; the caller validates the JSON. */
export async function runBatchScript(
  scriptPath: string,
  workingDirectory: string,
  signal: CancelSignal,
  dependencies: Partial<ScriptRuntime> = {},
): Promise<string> {
  if (signal.requested) throw new QueryCancelledError('参数脚本已取消。');
  const absolutePath = resolve(workingDirectory, scriptPath);
  if (extname(absolutePath).toLowerCase() !== '.ps1') {
    throw new Error('批次参数脚本必须是 .ps1 文件。');
  }
  try {
    if (!(await stat(absolutePath)).isFile()) throw new Error('指定路径不是文件');
  } catch (error) {
    const caught = error as NodeJS.ErrnoException;
    const reason = caught.code === 'ENOENT' ? '文件不存在' : redactErrorMessage(caught.message);
    throw new Error(`无法读取批次参数脚本：${redactErrorMessage(absolutePath)}（${reason}）。`, { cause: error });
  }
  const runtime: ScriptRuntime = { spawn, kill: process.kill, platform: process.platform, ...dependencies };
  let output = await capture('pwsh', absolutePath, workingDirectory, signal, runtime);
  if (output.spawnError?.code === 'ENOENT' && runtime.platform === 'win32') {
    output = await capture('powershell.exe', absolutePath, workingDirectory, signal, runtime);
  }
  if (signal.requested) throw new QueryCancelledError('参数脚本已取消。');
  if (output.spawnError) {
    if (output.spawnError.code === 'ENOENT') {
      throw new Error('未找到 PowerShell。请安装 pwsh，或在 Windows 上提供 powershell.exe。');
    }
    throw new Error(`无法启动 PowerShell 参数脚本：${redactErrorMessage(output.spawnError.message)}`);
  }
  if (output.failure) throw new Error(output.failure.message + safeStderr(output));
  if (output.code !== 0) {
    const status = output.signal ? `信号 ${output.signal}` : `退出码 ${String(output.code)}`;
    throw new Error(`参数脚本执行失败（${status}）。${safeStderr(output)}`);
  }
  return output.stdout;
}
