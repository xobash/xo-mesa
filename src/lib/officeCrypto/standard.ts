import type { StandardInfo } from "./encryptionInfo";
import { aesKey, AES_BLOCK, digest, ecbDecrypt, OfficeCryptoError, sameBytes, uint32le } from "./primitives";

// Standard encryption (MS-OFFCRYPTO 2.3.4.5 to 2.3.4.9): SHA-1 with 50,000
// iterations and AES-ECB over the whole package. Mesa decrypts it for
// viewing only; saving would have to change the file to Agile encryption.

const STANDARD_SPIN = 50_000;

/** 2.3.4.7: iterated SHA-1, block 0, then the CryptDeriveKey expansion. */
async function standardKey(info: StandardInfo, password: Uint8Array): Promise<CryptoKey> {
  let h = await digest("SHA-1", info.salt, password);
  const buffer = new Uint8Array(24);
  const view = new DataView(buffer.buffer);
  for (let i = 0; i < STANDARD_SPIN; i++) {
    view.setUint32(0, i, true);
    buffer.set(h, 4);
    h = await digest("SHA-1", buffer);
  }
  const final = await digest("SHA-1", h, uint32le(0));
  const pad1 = new Uint8Array(64).fill(0x36);
  const pad2 = new Uint8Array(64).fill(0x5c);
  for (let i = 0; i < final.length; i++) { pad1[i] ^= final[i]; pad2[i] ^= final[i]; }
  const derived = new Uint8Array(40);
  derived.set(await digest("SHA-1", pad1), 0);
  derived.set(await digest("SHA-1", pad2), 20);
  return aesKey(derived.slice(0, info.keyBits / 8));
}

/** The package key, or `null` when the password is wrong (2.3.4.9). */
export async function unlockStandard(info: StandardInfo, password: Uint8Array): Promise<CryptoKey | null> {
  const key = await standardKey(info, password);
  const verifier = await ecbDecrypt(key, info.encryptedVerifier);
  const expected = (await ecbDecrypt(key, info.encryptedVerifierHash)).subarray(0, info.verifierHashSize);
  return sameBytes(await digest("SHA-1", verifier), expected) ? key : null;
}

export async function decryptStandardPackage(key: CryptoKey, stream: Uint8Array): Promise<Uint8Array> {
  if (stream.length < 8) throw new OfficeCryptoError("The encrypted package is truncated.");
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  if (view.getUint32(4, true) !== 0) throw new OfficeCryptoError("The encrypted package is too large.");
  const size = view.getUint32(0, true);
  const needed = Math.ceil(size / AES_BLOCK) * AES_BLOCK;
  if (8 + needed > stream.length) throw new OfficeCryptoError("The encrypted package is shorter than its declared size.");
  return (await ecbDecrypt(key, stream.subarray(8, 8 + needed))).subarray(0, size);
}
