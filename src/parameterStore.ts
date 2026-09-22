// Remembers the parameter values a SQL file was last run with.
//
// Deliberately durable but local: values live in VS Code's extension state, not
// in settings.json (they are business data -- date ranges, ids -- and would
// pollute a file people commit) and not in SecretStorage (they are not secrets).
// Extension state is not part of Settings Sync, so nothing leaves the machine.
//
// Keyed by document, then by parameter name: a template keeps its own values,
// which is the point of separating the template (in the .sql file, shareable)
// from the values (local). A value is also stamped with the declaration it was
// entered against, so editing the default inside the SQL discards a remembered
// value instead of silently overriding it forever.

// Structural subset of vscode.Memento. Declared locally rather than imported so
// this module stays free of the `vscode` import and can be unit-tested.
export interface ParameterMemento {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export const PARAMETER_STORAGE_KEY = 'dorisSqlLite.parameterValues';

// Bounds so a long-lived install cannot grow this without limit.
const MAX_DOCUMENTS = 50;
const MAX_VALUE_LENGTH = 2_000;

// Declaration text per parameter name: the part after `=` in `${name=A, B}`, or
// '' when the template declares none. Compared as raw text -- it only has to be
// stable, not parsed -- so any edit to it resets the remembered value.
export type ParameterDeclarations = Readonly<Record<string, string>>;

interface StoredEntry {
  values: Record<string, string>;
  declarations: Record<string, string>;
  usedAt: number;
}

type StoredParameters = Record<string, StoredEntry>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function freeText(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const clean: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry.length <= MAX_VALUE_LENGTH) {
      clean[name] = entry;
    }
  }
  return clean;
}

function readAll(store: ParameterMemento): StoredParameters {
  const raw = store.get<unknown>(PARAMETER_STORAGE_KEY, {});
  if (!isRecord(raw)) {
    return {};
  }

  const stored: StoredParameters = {};
  for (const [documentKey, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) {
      continue;
    }
    stored[documentKey] = {
      values: freeText(entry.values),
      declarations: freeText(entry.declarations),
      usedAt: typeof entry.usedAt === 'number' ? entry.usedAt : 0,
    };
  }
  return stored;
}

// The remembered values for one document.
//
// When `declarations` is given, only the parameters the template still asks for
// are returned, and a value whose declaration has since changed is dropped --
// that is what makes editing a default inside the SQL take effect. Omit it to
// read the raw stored values.
export function readParameterValues(
  store: ParameterMemento,
  documentKey: string,
  declarations?: ParameterDeclarations,
): Record<string, string> {
  const entry = readAll(store)[documentKey];
  if (!entry) {
    return {};
  }
  if (declarations === undefined) {
    return { ...entry.values };
  }

  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(entry.values)) {
    if (!(name in declarations)) {
      continue;
    }
    const remembered = entry.declarations[name];
    if (remembered !== undefined && remembered !== declarations[name]) {
      continue;
    }
    values[name] = value;
  }
  return values;
}

export async function rememberParameterValues(
  store: ParameterMemento,
  documentKey: string,
  values: Readonly<Record<string, string>>,
  declarations?: ParameterDeclarations,
): Promise<void> {
  const all = readAll(store);
  const kept = freeText(values);
  if (declarations !== undefined) {
    // Drop anything the template no longer asks for, so a parameter deleted from
    // the SQL does not sit in the store forever.
    for (const name of Object.keys(kept)) {
      if (!(name in declarations)) {
        delete kept[name];
      }
    }
  }

  all[documentKey] = {
    values: kept,
    declarations: freeText(declarations ?? {}),
    usedAt: Date.now(),
  };

  // Drop the least recently used documents once the cap is exceeded.
  const keys = Object.keys(all);
  if (keys.length > MAX_DOCUMENTS) {
    keys
      .sort((a, b) => (all[b]?.usedAt ?? 0) - (all[a]?.usedAt ?? 0))
      .slice(MAX_DOCUMENTS)
      .forEach((key) => delete all[key]);
  }

  await store.update(PARAMETER_STORAGE_KEY, all);
}

export async function forgetParameterValues(
  store: ParameterMemento,
  documentKey: string,
): Promise<void> {
  const all = readAll(store);
  if (!(documentKey in all)) {
    return;
  }
  delete all[documentKey];
  await store.update(PARAMETER_STORAGE_KEY, all);
}
