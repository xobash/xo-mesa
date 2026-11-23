// WebCrypto building blocks for MS-OFFCRYPTO. WebCrypto's AES-CBC always
// applies PKCS#7 padding, while Office ciphertext has none, so these helpers
// strip or synthesize the padding block. AES-ECB (Standard encryption) is
// decrypted as one CBC call with a zero IV and a per-block fix-up.

export type HashName = "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";

export const AES_BLOCK = 16;

/** Damaged or unsupported encryption data (never a wrong password). */
export class OfficeCryptoError extends Error {}

const HASH_BYTES: Record<HashName, number> = { "SHA-1": 20, "SHA-256": 32, "SHA-384": 48, "SHA-512": 64 };

export function hashBytes(hash: HashName): number {
  return HASH_BYTES[hash];
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new OfficeCryptoError("This system has no WebCrypto, so Mesa cannot open password-protected files.");
  return s;
}

/** WebCrypto takes views of a plain ArrayBuffer; anything else is copied. */
function own(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) return bytes as Uint8Array<ArrayBuffer>;
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export function uint32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  // getRandomValues fills at most 65,536 bytes per call.
  for (let at = 0; at < length; at += 65_536) globalThis.crypto.getRandomValues(out.subarray(at, Math.min(length, at + 65_536)));
  return out;
}

export async function digest(hash: HashName, ...parts: readonly Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest(hash, own(parts.length === 1 ? parts[0] : concat(...parts))));
}

/** Truncates, or pads with `fill`, to `length` bytes (MS-OFFCRYPTO 2.3.4.11 and 2.3.4.12 use 0x36). */
export function fitTo(bytes: Uint8Array, length: number, fill = 0x36): Uint8Array {
  if (bytes.length >= length) return bytes.slice(0, length);
  const out = new Uint8Array(length).fill(fill);
  out.set(bytes);
  return out;
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  if (![16, 24, 32].includes(raw.length)) throw new OfficeCryptoError("The file uses an AES key size Mesa does not support.");
  return subtle().importKey("raw", own(raw), { name: "AES-CBC" }, false, ["encrypt", "decrypt"]);
}

function checkBlocks(data: Uint8Array): void {
  if (data.length % AES_BLOCK) throw new OfficeCryptoError("Encrypted data is not a whole number of AES blocks.");
}

/** AES-CBC without padding; `data` must be whole blocks. */
export async function cbcEncrypt(key: CryptoKey, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  checkBlocks(data);
  const out = new Uint8Array(await subtle().encrypt({ name: "AES-CBC", iv: own(iv) }, key, own(data)));
  return out.subarray(0, data.length);
}

/** AES-CBC decryption of unpadded whole blocks. A synthesized final block
 *  that decrypts to a full PKCS#7 pad lets WebCrypto accept the input. */
export async function cbcDecrypt(key: CryptoKey, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  checkBlocks(data);
  if (!data.length) return new Uint8Array(0);
  const last = data.subarray(data.length - AES_BLOCK);
  const pad = new Uint8Array(await subtle().encrypt({ name: "AES-CBC", iv: own(last) }, key, new Uint8Array(0)));
  const input = new Uint8Array(data.length + AES_BLOCK);
  input.set(data);
  input.set(pad.subarray(0, AES_BLOCK), data.length);
  const out = new Uint8Array(await subtle().decrypt({ name: "AES-CBC", iv: own(iv) }, key, input as Uint8Array<ArrayBuffer>));
  if (out.length !== data.length) throw new OfficeCryptoError("AES decryption returned an unexpected length.");
  return out;
}

/** AES-ECB decryption: one zero-IV CBC pass, then undo the chaining XOR. */
export async function ecbDecrypt(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const out = await cbcDecrypt(key, new Uint8Array(AES_BLOCK), data);
  for (let i = AES_BLOCK; i < out.length; i++) out[i] ^= data[i - AES_BLOCK];
  return out;
}

export async function hmac(hash: HashName, key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle().importKey("raw", own(key), { name: "HMAC", hash }, false, ["sign"]);
  return new Uint8Array(await subtle().sign("HMAC", k, own(data)));
}

/** Rounds up to whole AES blocks, padding with zeros. */
export function padBlocks(data: Uint8Array): Uint8Array {
  const length = Math.ceil(data.length / AES_BLOCK) * AES_BLOCK;
  if (length === data.length) return data;
  const out = new Uint8Array(length);
  out.set(data);
  return out;
}

export function base64ToBytes(text: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(text.replace(/\s+/g, ""));
  } catch {
    throw new OfficeCryptoError("The encryption data has an invalid base64 value.");
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Runs `work` over `count` items with at most `width` in flight; results keep their order. */
export async function boundedMap<T>(count: number, width: number, work: (index: number) => Promise<T>): Promise<T[]> {
  const out = new Array<T>(count);
  for (let start = 0; start < count; start += width) {
    const batch: Promise<void>[] = [];
    for (let i = start; i < Math.min(count, start + width); i++) batch.push(work(i).then((value) => { out[i] = value; }));
    await Promise.all(batch);
  }
  return out;
}
