import { CfbError, isCfb, readCfb, writeCfb, type CfbFile } from "../cfb";
import { decryptAgilePackage, encryptAgile, passwordBytes, unlockAgile } from "./agile";
import { parseEncryptionInfo, serializeAgileInfo, type EncryptionInfo } from "./encryptionInfo";
import { OfficeCryptoError, sameBytes } from "./primitives";
import { decryptStandardPackage, unlockStandard } from "./standard";

// Password-protected OOXML: an OLE compound file holding EncryptionInfo and
// EncryptedPackage (MS-OFFCRYPTO 2.3.4.4). Opening decrypts the package;
// saving re-encrypts with Agile, copies every other stream, writes a new
// compound file and decrypts it back before returning it.

export { OfficeCryptoError } from "./primitives";

const INFO = "EncryptionInfo";
const PACKAGE = "EncryptedPackage";

/** The password did not unlock the file. */
export class WrongPasswordError extends Error {
  constructor() { super("That password is not correct."); }
}

export type OfficeProtection =
  | { readonly kind: "none" }
  | { readonly kind: "unsupported"; readonly reason: string }
  | { readonly kind: "password"; readonly scheme: "agile" | "standard"; readonly readOnlyReason: string | null };

interface Opened { cfb: CfbFile; info: EncryptionInfo; stream: Uint8Array }

/** `damaged` decides what an unreadable compound file means: for inspection it
 *  is "not known to be encrypted" (the package layer then gives its reason). */
function open(bytes: Uint8Array, damaged: "none" | "throw" = "throw"): Opened | null {
  if (!isCfb(bytes)) return null;
  let cfb: CfbFile;
  try {
    cfb = readCfb(bytes);
  } catch (error) {
    if (!(error instanceof CfbError)) throw error;
    if (damaged === "none") return null;
    throw new OfficeCryptoError(`The encrypted file is damaged: ${error.message}`);
  }
  const infoBytes = cfb.read(INFO);
  const stream = cfb.read(PACKAGE);
  if (!infoBytes || !stream) return null;
  return { cfb, info: parseEncryptionInfo(infoBytes), stream };
}

/** Whether these bytes are a password-protected Office package and what Mesa can do with it. Never throws for non-CFB input. */
export function inspectOfficeProtection(bytes: Uint8Array): OfficeProtection {
  let opened: Opened | null;
  try {
    opened = open(bytes, "none");
  } catch (error) {
    if (error instanceof OfficeCryptoError) return { kind: "unsupported", reason: error.message };
    throw error;
  }
  if (!opened) return { kind: "none" };
  const { info } = opened;
  if (info.kind === "unsupported") return { kind: "unsupported", reason: `This file is encrypted, but Mesa cannot open it: ${info.reason}.` };
  if (info.kind === "standard") {
    return { kind: "password", scheme: "standard", readOnlyReason: "This file uses the older Standard encryption. Mesa opens it read-only, because saving would change its encryption." };
  }
  return {
    kind: "password",
    scheme: "agile",
    readOnlyReason: info.otherEncryptors > 0 ? "This file can also be opened with a certificate. Mesa opens it read-only, because saving would remove that." : null,
  };
}

/** Decrypts a password-protected package. Throws `WrongPasswordError` or `OfficeCryptoError`. */
export async function decryptOfficeFile(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  const opened = open(bytes);
  if (!opened) throw new OfficeCryptoError("This file is not password-protected.");
  const { info, stream } = opened;
  const secret = passwordBytes(password);
  try {
    if (info.kind === "agile") {
      const key = await unlockAgile(info, secret);
      if (!key) throw new WrongPasswordError();
      return await decryptAgilePackage(info, key, stream);
    }
    if (info.kind === "standard") {
      const key = await unlockStandard(info, secret);
      if (!key) throw new WrongPasswordError();
      return await decryptStandardPackage(key, stream);
    }
    throw new OfficeCryptoError(info.reason);
  } finally {
    secret.fill(0);
  }
}

/**
 * Re-encrypts `plain` into a new compound file shaped like `template` (the
 * encrypted bytes on disk): same cipher, hash and spin count, fresh salts and
 * key, every other stream copied byte-for-byte. The result is decrypted back
 * and compared before it is returned.
 */
export async function encryptOfficeFile(template: Uint8Array, plain: Uint8Array, password: string): Promise<Uint8Array> {
  const opened = open(template);
  if (!opened) throw new OfficeCryptoError("The file on disk is no longer password-protected.");
  const { cfb, info } = opened;
  if (info.kind !== "agile") throw new OfficeCryptoError("Mesa saves only files that use Agile encryption.");
  if (info.otherEncryptors > 0) throw new OfficeCryptoError("Saving would remove the file's certificate access.");
  const secret = passwordBytes(password);
  let sealed: { info: Parameters<typeof serializeAgileInfo>[0]; stream: Uint8Array };
  try {
    sealed = await encryptAgile(info, secret, plain);
  } finally {
    secret.fill(0);
  }
  const streams = cfb.streams
    .filter((s) => s.path.toUpperCase() !== INFO.toUpperCase() && s.path.toUpperCase() !== PACKAGE.toUpperCase())
    .map((s) => ({ path: s.path, bytes: cfb.read(s.path)! }));
  streams.push({ path: INFO, bytes: serializeAgileInfo(sealed.info) }, { path: PACKAGE, bytes: sealed.stream });
  let out: Uint8Array;
  try {
    out = writeCfb(streams);
  } catch (error) {
    if (error instanceof CfbError) throw new OfficeCryptoError(`Mesa could not write the encrypted file: ${error.message}`);
    throw error;
  }
  const check = await decryptOfficeFile(out, password);
  if (!sameBytes(check, plain)) throw new OfficeCryptoError("The re-encrypted file did not decrypt to the edited document, so Mesa did not save it.");
  return out;
}
