import { createDataKey, decodeDataKey, encodeDataKey, isEncryptedValue } from './fieldEncryption';
import type { DataKey } from './fieldEncryption';

interface KeyStorage {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
}

const PREFIX = 'dorisSqlLite.dataKeys.';
const ACTIVE = `${PREFIX}active`;
const INDEX = `${PREFIX}ids`;
const INVALID_IMPORT = '字段加密密钥导入内容无效。';
const INVALID_STORED = '保存的字段加密密钥已损坏。';
const CONFLICT = '字段加密密钥 ID 对应的材料冲突。';

// Match the key IDs accepted by the encryption core, including imported IDs.
function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
}

function copyKey(key: DataKey): DataKey {
  return { id: key.id, material: Uint8Array.from(key.material) };
}

function sameKey(a: DataKey, b: DataKey): boolean {
  return a.id === b.id && Buffer.from(a.material).equals(b.material);
}

function tokenKeyId(token: string): string {
  // Check the entire envelope before touching storage. Authentication remains
  // decryptValue's job; a well-formed token need not have a valid tag here.
  const parts = typeof token === 'string' ? token.split(':') : [];
  if (!isEncryptedValue(token) || parts.length !== 5 || parts[1] !== 'v1' || !isId(parts[2])) {
    throw new Error('字段密文格式无效。');
  }
  const domain = Buffer.from(parts[3], 'base64url');
  const payload = Buffer.from(parts[4], 'base64url');
  if (domain.toString('base64url') !== parts[3]
    || !Buffer.from(domain.toString('utf8'), 'utf8').equals(domain)
    || payload.toString('base64url') !== parts[4] || payload.length < 17) {
    throw new Error('字段密文格式无效。');
  }
  return parts[2];
}

function importedKeys(text: string): { active: string; keys: DataKey[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(INVALID_IMPORT);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(INVALID_IMPORT);
  const record = raw as Record<string, unknown>;
  if (record.version !== 1 || !isId(record.active) || !Array.isArray(record.keys)) {
    throw new Error(INVALID_IMPORT);
  }
  const keys = new Map<string, DataKey>();
  for (const entry of record.keys) {
    let key: DataKey;
    try {
      if (typeof entry !== 'string') throw new Error(INVALID_IMPORT);
      key = decodeDataKey(entry);
    } catch {
      throw new Error(INVALID_IMPORT);
    }
    const previous = keys.get(key.id);
    if (previous && !sameKey(previous, key)) throw new Error(CONFLICT);
    keys.set(key.id, key);
  }
  if (!keys.has(record.active)) throw new Error(INVALID_IMPORT);
  return { active: record.active, keys: [...keys.values()] };
}

/** Inject ExtensionContext.secrets; no settings, files or VS Code imports. */
export class DataKeys {
  private readonly cache = new Map<string, DataKey>();
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly storage: KeyStorage) {}

  active(): Promise<DataKey> {
    return this.exclusive(() => this.ensureActive());
  }

  loadToken(token: string): Promise<void> {
    return this.exclusive(async () => {
      const id = tokenKeyId(token);
      const key = await this.readKey(id);
      if (!key) throw new Error('找不到字段密文所需的密钥。');
      this.cache.set(id, copyKey(key));
    });
  }

  lookup(id: string): DataKey | undefined {
    const key = this.cache.get(id);
    return key && copyKey(key);
  }

  /** Explicit export: JSON { version: 1, active: keyId, keys: encodedKey[] }. */
  exportKeys(): Promise<string> {
    return this.exclusive(async () => {
      const active = await this.ensureActive();
      const ids = new Set([...await this.readIndex(), ...this.cache.keys(), active.id]);
      const keys: string[] = [];
      for (const id of [...ids].sort()) {
        const key = await this.readKey(id);
        if (!key) throw new Error(INVALID_STORED);
        this.cache.set(id, copyKey(key));
        keys.push(encodeDataKey(key));
      }
      return JSON.stringify({ version: 1, active: active.id, keys }, null, 2);
    });
  }

  importKeys(text: string): Promise<void> {
    return this.exclusive(async () => {
      const imported = importedKeys(text);
      const previousActive = await this.readActiveId();
      // Validate every collision before the first write, including keys late
      // in the file. A storage failure can leave saved keys, never delete them.
      for (const key of imported.keys) await this.checkExisting(key);
      for (const key of imported.keys) await this.saveKey(key);
      await this.mergeIndex(previousActive ? [previousActive] : []);
      await this.write(ACTIVE, imported.active);
    });
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.then(action);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private async ensureActive(): Promise<DataKey> {
    const id = await this.readActiveId();
    if (id !== undefined) {
      const key = await this.readKey(id);
      if (!key) throw new Error(INVALID_STORED);
      this.cache.set(id, copyKey(key));
      return copyKey(key);
    }
    const key = createDataKey();
    // Per-ID entries are saved first. Competing windows may replace the active
    // pointer or omit an index entry, but old tokens still load their own key.
    await this.saveKey(key);
    await this.mergeIndex([]);
    await this.write(ACTIVE, key.id);
    return copyKey(key);
  }

  private async readActiveId(): Promise<string | undefined> {
    const id = await this.read(ACTIVE);
    if (id !== undefined && !isId(id)) throw new Error(INVALID_STORED);
    return id;
  }

  private async readKey(id: string): Promise<DataKey | undefined> {
    const text = await this.read(`${PREFIX}key.${id}`);
    if (text === undefined) return undefined;
    let key: DataKey;
    try {
      key = decodeDataKey(text);
      if (key.id !== id) throw new Error(INVALID_STORED);
    } catch {
      throw new Error(INVALID_STORED);
    }
    const cached = this.cache.get(id);
    if (cached && !sameKey(cached, key)) throw new Error(CONFLICT);
    return key;
  }

  private async checkExisting(key: DataKey): Promise<boolean> {
    const existing = await this.readKey(key.id);
    const cached = this.cache.get(key.id);
    if ((existing && !sameKey(existing, key)) || (cached && !sameKey(cached, key))) {
      throw new Error(CONFLICT);
    }
    return existing !== undefined;
  }

  private async saveKey(key: DataKey): Promise<void> {
    // Re-read even after import preflight so a newly visible conflict is refused.
    if (!await this.checkExisting(key)) {
      await this.write(`${PREFIX}key.${key.id}`, encodeDataKey(key));
    }
    this.cache.set(key.id, copyKey(key));
  }

  private async readIndex(): Promise<string[]> {
    const text = await this.read(INDEX);
    if (text === undefined) return [];
    try {
      const ids: unknown = JSON.parse(text);
      return Array.isArray(ids) ? ids.filter(isId) : [];
    } catch {
      // The index is advisory, never the only way to find an old token's key.
      return [];
    }
  }

  private async mergeIndex(extra: string[]): Promise<void> {
    const ids = new Set([...await this.readIndex(), ...this.cache.keys(), ...extra]);
    const active = await this.readActiveId();
    if (active !== undefined) ids.add(active);
    await this.write(INDEX, JSON.stringify([...ids].sort()));
  }

  private async read(key: string): Promise<string | undefined> {
    try {
      return await this.storage.get(key);
    } catch {
      throw new Error('无法读取字段加密密钥存储。');
    }
  }

  private async write(key: string, value: string): Promise<void> {
    try {
      await this.storage.store(key, value);
    } catch {
      throw new Error('无法保存字段加密密钥。');
    }
  }
}
