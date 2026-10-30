import { randomBytes, randomUUID } from 'node:crypto';
import { AES } from '@stablelib/aes';
import { SIV } from '@stablelib/siv';

export interface DataKey {
  id: string;
  material: Uint8Array;
}

const KEY_BYTES = 64; // AES-256-SIV uses two independent 32-byte AES keys.
const VERSION = 'v1';
const INVALID_KEY = '字段加密密钥格式无效。';
const INVALID_TOKEN = '字段密文格式无效或认证失败。';

// The type byte and its entire body are encrypted and authenticated. Strings
// use UTF-16LE so even lone surrogates remain distinct from replacement chars.
enum ValueType { String = 1, Number, BigInt, Boolean, Date, Buffer }

function validKeyId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && !/[^A-Za-z0-9_-]/.test(id);
}

function requireKey(key: DataKey): void {
  if (!key || !validKeyId(key.id)
    || !(key.material instanceof Uint8Array) || key.material.length !== KEY_BYTES) {
    throw new Error(INVALID_KEY);
  }
}

function tagged(type: ValueType, body: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from([type]), body]);
}

function numeric(type: ValueType, value: number): Buffer {
  const result = Buffer.alloc(9);
  result[0] = type;
  result.writeDoubleBE(value, 1);
  return result;
}

function encodeValue(value: unknown): Buffer {
  if (typeof value === 'string') return tagged(ValueType.String, Buffer.from(value, 'utf16le'));
  if (typeof value === 'number' && Number.isFinite(value)) return numeric(ValueType.Number, value);
  if (typeof value === 'bigint') return tagged(ValueType.BigInt, Buffer.from(value.toString(), 'utf8'));
  if (typeof value === 'boolean') return Buffer.from([ValueType.Boolean, value ? 1 : 0]);
  if (value instanceof Date) {
    const time = Date.prototype.getTime.call(value);
    if (Number.isFinite(time)) return numeric(ValueType.Date, time);
  }
  if (Buffer.isBuffer(value)) return tagged(ValueType.Buffer, value);
  throw new Error('不支持此字段值类型或格式。');
}

function decodeValue(bytes: Buffer): unknown {
  const body = bytes.subarray(1);
  switch (bytes[0]) {
    case ValueType.String:
      if (body.length % 2 === 0) return body.toString('utf16le');
      break;
    case ValueType.Number:
      if (body.length === 8) {
        const value = body.readDoubleBE();
        if (Number.isFinite(value)) return value;
      }
      break;
    case ValueType.BigInt: {
      const text = body.toString('utf8');
      const match = /^(0|-?[1-9][0-9]*)$/.exec(text);
      if (match?.[0] === text) return BigInt(text);
      break;
    }
    case ValueType.Boolean:
      if (body.length === 1 && (body[0] === 0 || body[0] === 1)) return body[0] === 1;
      break;
    case ValueType.Date:
      if (body.length === 8) {
        const time = body.readDoubleBE();
        const date = new Date(time);
        if (Number.isFinite(time) && !Object.is(time, -0) && date.getTime() === time) return date;
      }
      break;
    case ValueType.Buffer:
      return Buffer.from(body); // The decrypted working buffer is erased below.
  }
  throw new Error(INVALID_TOKEN);
}

function domainBytes(domain: string): Buffer {
  if (typeof domain !== 'string') throw new Error(INVALID_TOKEN);
  const bytes = Buffer.from(domain, 'utf8');
  if (bytes.toString('utf8') !== domain) throw new Error(INVALID_TOKEN);
  return bytes;
}

function readBase64(text: string, encoding: 'base64' | 'base64url'): Buffer {
  const pattern = encoding === 'base64' ? /^[A-Za-z0-9+/]*={0,2}$/ : /^[A-Za-z0-9_-]*$/;
  if (!pattern.test(text)) throw new Error(INVALID_TOKEN);
  const bytes = Buffer.from(text, encoding);
  // Node's decoder tolerates padding aliases, ignored characters and stray bits.
  if (bytes.toString(encoding) !== text) throw new Error(INVALID_TOKEN);
  return bytes;
}

// v1 binds the envelope context/version, key ID and UTF-8 domain as separate AD
// items, avoiding ambiguity between variable-length metadata fields.
function associatedData(id: string, domain: Uint8Array): Uint8Array[] {
  return [Buffer.from(`enc:${VERSION}`, 'utf8'), Buffer.from(id, 'utf8'), domain];
}

export function createDataKey(): DataKey {
  return { id: randomUUID(), material: randomBytes(KEY_BYTES) };
}

export function encryptValue(value: unknown, domain: string, key: DataKey): string | null | undefined {
  if (value === null || value === undefined) return value;
  let cipher: SIV | undefined;
  let plaintext: Buffer | undefined;
  try {
    requireKey(key);
    const encodedDomain = domainBytes(domain);
    plaintext = encodeValue(value);
    cipher = new SIV(AES, key.material);
    const payload = cipher.seal(associatedData(key.id, encodedDomain), plaintext);
    return `enc:${VERSION}:${key.id}:${encodedDomain.toString('base64url')}:${Buffer.from(payload).toString('base64url')}`;
  } catch {
    throw new Error('字段值无法加密：类型、逻辑域或密钥无效。');
  } finally {
    cipher?.clean();
    plaintext?.fill(0);
  }
}

export function isEncryptedValue(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('enc:');
}

export function decryptValue(
  token: string,
  lookup: (id: string) => DataKey | undefined,
  expectedDomain?: string,
): unknown {
  if (!isEncryptedValue(token)) throw new Error(INVALID_TOKEN);
  const parts = token.split(':');
  if (parts[1] !== VERSION) throw new Error('不支持此字段密文版本。');
  if (parts.length !== 5 || !validKeyId(parts[2])) throw new Error(INVALID_TOKEN);
  const id = parts[2];
  let encodedDomain: Buffer;
  let domain: string;
  let payload: Buffer;
  try {
    encodedDomain = readBase64(parts[3], 'base64url');
    domain = encodedDomain.toString('utf8');
    if (!domainBytes(domain).equals(encodedDomain)) throw new Error(INVALID_TOKEN);
    payload = readBase64(parts[4], 'base64url');
    if (payload.length < 17) throw new Error(INVALID_TOKEN);
  } catch {
    throw new Error(INVALID_TOKEN);
  }
  if (expectedDomain !== undefined && domain !== expectedDomain) {
    throw new Error('字段密文的逻辑域不匹配。');
  }
  let key: DataKey | undefined;
  try {
    key = lookup(id);
  } catch {
    throw new Error('无法读取字段密文所需的密钥。');
  }
  if (key === undefined) throw new Error('找不到字段密文所需的密钥。');
  let cipher: SIV | undefined;
  let plaintext: Uint8Array | null = null;
  try {
    requireKey(key);
    if (key.id !== id) throw new Error(INVALID_TOKEN);
    cipher = new SIV(AES, key.material);
    plaintext = cipher.open(associatedData(id, encodedDomain), payload);
    if (plaintext === null) throw new Error(INVALID_TOKEN);
    return decodeValue(Buffer.from(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength));
  } catch {
    throw new Error(INVALID_TOKEN);
  } finally {
    cipher?.clean();
    plaintext?.fill(0);
  }
}

/** Explicit export only: the returned JSON contains sensitive key material. */
export function encodeDataKey(key: DataKey): string {
  try {
    requireKey(key);
    return JSON.stringify({ version: 1, id: key.id, material: Buffer.from(key.material).toString('base64') });
  } catch {
    throw new Error(INVALID_KEY);
  }
}

export function decodeDataKey(text: string): DataKey {
  try {
    if (typeof text !== 'string') throw new Error(INVALID_KEY);
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(INVALID_KEY);
    const record = raw as Record<string, unknown>;
    if (Object.keys(record).length !== 3 || record.version !== 1
      || !validKeyId(record.id) || typeof record.material !== 'string') {
      throw new Error(INVALID_KEY);
    }
    const key = { id: record.id, material: readBase64(record.material, 'base64') };
    requireKey(key);
    return key;
  } catch {
    throw new Error(INVALID_KEY);
  }
}
