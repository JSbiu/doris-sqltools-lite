const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PARAMETER_STORAGE_KEY,
  forgetParameterValues,
  readParameterValues,
  rememberParameterValues,
} = require('../out/parameterStore.js');

// A stand-in for vscode.Memento: a plain key/value box, so the store can be
// exercised without an ExtensionContext.
const fakeMemento = (initial) => {
  const box = { ...initial };
  return {
    get: (key, fallback) => (key in box ? box[key] : fallback),
    update: async (key, value) => {
      box[key] = value;
    },
    raw: box,
  };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

test('remembers values per document', async () => {
  const store = fakeMemento();

  await rememberParameterValues(store, 'file:///a.sql', { dt: '2026-09-21' });

  assert.deepEqual(readParameterValues(store, 'file:///a.sql'), { dt: '2026-09-21' });
});

test('keeps documents independent', async () => {
  const store = fakeMemento();

  await rememberParameterValues(store, 'file:///a.sql', { dt: 'A' });
  await rememberParameterValues(store, 'file:///b.sql', { dt: 'B' });

  assert.deepEqual(readParameterValues(store, 'file:///a.sql'), { dt: 'A' });
  assert.deepEqual(readParameterValues(store, 'file:///b.sql'), { dt: 'B' });
});

test('an unknown document has no values', () => {
  assert.deepEqual(readParameterValues(fakeMemento(), 'file:///never.sql'), {});
});

test('only returns parameters the template still asks for', async () => {
  const store = fakeMemento();
  await rememberParameterValues(store, 'file:///a.sql', { kept: 'x', dropped: 'y' });

  assert.deepEqual(
    readParameterValues(store, 'file:///a.sql', { kept: '' }),
    { kept: 'x' },
  );
});

test('a value is discarded when the template default changes', async () => {
  const store = fakeMemento();
  await rememberParameterValues(store, 'file:///a.sql', { country: 'FR' }, { country: 'US' });

  // Unchanged declaration: the typed value still wins over the default.
  assert.deepEqual(
    readParameterValues(store, 'file:///a.sql', { country: 'US' }),
    { country: 'FR' },
  );

  // The default was edited in the SQL, so the stale value must not override it.
  assert.deepEqual(readParameterValues(store, 'file:///a.sql', { country: 'CA' }), {});
});

test('a value with no declaration survives a template that still declares none', async () => {
  const store = fakeMemento();
  await rememberParameterValues(store, 'file:///a.sql', { asked: 'v' }, { asked: '' });

  assert.deepEqual(readParameterValues(store, 'file:///a.sql', { asked: '' }), { asked: 'v' });
});

test('forgetting one document leaves the others alone', async () => {
  const store = fakeMemento();
  await rememberParameterValues(store, 'file:///a.sql', { dt: 'A' });
  await rememberParameterValues(store, 'file:///b.sql', { dt: 'B' });

  await forgetParameterValues(store, 'file:///a.sql');

  assert.deepEqual(readParameterValues(store, 'file:///a.sql'), {});
  assert.deepEqual(readParameterValues(store, 'file:///b.sql'), { dt: 'B' });
});

test('caps the number of remembered documents', async () => {
  const store = fakeMemento();

  for (let index = 0; index < 51; index += 1) {
    await rememberParameterValues(store, `file:///${index}.sql`, { dt: String(index) });
    await tick();
  }

  const stored = store.raw[PARAMETER_STORAGE_KEY];
  assert.equal(Object.keys(stored).length, 50);
  // The oldest write went first, the newest is intact.
  assert.equal('file:///0.sql' in stored, false);
  assert.deepEqual(readParameterValues(store, 'file:///50.sql'), { dt: '50' });
});

test('ignores a corrupted store instead of throwing', async () => {
  assert.deepEqual(readParameterValues(fakeMemento({ [PARAMETER_STORAGE_KEY]: 'not an object' })), {});
  assert.deepEqual(
    readParameterValues(
      fakeMemento({
        [PARAMETER_STORAGE_KEY]: {
          'file:///a.sql': { values: { good: 'x', bad: 42 }, usedAt: 'later' },
          'file:///b.sql': 'nonsense',
        },
      }),
      'file:///a.sql',
    ),
    { good: 'x' },
  );
});

test('drops absurdly long values rather than storing them', async () => {
  const store = fakeMemento();
  const huge = 'x'.repeat(5_000);

  await rememberParameterValues(store, 'file:///a.sql', { big: huge, small: 'ok' });

  assert.deepEqual(readParameterValues(store, 'file:///a.sql'), { small: 'ok' });
});
