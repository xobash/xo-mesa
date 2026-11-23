import type { AgileInfo, CipherParams, PasswordKeyEncryptor } from "./encryptionInfo";
import {
  AES_BLOCK, aesKey, boundedMap, cbcDecrypt, cbcEncrypt, digest, fitTo, hmac, OfficeCryptoError,
  padBlocks, randomBytes, sameBytes, uint32le, type HashName,
} from "./primitives";

// Agile encryption (MS-OFFCRYPTO 2.3.4.10 to 2.3.4.15): password key
// derivation, verifier check, secret key, 4096-byte package segments and the
// HMAC over the whole EncryptedPackage stream.

const SEGMENT = 4096;
const PARALLEL = 64;

// Block keys, MS-OFFCRYPTO 2.3.4.13 and 2.3.4.14.
const BLOCK_VERIFIER_INPUT = new Uint8Array([0xfe, 0xa7, 0xd2, 0x76, 0x3b, 0x4b, 0x9e, 0x79]);
const BLOCK_VERIFIER_VALUE = new Uint8Array([0xd7, 0xaa, 0x0f, 0x6d, 0x30, 0x61, 0x34, 0x4e]);
const BLOCK_KEY_VALUE = new Uint8Array([0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6]);
const BLOCK_HMAC_KEY = new Uint8Array([0x5f, 0xb2, 0xad, 0x01, 0x0c, 0xb9, 0xe1, 0xf6]);
const BLOCK_HMAC_VALUE = new Uint8Array([0xa0, 0x67, 0x7f, 0x02, 0xb2, 0x2c, 0x84, 0x33]);

/** UTF-16LE password bytes, as MS-OFFCRYPTO hashes them. */
export function passwordBytes(password: string): Uint8Array {
  const out = new Uint8Array(password.length * 2);
  for (let i = 0; i < password.length; i++) {
    const unit = password.charCodeAt(i);
    out[i * 2] = unit & 0xff;
    out[i * 2 + 1] = unit >> 8;
  }
  return out;
}

/** H_n of 2.3.4.11: H0 = H(salt + password), then H(iterator + H) `spinCount` times. */
export async function spinHash(hash: HashName, salt: Uint8Array, password: Uint8Array, spinCount: number): Promise<Uint8Array> {
  let h = await digest(hash, salt, password);
  const buffer = new Uint8Array(4 + h.length);
  const view = new DataView(buffer.buffer);
  for (let i = 0; i < spinCount; i++) {
    view.setUint32(0, i, true);
    buffer.set(h, 4);
    h = await digest(hash, buffer);
  }
  return h;
}

/** Final key of 2.3.4.11: H(H_n + blockKey), truncated or padded with 0x36 to keyBits / 8. */
async function blockKey(p: CipherParams, spun: Uint8Array, block: Uint8Array): Promise<CryptoKey> {
  return aesKey(fitTo(await digest(p.hash, spun, block), p.keyBits / 8));
}

/** IV from the key data salt and a block key or segment index (2.3.4.12). */
async function derivedIv(p: CipherParams, suffix: Uint8Array): Promise<Uint8Array> {
  return fitTo(await digest(p.hash, p.salt, suffix), p.blockSize);
}

/** The package secret key, or `null` when the password is wrong (2.3.4.13). */
export async function unlockAgile(info: AgileInfo, password: Uint8Array): Promise<Uint8Array | null> {
  const p = info.password;
  const spun = await spinHash(p.hash, p.salt, password, p.spinCount);
  const iv = fitTo(p.salt, p.blockSize);
  const inputKey = await blockKey(p, spun, BLOCK_VERIFIER_INPUT);
  const valueKey = await blockKey(p, spun, BLOCK_VERIFIER_VALUE);
  const input = fitTo(await cbcDecrypt(inputKey, iv, p.encryptedVerifierHashInput), p.saltSize, 0);
  const expected = fitTo(await cbcDecrypt(valueKey, iv, p.encryptedVerifierHashValue), p.hashSize, 0);
  if (!sameBytes(await digest(p.hash, input), expected)) return null;
  const keyKey = await blockKey(p, spun, BLOCK_KEY_VALUE);
  const secret = await cbcDecrypt(keyKey, iv, p.encryptedKeyValue);
  if (secret.length < info.keyData.keyBits / 8) throw new OfficeCryptoError("The encrypted package key is truncated.");
  return secret.slice(0, info.keyData.keyBits / 8);
}

function segmentCount(length: number): number {
  return Math.ceil(length / SEGMENT);
}

/** Decrypts the EncryptedPackage stream after checking its HMAC; refuses any mismatch. */
export async function decryptAgilePackage(info: AgileInfo, secret: Uint8Array, stream: Uint8Array): Promise<Uint8Array> {
  const kd = info.keyData;
  if (stream.length < 8) throw new OfficeCryptoError("The encrypted package is truncated.");
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  if (view.getUint32(4, true) !== 0) throw new OfficeCryptoError("The encrypted package is too large.");
  const size = view.getUint32(0, true);
  const needed = Math.ceil(size / AES_BLOCK) * AES_BLOCK;
  if (8 + needed > stream.length) throw new OfficeCryptoError("The encrypted package is shorter than its declared size.");
  const key = await aesKey(secret);
  const hmacKey = fitTo(await cbcDecrypt(key, await derivedIv(kd, BLOCK_HMAC_KEY), info.encryptedHmacKey), kd.hashSize, 0);
  const hmacValue = fitTo(await cbcDecrypt(key, await derivedIv(kd, BLOCK_HMAC_VALUE), info.encryptedHmacValue), kd.hashSize, 0);
  if (!sameBytes(await hmac(kd.hash, hmacKey, stream), hmacValue)) {
    throw new OfficeCryptoError("The encrypted file failed its integrity check (HMAC). It may be damaged or altered, so Mesa does not open it.");
  }
  const cipher = stream.subarray(8, 8 + needed);
  const ivs = await boundedMap(segmentCount(needed), PARALLEL, (i) => derivedIv(kd, uint32le(i)));
  // One CBC pass over every segment, then swap the chaining block at each segment start for its own IV.
  const plain = await cbcDecrypt(key, ivs[0] ?? new Uint8Array(AES_BLOCK), cipher);
  for (let s = 1; s < ivs.length; s++) {
    const at = s * SEGMENT;
    for (let i = 0; i < AES_BLOCK; i++) plain[at + i] ^= cipher[at - AES_BLOCK + i] ^ ivs[s][i];
  }
  return plain.subarray(0, size);
}

export interface AgileTemplate {
  readonly keyData: CipherParams;
  readonly password: PasswordKeyEncryptor;
}

function freshParams<T extends CipherParams>(p: T): T {
  return { ...p, salt: randomBytes(p.saltSize) };
}

/** Encrypts `plain` with a new secret key and new salts, keeping the template's cipher, hash and spin count. */
export async function encryptAgile(template: AgileTemplate, password: Uint8Array, plain: Uint8Array): Promise<{ info: Omit<AgileInfo, "kind" | "otherEncryptors">; stream: Uint8Array }> {
  if (plain.length > 0xffffffff) throw new OfficeCryptoError("The document is too large to encrypt.");
  const kd = freshParams(template.keyData);
  const secret = randomBytes(kd.keyBits / 8);
  const key = await aesKey(secret);
  const stream = new Uint8Array(8 + Math.ceil(plain.length / AES_BLOCK) * AES_BLOCK);
  new DataView(stream.buffer).setUint32(0, plain.length, true);
  await boundedMap(segmentCount(plain.length), PARALLEL, async (i) => {
    const chunk = padBlocks(plain.subarray(i * SEGMENT, Math.min(plain.length, (i + 1) * SEGMENT)));
    stream.set(await cbcEncrypt(key, await derivedIv(kd, uint32le(i)), chunk), 8 + i * SEGMENT);
  });
  const hmacKey = randomBytes(kd.hashSize);
  const hmacValue = await hmac(kd.hash, hmacKey, stream);
  const encryptedHmacKey = await cbcEncrypt(key, await derivedIv(kd, BLOCK_HMAC_KEY), padBlocks(hmacKey));
  const encryptedHmacValue = await cbcEncrypt(key, await derivedIv(kd, BLOCK_HMAC_VALUE), padBlocks(hmacValue));

  const p = freshParams(template.password);
  const spun = await spinHash(p.hash, p.salt, password, p.spinCount);
  const iv = fitTo(p.salt, p.blockSize);
  const verifierInput = randomBytes(p.saltSize);
  const encryptedVerifierHashInput = await cbcEncrypt(await blockKey(p, spun, BLOCK_VERIFIER_INPUT), iv, padBlocks(verifierInput));
  const encryptedVerifierHashValue = await cbcEncrypt(await blockKey(p, spun, BLOCK_VERIFIER_VALUE), iv, padBlocks(await digest(p.hash, verifierInput)));
  const encryptedKeyValue = await cbcEncrypt(await blockKey(p, spun, BLOCK_KEY_VALUE), iv, padBlocks(secret));
  return {
    info: {
      keyData: kd,
      encryptedHmacKey,
      encryptedHmacValue,
      password: { ...p, encryptedVerifierHashInput, encryptedVerifierHashValue, encryptedKeyValue },
    },
    stream,
  };
}
