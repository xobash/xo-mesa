import { forEachStartTag, localName, readAttributes } from "../ooxml/xmlScan";
import { base64ToBytes, hashBytes, OfficeCryptoError, type HashName } from "./primitives";
import { bytesToBase64 } from "../base64";

// The EncryptionInfo stream of an encrypted OOXML file (MS-OFFCRYPTO 2.3.4).
// Agile (2.3.4.10) is XML after an 8-byte version header; Standard (2.3.4.5)
// is a binary header and verifier. Anything else is reported, not guessed.

export const MAX_SPIN_COUNT = 10_000_000;
const MAX_INFO_BYTES = 1024 * 1024;
const MAX_SALT_BYTES = 65_536;
const PASSWORD_URI = "http://schemas.microsoft.com/office/2006/keyEncryptor/password";

export interface CipherParams {
  readonly saltSize: number;
  readonly blockSize: number;
  readonly keyBits: number;
  readonly hashSize: number;
  readonly hash: HashName;
  /** Spelling as found, kept when re-encrypting. */
  readonly hashAlgorithm: string;
  readonly salt: Uint8Array;
}

export interface PasswordKeyEncryptor extends CipherParams {
  readonly spinCount: number;
  readonly encryptedVerifierHashInput: Uint8Array;
  readonly encryptedVerifierHashValue: Uint8Array;
  readonly encryptedKeyValue: Uint8Array;
}

export interface AgileInfo {
  readonly kind: "agile";
  readonly keyData: CipherParams;
  readonly encryptedHmacKey: Uint8Array;
  readonly encryptedHmacValue: Uint8Array;
  readonly password: PasswordKeyEncryptor;
  /** Key encryptors other than the password one (certificates); saving would drop them. */
  readonly otherEncryptors: number;
}

export interface StandardInfo {
  readonly kind: "standard";
  readonly keyBits: number;
  readonly salt: Uint8Array;
  readonly encryptedVerifier: Uint8Array;
  readonly verifierHashSize: number;
  readonly encryptedVerifierHash: Uint8Array;
}

export interface UnsupportedInfo {
  readonly kind: "unsupported";
  readonly reason: string;
}

export type EncryptionInfo = AgileInfo | StandardInfo | UnsupportedInfo;

const unsupported = (reason: string): UnsupportedInfo => ({ kind: "unsupported", reason });

function hashName(value: string): HashName | null {
  const v = value.toUpperCase().replace("-", "");
  if (v === "SHA1") return "SHA-1";
  if (v === "SHA256") return "SHA-256";
  if (v === "SHA384") return "SHA-384";
  if (v === "SHA512") return "SHA-512";
  return null;
}

function int(attrs: Map<string, string>, name: string, min: number, max: number): number {
  const raw = attrs.get(name);
  const value = raw !== undefined && /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
  if (!(value >= min && value <= max)) throw new OfficeCryptoError(`The encryption setting ${name} is missing or out of range.`);
  return value;
}

function bytes(attrs: Map<string, string>, name: string): Uint8Array {
  const raw = attrs.get(name);
  if (raw === undefined) throw new OfficeCryptoError(`The encryption setting ${name} is missing.`);
  return base64ToBytes(raw);
}

/** Cipher settings shared by keyData and the password encryptor; refuses what WebCrypto cannot do. */
function cipherParams(attrs: Map<string, string>): CipherParams | string {
  const cipher = attrs.get("cipherAlgorithm") ?? "";
  const chaining = attrs.get("cipherChaining") ?? "";
  const hashAlgorithm = attrs.get("hashAlgorithm") ?? "";
  if (cipher !== "AES") return `it uses the ${cipher || "unknown"} cipher; Mesa supports AES only`;
  if (chaining !== "ChainingModeCBC") return `it uses ${chaining || "an unknown"} chaining; Mesa supports CBC only`;
  const hash = hashName(hashAlgorithm);
  if (!hash) return `it uses the ${hashAlgorithm || "unknown"} hash; Mesa supports SHA-1 and SHA-2`;
  const params: CipherParams = {
    saltSize: int(attrs, "saltSize", 1, MAX_SALT_BYTES),
    blockSize: int(attrs, "blockSize", 16, 16),
    keyBits: int(attrs, "keyBits", 128, 256),
    hashSize: int(attrs, "hashSize", 20, 64),
    hash,
    hashAlgorithm,
    salt: bytes(attrs, "saltValue"),
  };
  if (![128, 192, 256].includes(params.keyBits)) return `it uses a ${params.keyBits}-bit key`;
  if (params.hashSize !== hashBytes(hash)) throw new OfficeCryptoError("The encryption hash size does not match its algorithm.");
  if (params.salt.length !== params.saltSize) throw new OfficeCryptoError("The encryption salt does not match its declared size.");
  return params;
}

function parseAgile(xmlBytes: Uint8Array): EncryptionInfo {
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(xmlBytes);
  } catch {
    throw new OfficeCryptoError("The encryption description is not valid UTF-8.");
  }
  let keyData: Map<string, string> | null = null;
  let integrity: Map<string, string> | null = null;
  let encryptedKey: Map<string, string> | null = null;
  let passwordEncryptors = 0;
  let encryptors = 0;
  let inPassword = false;
  try {
    forEachStartTag(xml, (tag) => {
      const name = localName(tag.qname);
      const attrs = readAttributes(tag.attributes);
      if (name === "keyData" && !keyData) keyData = attrs;
      else if (name === "dataIntegrity" && !integrity) integrity = attrs;
      else if (name === "keyEncryptor") {
        encryptors++;
        inPassword = attrs.get("uri") === PASSWORD_URI;
        if (inPassword) passwordEncryptors++;
      } else if (name === "encryptedKey" && inPassword && !encryptedKey) encryptedKey = attrs;
    });
  } catch (error) {
    throw new OfficeCryptoError(`The encryption description is not readable XML (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (!keyData || !encryptedKey) {
    return passwordEncryptors ? unsupported("its encryption description is incomplete") : unsupported("it is protected with a certificate, not a password");
  }
  if (!integrity) return unsupported("it has no data integrity check, so Mesa cannot verify the decrypted contents");
  const data = cipherParams(keyData);
  if (typeof data === "string") return unsupported(data);
  const pass = cipherParams(encryptedKey);
  if (typeof pass === "string") return unsupported(pass);
  const password: PasswordKeyEncryptor = {
    ...pass,
    spinCount: int(encryptedKey, "spinCount", 0, MAX_SPIN_COUNT),
    encryptedVerifierHashInput: bytes(encryptedKey, "encryptedVerifierHashInput"),
    encryptedVerifierHashValue: bytes(encryptedKey, "encryptedVerifierHashValue"),
    encryptedKeyValue: bytes(encryptedKey, "encryptedKeyValue"),
  };
  return {
    kind: "agile",
    keyData: data,
    encryptedHmacKey: bytes(integrity, "encryptedHmacKey"),
    encryptedHmacValue: bytes(integrity, "encryptedHmacValue"),
    password,
    otherEncryptors: encryptors - 1,
  };
}

const FLAG_CRYPTOAPI = 0x04;
const FLAG_EXTERNAL = 0x10;
const FLAG_AES = 0x20;
const ALG_AES = [0x660e, 0x660f, 0x6610];
const ALG_SHA1 = 0x8004;

function parseStandard(view: DataView, length: number): EncryptionInfo {
  const flags = view.getUint32(4, true);
  if (flags & FLAG_EXTERNAL) return unsupported("it uses extensible encryption from a third-party provider");
  if (!(flags & FLAG_CRYPTOAPI) || !(flags & FLAG_AES)) return unsupported("it uses RC4 encryption, which Mesa does not open");
  const headerSize = view.getUint32(8, true);
  const verifierAt = 12 + headerSize;
  if (headerSize < 32 || verifierAt + 4 + 16 + 16 + 4 + 32 > length) throw new OfficeCryptoError("The Standard encryption header is truncated.");
  const algId = view.getUint32(20, true);
  const hashId = view.getUint32(24, true);
  const keyBits = view.getUint32(28, true);
  if (!ALG_AES.includes(algId) || (hashId !== ALG_SHA1 && hashId !== 0)) return unsupported("it uses a Standard encryption algorithm Mesa does not support");
  if (![128, 192, 256].includes(keyBits)) return unsupported(`it uses a ${keyBits}-bit key`);
  const saltSize = view.getUint32(verifierAt, true);
  if (saltSize !== 16) throw new OfficeCryptoError("The Standard encryption salt has the wrong size.");
  const at = (offset: number, size: number) => new Uint8Array(view.buffer, view.byteOffset + verifierAt + offset, size).slice();
  const verifierHashSize = view.getUint32(verifierAt + 36, true);
  if (verifierHashSize !== 20) throw new OfficeCryptoError("The Standard encryption verifier has the wrong size.");
  return {
    kind: "standard",
    keyBits,
    salt: at(4, 16),
    encryptedVerifier: at(20, 16),
    verifierHashSize,
    encryptedVerifierHash: at(40, 32),
  };
}

/** Parses the EncryptionInfo stream. Throws `OfficeCryptoError` on damage. */
export function parseEncryptionInfo(stream: Uint8Array): EncryptionInfo {
  if (stream.length < 8) throw new OfficeCryptoError("The encryption description is truncated.");
  if (stream.length > MAX_INFO_BYTES) throw new OfficeCryptoError("The encryption description is too large.");
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const major = view.getUint16(0, true);
  const minor = view.getUint16(2, true);
  if (major === 4 && minor === 4) {
    if (view.getUint32(4, true) !== 0x40) throw new OfficeCryptoError("The Agile encryption header is damaged.");
    return parseAgile(stream.subarray(8));
  }
  if ((major === 3 || major === 4) && minor === 3) return unsupported("it uses extensible encryption from a third-party provider");
  if (major >= 2 && major <= 4 && minor === 2) return parseStandard(view, stream.length);
  return unsupported(`it uses encryption version ${major}.${minor}, which Mesa does not know`);
}

function cipherAttrs(p: CipherParams): string {
  return `saltSize="${p.saltSize}" blockSize="${p.blockSize}" keyBits="${p.keyBits}" hashSize="${p.hashSize}" `
    + `cipherAlgorithm="AES" cipherChaining="ChainingModeCBC" hashAlgorithm="${p.hashAlgorithm}" saltValue="${bytesToBase64(p.salt)}"`;
}

/** Agile EncryptionInfo bytes with one password key encryptor (2.3.4.10). */
export function serializeAgileInfo(info: Omit<AgileInfo, "kind" | "otherEncryptors">): Uint8Array {
  const p = info.password;
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n`
    + `<encryption xmlns="http://schemas.microsoft.com/office/2006/encryption" xmlns:p="${PASSWORD_URI}">`
    + `<keyData ${cipherAttrs(info.keyData)}/>`
    + `<dataIntegrity encryptedHmacKey="${bytesToBase64(info.encryptedHmacKey)}" encryptedHmacValue="${bytesToBase64(info.encryptedHmacValue)}"/>`
    + `<keyEncryptors><keyEncryptor uri="${PASSWORD_URI}"><p:encryptedKey spinCount="${p.spinCount}" ${cipherAttrs(p)} `
    + `encryptedVerifierHashInput="${bytesToBase64(p.encryptedVerifierHashInput)}" encryptedVerifierHashValue="${bytesToBase64(p.encryptedVerifierHashValue)}" `
    + `encryptedKeyValue="${bytesToBase64(p.encryptedKeyValue)}"/></keyEncryptor></keyEncryptors></encryption>`;
  const body = new TextEncoder().encode(xml);
  const out = new Uint8Array(8 + body.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, 4, true);
  view.setUint16(2, 4, true);
  view.setUint32(4, 0x40, true);
  out.set(body, 8);
  return out;
}
