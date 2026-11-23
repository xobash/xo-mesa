import { describe, expect, it, vi } from "vitest";
import { readCfb, writeCfb } from "../cfb";
import { passwordBytes, spinHash } from "./agile";
import {
  decryptOfficeFile, encryptOfficeFile, inspectOfficeProtection, OfficeCryptoError, WrongPasswordError,
} from "./encryptedOffice";
import { parseEncryptionInfo } from "./encryptionInfo";
import { base64ToBytes } from "./primitives";
import { agileSha1Vector, agileVector, standardVector } from "./fixtures/referenceVectors";
import { bytesToHex } from "../hex";

const plainOf = (length: number) => Uint8Array.from({ length }, (_, i) => (i * 31 + 7) & 0xff);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const DATASPACE = { path: "\u0006DataSpaces/Version", bytes: Uint8Array.from([1, 2, 3, 4, 5]) };

function container(vector: { info: string; package: string }, extra = [DATASPACE]): Uint8Array {
  return writeCfb([
    ...extra,
    { path: "EncryptionInfo", bytes: base64ToBytes(vector.info) },
    { path: "EncryptedPackage", bytes: base64ToBytes(vector.package) },
  ]);
}

function infoXml(vector: { info: string }): string {
  return new TextDecoder().decode(base64ToBytes(vector.info).subarray(8));
}

function withInfoXml(vector: { info: string; package: string }, edit: (xml: string) => string): Uint8Array {
  const header = base64ToBytes(vector.info).subarray(0, 8);
  const body = new TextEncoder().encode(edit(infoXml(vector)));
  const info = new Uint8Array(8 + body.length);
  info.set(header);
  info.set(body, 8);
  return writeCfb([{ path: "EncryptionInfo", bytes: info }, { path: "EncryptedPackage", bytes: base64ToBytes(vector.package) }]);
}

/** Each Agile vector spins 100,000 SHA-512 rounds: about 1 s alone, 2–7 s in
 *  a loaded full run, so the default 5 s limit fails for load, not behaviour. */
vi.setConfig({ testTimeout: 30_000 });

describe("MS-OFFCRYPTO known answers (independent reference)", () => {
  it("derives the 2.3.4.11 iterated SHA-512 hash for spinCount 100000", async () => {
    const salt = Uint8Array.from({ length: 16 }, (_, i) => 100 + i);
    const spun = await spinHash("SHA-512", salt, passwordBytes("Password1234_"), 100_000);
    expect(bytesToHex(spun)).toBe(agileVector.spun);
  });

  it("decrypts the Agile AES-256 / SHA-512 vector across three segments", async () => {
    const plain = await decryptOfficeFile(container(agileVector), "Password1234_");
    expect(same(plain, plainOf(9000))).toBe(true);
  });

  it("decrypts the Agile AES-128 / SHA-1 vector with a non-ASCII password", async () => {
    const plain = await decryptOfficeFile(container(agileSha1Vector), "pässwörd");
    expect(same(plain, plainOf(5000))).toBe(true);
  });

  it("decrypts the Standard AES-128 ECB vector and marks it read-only", async () => {
    const file = container(standardVector);
    const protection = inspectOfficeProtection(file);
    expect(protection).toMatchObject({ kind: "password", scheme: "standard" });
    expect(protection.kind === "password" && protection.readOnlyReason).toMatch(/read-only/);
    expect(same(await decryptOfficeFile(file, "Password1234_"), plainOf(5000))).toBe(true);
    await expect(decryptOfficeFile(file, "wrong")).rejects.toBeInstanceOf(WrongPasswordError);
  });
});

describe("password and integrity", () => {
  it("reports a wrong password without throwing a damage error", async () => {
    await expect(decryptOfficeFile(container(agileSha1Vector), "pässword")).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it("refuses a package changed by one byte (HMAC)", async () => {
    const pkg = base64ToBytes(agileSha1Vector.package);
    pkg[100] ^= 1;
    const file = writeCfb([
      { path: "EncryptionInfo", bytes: base64ToBytes(agileSha1Vector.info) },
      { path: "EncryptedPackage", bytes: pkg },
    ]);
    await expect(decryptOfficeFile(file, "pässwörd")).rejects.toThrow(/integrity check/);
  });

  it("refuses a changed HMAC value", async () => {
    const xml = infoXml(agileSha1Vector);
    const value = /encryptedHmacValue="([^"]+)"/.exec(xml)![1];
    const bytes = base64ToBytes(value);
    bytes[0] ^= 0x80;
    const file = withInfoXml(agileSha1Vector, (x) => x.replace(value, btoa(String.fromCharCode(...bytes))));
    await expect(decryptOfficeFile(file, "pässwörd")).rejects.toThrow(/integrity check/);
  });
});

describe("inspection", () => {
  it("leaves ZIP packages and legacy compound files alone", () => {
    expect(inspectOfficeProtection(new Uint8Array([0x50, 0x4b, 3, 4]))).toEqual({ kind: "none" });
    expect(inspectOfficeProtection(writeCfb([{ path: "WordDocument", bytes: new Uint8Array(600) }]))).toEqual({ kind: "none" });
  });

  it("explains certificate-only, extensible, RC4 and out-of-range spin counts", () => {
    const certOnly = withInfoXml(agileSha1Vector, (x) => x.replace("keyEncryptor/password\">", "keyEncryptor/certificate\">"));
    expect(inspectOfficeProtection(certOnly)).toMatchObject({ kind: "unsupported", reason: expect.stringMatching(/certificate/) });
    const spin = withInfoXml(agileSha1Vector, (x) => x.replace('spinCount="1000"', 'spinCount="10000001"'));
    expect(inspectOfficeProtection(spin)).toMatchObject({ kind: "unsupported", reason: expect.stringMatching(/spinCount/) });
    const cipher = withInfoXml(agileSha1Vector, (x) => x.replace(/cipherAlgorithm="AES"/, 'cipherAlgorithm="3DES"'));
    expect(inspectOfficeProtection(cipher)).toMatchObject({ kind: "unsupported", reason: expect.stringMatching(/3DES/) });
    const info = base64ToBytes(standardVector.info);
    const rc4 = info.slice();
    new DataView(rc4.buffer).setUint32(4, 0x04, true);
    expect(parseEncryptionInfo(rc4)).toMatchObject({ kind: "unsupported", reason: expect.stringMatching(/RC4/) });
    const ext = info.slice();
    new DataView(ext.buffer).setUint16(2, 3, true);
    expect(parseEncryptionInfo(ext)).toMatchObject({ kind: "unsupported", reason: expect.stringMatching(/extensible/) });
  });

  it("leaves an unreadable compound file to the package layer, but refuses to decrypt it", async () => {
    const file = container(agileSha1Vector);
    new DataView(file.buffer).setUint32(48, 0x00ffffff, true);
    expect(inspectOfficeProtection(file).kind).toBe("none");
    await expect(decryptOfficeFile(file, "x")).rejects.toThrow(/damaged/);
  });
});

describe("re-encryption", () => {
  it("round-trips with fresh salts, the template's parameters and every other stream", async () => {
    const template = container(agileSha1Vector);
    const edited = plainOf(12_345).map((b) => b ^ 0x5a);
    const sealed = await encryptOfficeFile(template, edited, "pässwörd");
    expect(same(await decryptOfficeFile(sealed, "pässwörd"), edited)).toBe(true);
    const cfb = readCfb(sealed);
    expect(cfb.read(DATASPACE.path)).toEqual(DATASPACE.bytes);
    const before = parseEncryptionInfo(base64ToBytes(agileSha1Vector.info));
    const after = parseEncryptionInfo(cfb.read("EncryptionInfo")!);
    if (before.kind !== "agile" || after.kind !== "agile") throw new Error("expected agile");
    expect(after.password.spinCount).toBe(1000);
    expect(after.keyData.keyBits).toBe(128);
    expect(after.password.hash).toBe("SHA-1");
    expect(same(after.keyData.salt, before.keyData.salt)).toBe(false);
    expect(same(after.password.salt, before.password.salt)).toBe(false);
    const again = await encryptOfficeFile(template, edited, "pässwörd");
    expect(same(again, sealed)).toBe(false);
  });

  it("refuses to re-encrypt Standard or certificate files", async () => {
    await expect(encryptOfficeFile(container(standardVector), plainOf(10), "Password1234_")).rejects.toBeInstanceOf(OfficeCryptoError);
    const twoEncryptors = withInfoXml(agileSha1Vector, (x) => x.replace("</keyEncryptors>", '<keyEncryptor uri="http://schemas.microsoft.com/office/2006/keyEncryptor/certificate"/></keyEncryptors>'));
    expect(inspectOfficeProtection(twoEncryptors)).toMatchObject({ kind: "password", readOnlyReason: expect.stringMatching(/certificate/) });
    await expect(encryptOfficeFile(twoEncryptors, plainOf(10), "pässwörd")).rejects.toThrow(/certificate/);
  });

  it("encrypts an empty package", async () => {
    const sealed = await encryptOfficeFile(container(agileSha1Vector), new Uint8Array(0), "pässwörd");
    expect((await decryptOfficeFile(sealed, "pässwörd")).length).toBe(0);
  });
});
