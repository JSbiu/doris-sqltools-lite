const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const Module = require('node:module');
const { tmpdir } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');
const test = require('node:test');

const { toTsv } = require('../out/exports.js');
const { QueryCancelledError } = require('../out/querySession.js');
const { createTsvFileWriter } = require('../out/tsvFileWriter.js');

// Only this module's require is intercepted, and only during synchronous load.
// Production code keeps using the real Node API without test-only injection.
function loadWithFs(overrides) {
  const filename = require.resolve('../out/tsvFileWriter.js');
  const cached = require.cache[filename];
  const originalLoad = Module._load;
  delete require.cache[filename];
  Module._load = function load(request, parent, isMain) {
    if (parent?.filename === filename && request === 'node:fs/promises') {
      return { ...fs, ...overrides };
    }
    if (request === 'vscode') {
      throw new Error('The TSV writer must run in plain Node.js');
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(filename).createTsvFileWriter;
  } finally {
    Module._load = originalLoad;
    delete require.cache[filename];
    if (cached) {
      require.cache[filename] = cached;
    }
  }
}

function withFileHooks({ writeFile, close, ...overrides }) {
  return loadWithFs({
    ...overrides,
    open: async (...args) => {
      const handle = await fs.open(...args);
      return {
        writeFile: (...args) => writeFile
          ? writeFile(handle, ...args) : handle.writeFile(...args),
        close: () => close ? close(handle) : handle.close(),
      };
    },
  });
}

async function fixture(t, { create = createTsvFileWriter, filename = 'result.tsv', ...options } = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'doris-tsv-writer-'));
  const target = join(directory, filename);
  const token = options.token ?? { isCancellationRequested: false };
  const progress = [];
  const writer = create(target, {
    chunkRows: 2,
    escapeFormulas: true,
    onProgress: (rows) => progress.push(rows),
    ...options,
    token,
  });
  t.after(async () => {
    try {
      await writer.abort();
    } finally {
      assert.equal(dirname(directory), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('doris-tsv-writer-'));
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  return { directory, target, token, progress, writer };
}

async function missing(filename) {
  await assert.rejects(fs.lstat(filename), { code: 'ENOENT' });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function ioError(code) {
  return Object.assign(new Error(`Injected disk failure: ${code}`), { code });
}

test('begin uses lstat then exclusive private same-directory temporary creation', async (t) => {
  const calls = [];
  const create = loadWithFs({
    lstat: async (...args) => {
      calls.push(['lstat', ...args]);
      return fs.lstat(...args);
    },
    open: async (...args) => {
      calls.push(['open', ...args]);
      return fs.open(...args);
    },
  });
  const { writer, target, directory } = await fixture(t, { create });
  assert.equal(dirname(writer.temporaryPath), directory);
  assert.match(basename(writer.temporaryPath), /^\.result\.tsv\.[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\.partial$/);
  await missing(writer.temporaryPath);
  await writer.begin();
  assert.deepEqual(calls, [['lstat', target], ['open', writer.temporaryPath, 'wx', 0o600]]);
  assert.equal((await fs.stat(writer.temporaryPath)).size, 0);
  await missing(target);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(writer.temporaryPath)).mode & 0o777, 0o600);
  }
});

test('streams existing TSV encoding without BOM and counts only completed writes', async (t) => {
  const { writer, target, progress } = await fixture(t);
  const columns = ['=head', 'tab', 'note', 'quote', 'binary', 'nested', 'nil', 'big'];
  const rows = [
    { '=head': '=1+1', tab: 'x\ty', note: '中\r\n文', quote: 'a"b', binary: Buffer.from([0, 255]), nested: { n: 9n }, nil: null, big: 9007199254740993n },
    { '=head': '-5', tab: '@SUM(1)', note: '+cmd', quote: '-2+3' },
    { '=head': '=尾' },
  ];
  await writer.begin();
  writer.onColumns(columns);
  await writer.write(rows[0]);
  assert.equal(writer.rowsWritten, 0);
  await writer.write(rows[1]);
  assert.equal(writer.rowsWritten, 2);
  assert.deepEqual(progress, [2]);
  await writer.write(rows[2]);
  await missing(target);
  assert.equal(await fs.readFile(writer.temporaryPath, 'utf8'), `${toTsv(rows.slice(0, 2), columns)}\r\n`);
  assert.equal(await writer.finish(), 3);
  assert.equal(writer.rowsWritten, 3);
  assert.deepEqual(progress, [2, 3]);
  const bytes = await fs.readFile(target);
  assert.equal(bytes.toString('utf8'), `${toTsv(rows, columns)}\r\n`);
  assert.notDeepEqual(bytes.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
  await missing(writer.temporaryPath);
  await writer.abort();
  assert.equal(await fs.readFile(target, 'utf8'), `${toTsv(rows, columns)}\r\n`);
});

test('honours disabled formula escaping in both header and body', async (t) => {
  const { writer, target } = await fixture(t, { escapeFormulas: false, chunkRows: 1 });
  await writer.begin();
  writer.onColumns(['=column']);
  await writer.write({ '=column': '=1+1' });
  assert.equal(await writer.finish(), 1);
  assert.equal(await fs.readFile(target, 'utf8'), '=column\r\n=1+1\r\n');
});

test('zero rows with columns publishes exactly one header', async (t) => {
  const { writer, target, progress } = await fixture(t);
  await writer.begin();
  writer.onColumns(['id', '中文']);
  assert.equal(await writer.finish(), 0);
  assert.equal(await fs.readFile(target, 'utf8'), 'id\t中文\r\n');
  assert.deepEqual(progress, []);
});

test('onColumns snapshots names without performing IO', async (t) => {
  let writes = 0;
  const create = withFileHooks({
    writeFile: async (handle, ...args) => {
      writes++;
      await handle.writeFile(...args);
    },
  });
  const { writer, target } = await fixture(t, { create });
  await writer.begin();
  const columns = ['value'];
  assert.doesNotThrow(() => writer.onColumns(columns));
  assert.equal(writes, 0);
  columns[0] = 'changed';
  await writer.write({ value: 'original' });
  await writer.finish();
  assert.equal(await fs.readFile(target, 'utf8'), 'value\r\noriginal\r\n');
});

test('awaited writes apply disk backpressure without overlapping file operations', async (t) => {
  const entered = deferred();
  const release = deferred();
  let active = 0;
  let maximum = 0;
  const create = withFileHooks({
    writeFile: async (handle, text, encoding) => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        if (text === '1\r\n') {
          entered.resolve();
          await release.promise;
        }
        await handle.writeFile(text, encoding);
      } finally {
        active--;
      }
    },
  });
  const { writer, target, progress } = await fixture(t, { create, chunkRows: 1 });
  await writer.begin();
  writer.onColumns(['value']);
  let settled = false;
  const writing = writer.write({ value: 1 }).then(() => { settled = true; });
  await entered.promise;
  try {
    assert.equal(settled, false);
    assert.equal(writer.rowsWritten, 0);
    assert.deepEqual(progress, []);
    assert.equal(await fs.readFile(writer.temporaryPath, 'utf8'), 'value\r\n');
    await missing(target);
    await assert.rejects(writer.write({ value: 2 }), /等待/);
  } finally {
    release.resolve();
    await writing;
  }
  await writer.write({ value: 2 });
  await writer.finish();
  assert.equal(maximum, 1);
  assert.deepEqual(progress, [1, 2]);
  assert.equal(await fs.readFile(target, 'utf8'), 'value\r\n1\r\n2\r\n');
});

test('UTF-8 bytes bound chunks near 1 MiB even with a large row-count limit', async (t) => {
  const blocks = [];
  const create = withFileHooks({
    writeFile: async (handle, text, encoding) => {
      blocks.push(text);
      await handle.writeFile(text, encoding);
    },
  });
  const { writer, target } = await fixture(t, { create, chunkRows: 100000 });
  const value = '中'.repeat(120000);
  await writer.begin();
  writer.onColumns(['value']);
  for (let index = 0; index < 9; index++) {
    await writer.write({ value });
  }
  assert.equal(writer.rowsWritten, 8);
  assert.equal(await writer.finish(), 9);
  assert.equal(blocks[0], 'value\r\n');
  assert.deepEqual(blocks.slice(1).map((text) => text.split('\r\n').length - 1), [2, 2, 2, 2, 1]);
  assert.ok(blocks.every((text) => Buffer.byteLength(text, 'utf8') <= 1024 * 1024));
  assert.equal((await fs.stat(target)).size, 7 + 9 * (360000 + 2));
});

test('a single oversized row writes alone between bounded chunks', async (t) => {
  const blocks = [];
  const create = withFileHooks({
    writeFile: async (handle, text, encoding) => {
      blocks.push(text);
      await handle.writeFile(text, encoding);
    },
  });
  const { writer } = await fixture(t, { create, chunkRows: 100000 });
  const large = 'x'.repeat(1024 * 1024 + 1);
  await writer.begin();
  writer.onColumns(['value']);
  await writer.write({ value: 'before' });
  await writer.write({ value: large });
  assert.equal(writer.rowsWritten, 2);
  await writer.write({ value: 'after' });
  assert.equal(await writer.finish(), 3);
  assert.deepEqual(blocks, ['value\r\n', 'before\r\n', `${large}\r\n`, 'after\r\n']);
});

for (const kind of ['file', 'directory', 'dangling symlink']) {
  test(`begin refuses an existing ${kind} without creating a temporary file`, async (t) => {
    const { writer, target, directory } = await fixture(t);
    if (kind === 'file') {
      await fs.writeFile(target, 'existing owner');
    } else if (kind === 'directory') {
      await fs.mkdir(target);
    } else {
      try {
        await fs.symlink(join(directory, 'missing'), target, process.platform === 'win32' ? 'junction' : 'file');
      } catch (error) {
        if (error.code === 'EPERM' || error.code === 'ENOTSUP') {
          t.skip('This platform does not permit creating test symlinks');
          return;
        }
        throw error;
      }
      assert.equal((await fs.lstat(target)).isSymbolicLink(), true);
    }
    await assert.rejects(writer.begin(), { code: 'EEXIST' });
    await writer.abort();
    await missing(writer.temporaryPath);
    assert.ok(await fs.lstat(target));
    if (kind === 'file') {
      assert.equal(await fs.readFile(target, 'utf8'), 'existing owner');
    }
  });
}

test('begin does not create missing directories', async (t) => {
  const { writer, target } = await fixture(t, { filename: join('missing', 'result.tsv') });
  await assert.rejects(writer.begin(), { code: 'ENOENT' });
  await writer.abort();
  await missing(dirname(target));
});

test('failed exclusive open never deletes a temporary path it did not create', async (t) => {
  const { writer, target } = await fixture(t);
  await fs.writeFile(writer.temporaryPath, 'another owner');
  await assert.rejects(writer.begin(), { code: 'EEXIST' });
  await writer.abort();
  assert.equal(await fs.readFile(writer.temporaryPath, 'utf8'), 'another owner');
  await missing(target);
});

test('lstat IO failure propagates without opening or deleting anything', async (t) => {
  const error = ioError('EACCES');
  const calls = [];
  const create = loadWithFs({
    lstat: async () => { throw error; },
    open: async () => { calls.push('open'); throw new Error('unexpected open'); },
    unlink: async () => { calls.push('unlink'); },
  });
  const { writer } = await fixture(t, { create });
  await assert.rejects(writer.begin(), (caught) => caught === error);
  await writer.abort();
  assert.deepEqual(calls, []);
});

test('cancellation before begin creates no file', async (t) => {
  const { writer, token, directory } = await fixture(t);
  token.isCancellationRequested = true;
  await assert.rejects(writer.begin(), QueryCancelledError);
  await writer.abort();
  assert.deepEqual(await fs.readdir(directory), []);
});

test('cancellation during open still leaves an owned temporary file for abort', async (t) => {
  const token = { isCancellationRequested: false };
  const create = loadWithFs({
    open: async (...args) => {
      const handle = await fs.open(...args);
      token.isCancellationRequested = true;
      return handle;
    },
  });
  const { writer, target } = await fixture(t, { create, token });
  await assert.rejects(writer.begin(), QueryCancelledError);
  assert.ok(await fs.stat(writer.temporaryPath));
  await writer.abort();
  await missing(writer.temporaryPath);
  await missing(target);
});

for (const operation of ['write', 'finish']) {
  test(`cancellation before ${operation} discards buffered data on abort`, async (t) => {
    const { writer, token, target } = await fixture(t);
    await writer.begin();
    writer.onColumns(['value']);
    await writer.write({ value: 'buffered' });
    token.isCancellationRequested = true;
    await assert.rejects(operation === 'write' ? writer.write({ value: 'later' }) : writer.finish(), QueryCancelledError);
    await writer.abort();
    await missing(writer.temporaryPath);
    await missing(target);
  });
}

test('cancellation during disk write rejects after IO and abort removes the partial file', async (t) => {
  const token = { isCancellationRequested: false };
  const create = withFileHooks({
    writeFile: async (handle, text, encoding) => {
      await handle.writeFile(text, encoding);
      if (text === '1\r\n') {
        token.isCancellationRequested = true;
      }
    },
  });
  const { writer, target } = await fixture(t, { create, token, chunkRows: 1 });
  await writer.begin();
  writer.onColumns(['value']);
  await assert.rejects(writer.write({ value: 1 }), QueryCancelledError);
  assert.equal(writer.rowsWritten, 1);
  await writer.abort();
  await missing(writer.temporaryPath);
  await missing(target);
});

test('cancellation after close prevents the publication link', async (t) => {
  const token = { isCancellationRequested: false };
  let linked = false;
  const create = withFileHooks({
    close: async (handle) => {
      await handle.close();
      token.isCancellationRequested = true;
    },
    link: async (...args) => { linked = true; await fs.link(...args); },
  });
  const { writer, target } = await fixture(t, { create, token });
  await writer.begin();
  writer.onColumns(['value']);
  await writer.write({ value: 1 });
  await assert.rejects(writer.finish(), QueryCancelledError);
  assert.equal(linked, false);
  await writer.abort();
  await missing(writer.temporaryPath);
  await missing(target);
});

test('successful link is the completion point even if cancellation arrives immediately after it', async (t) => {
  const token = { isCancellationRequested: false };
  let closed = false;
  const create = withFileHooks({
    close: async (handle) => { await handle.close(); closed = true; },
    link: async (...args) => {
      assert.equal(closed, true);
      await fs.link(...args);
      token.isCancellationRequested = true;
    },
  });
  const { writer, target } = await fixture(t, { create, token });
  await writer.begin();
  writer.onColumns(['value']);
  await writer.write({ value: 1 });
  assert.equal(await writer.finish(), 1);
  assert.equal(await writer.finish(), 1);
  assert.equal(await fs.readFile(target, 'utf8'), 'value\r\n1\r\n');
  await missing(writer.temporaryPath);
});

test('an operation racing publication keeps its target and is never overwritten or removed', async (t) => {
  let closed = false;
  const create = withFileHooks({
    close: async (handle) => { await handle.close(); closed = true; },
    link: async (source, target) => {
      assert.equal(closed, true);
      await fs.writeFile(target, 'racing owner', { flag: 'wx' });
      await fs.link(source, target);
    },
  });
  const { writer, target } = await fixture(t, { create });
  await writer.begin();
  writer.onColumns(['value']);
  await writer.write({ value: 'ours' });
  await assert.rejects(writer.finish(), { code: 'EEXIST' });
  await writer.abort();
  assert.equal(await fs.readFile(target, 'utf8'), 'racing owner');
  await missing(writer.temporaryPath);
});

test('post-publication unlink failure returns success with a cleanupWarning', async (t) => {
  const error = ioError('EACCES');
  const unlinks = [];
  const create = loadWithFs({
    unlink: async (filename) => {
      unlinks.push(filename);
      if (unlinks.length === 1) {
        throw error;
      }
      await fs.unlink(filename);
    },
  });
  const { writer, target } = await fixture(t, { create });
  await writer.begin();
  writer.onColumns(['value']);
  await writer.write({ value: 1 });
  assert.equal(await writer.finish(), 1);
  assert.ok(writer.cleanupWarning.includes(writer.temporaryPath));
  assert.match(writer.cleanupWarning, /EACCES/);
  assert.equal(await fs.readFile(target, 'utf8'), 'value\r\n1\r\n');
  assert.ok(await fs.stat(writer.temporaryPath));
  await writer.abort();
  assert.deepEqual(unlinks, [writer.temporaryPath, writer.temporaryPath]);
  await missing(writer.temporaryPath);
  assert.equal(await fs.readFile(target, 'utf8'), 'value\r\n1\r\n');
});

for (const [stage, code] of [['header', 'ENOSPC'], ['body', 'EIO'], ['tail', 'ENOSPC'], ['close', 'EIO'], ['link', 'EPERM']]) {
  test(`${stage} disk failure propagates and abort cleans the owned partial file`, async (t) => {
    const error = ioError(code);
    let closeFailed = false;
    const create = withFileHooks({
      writeFile: async (handle, text, encoding) => {
        if ((stage === 'header' && text === 'value\r\n')
          || ((stage === 'body' || stage === 'tail') && text !== 'value\r\n')) {
          // Simulate an error after a partial write, not just before any bytes.
          await handle.writeFile(text.slice(0, 1), encoding);
          throw error;
        }
        await handle.writeFile(text, encoding);
      },
      close: async (handle) => {
        if (stage === 'close' && !closeFailed) {
          closeFailed = true;
          throw error;
        }
        await handle.close();
      },
      link: async (...args) => {
        if (stage === 'link') {
          throw error;
        }
        await fs.link(...args);
      },
    });
    const { writer, target, directory } = await fixture(t, { create, chunkRows: stage === 'tail' ? 2 : 1 });
    await writer.begin();
    writer.onColumns(['value']);
    if (stage === 'header' || stage === 'body') {
      await assert.rejects(writer.write({ value: 1 }), (caught) => caught === error);
    } else {
      await writer.write({ value: 1 });
      await assert.rejects(writer.finish(), (caught) => caught === error);
    }
    if (stage === 'header' || stage === 'body' || stage === 'tail') {
      assert.equal(writer.rowsWritten, 0);
    }
    await assert.rejects(writer.finish(), (caught) => caught === error);
    await missing(target);
    await writer.abort();
    assert.deepEqual(await fs.readdir(directory), []);
  });
}

for (const failureStage of ['close', 'unlink']) {
  test(`abort reports ${failureStage} failure with the temporary path and allows retry`, async (t) => {
    const error = ioError('EIO');
    const calls = [];
    let fail = true;
    const create = withFileHooks({
      close: async (handle) => {
        calls.push('close');
        if (failureStage === 'close' && fail) {
          fail = false;
          throw error;
        }
        await handle.close();
      },
      unlink: async (filename) => {
        calls.push('unlink');
        if (failureStage === 'unlink' && fail) {
          fail = false;
          throw error;
        }
        await fs.unlink(filename);
      },
    });
    const { writer, target } = await fixture(t, { create });
    await writer.begin();
    await assert.rejects(writer.abort(), (caught) => {
      assert.ok(caught.message.includes(writer.temporaryPath));
      assert.equal(caught.cause, error);
      return true;
    });
    assert.deepEqual(calls, failureStage === 'close' ? ['close'] : ['close', 'unlink']);
    assert.ok(await fs.stat(writer.temporaryPath));
    await writer.abort();
    await missing(writer.temporaryPath);
    await missing(target);
  });
}

const columnCases = [
  ['no columns', [], /未返回列信息/],
  ['empty columns', [[]], /空或无效的列名数组/],
  ['duplicate names', [['id', 'id']], /唯一 AS 别名/],
  ['repeated identical header', [['id'], ['id']], /多个结果集/],
  ['another result header', [['id'], ['other']], /多个结果集/],
];
for (const [name, headers, message] of columnCases) {
  for (const operation of ['write', 'finish']) {
    test(`${name} is reported by ${operation}, never by the columns callback`, async (t) => {
      let writes = 0;
      const create = withFileHooks({
        writeFile: async (handle, ...args) => { writes++; await handle.writeFile(...args); },
      });
      const { writer, target } = await fixture(t, { create });
      await writer.begin();
      for (const header of headers) {
        assert.doesNotThrow(() => writer.onColumns(header));
      }
      assert.equal(writes, 0);
      await assert.rejects(operation === 'write' ? writer.write({ id: 1 }) : writer.finish(), message);
      assert.equal(writes, 0);
      await writer.abort();
      await missing(target);
      await missing(writer.temporaryPath);
    });
  }
}

test('a later results header fails finish even after the first rows reached disk', async (t) => {
  const { writer, target } = await fixture(t, { chunkRows: 1 });
  await writer.begin();
  writer.onColumns(['id']);
  await writer.write({ id: 1 });
  assert.equal(writer.rowsWritten, 1);
  assert.doesNotThrow(() => writer.onColumns(['other']));
  await assert.rejects(writer.finish(), /多个结果集/);
  await writer.abort();
  await missing(target);
  await missing(writer.temporaryPath);
});
