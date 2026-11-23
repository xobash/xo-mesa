import { describe, expect, it } from "vitest";
import { writeCfb } from "./cfb";
import { LEGACY_ENCRYPTED_REASON, legacyEncryptionReason, OOXML_IN_CFB_REASON } from "./legacyOfficeEncryption";

function fib(flags: number): Uint8Array {
  const out = new Uint8Array(600);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0xa5ec, true);
  view.setUint16(10, flags, true);
  return out;
}

function workbook(...records: Array<[number, number]>): Uint8Array {
  const out = new Uint8Array(records.reduce((n, [, len]) => n + 4 + len, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const [type, len] of records) { view.setUint16(at, type, true); view.setUint16(at + 2, len, true); at += 4 + len; }
  return out;
}

describe("legacy Office encryption detection", () => {
  it("names RC4-protected Word, Excel and PowerPoint files", () => {
    expect(legacyEncryptionReason(writeCfb([{ path: "WordDocument", bytes: fib(0x0100) }]))).toBe(LEGACY_ENCRYPTED_REASON);
    expect(legacyEncryptionReason(writeCfb([{ path: "Workbook", bytes: workbook([0x0809, 16], [0x002f, 54], [0x000a, 0]) }]))).toBe(LEGACY_ENCRYPTED_REASON);
    expect(legacyEncryptionReason(writeCfb([{ path: "PowerPoint Document", bytes: new Uint8Array(10) }, { path: "EncryptedSummary", bytes: new Uint8Array(10) }]))).toBe(LEGACY_ENCRYPTED_REASON);
  });

  it("says nothing for unprotected files and points misnamed OOXML to its extension", () => {
    expect(legacyEncryptionReason(writeCfb([{ path: "WordDocument", bytes: fib(0x0200) }]))).toBeNull();
    expect(legacyEncryptionReason(writeCfb([{ path: "Workbook", bytes: workbook([0x0809, 16], [0x000a, 0], [0x002f, 54]) }]))).toBeNull();
    expect(legacyEncryptionReason(writeCfb([{ path: "EncryptionInfo", bytes: new Uint8Array(8) }, { path: "EncryptedPackage", bytes: new Uint8Array(8) }]))).toBe(OOXML_IN_CFB_REASON);
    expect(legacyEncryptionReason(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBeNull();
    // Under its own extension an encrypted .docx is opened with its password;
    // telling the user to rename it was wrong.
    const encryptedOoxml = writeCfb([{ path: "EncryptionInfo", bytes: new Uint8Array(8) }, { path: "EncryptedPackage", bytes: new Uint8Array(8) }]);
    expect(legacyEncryptionReason(encryptedOoxml, "docx")).toBeNull();
    expect(legacyEncryptionReason(encryptedOoxml, "doc")).toBe(OOXML_IN_CFB_REASON);
  });

  it("stops on a hostile record length instead of reading past the stream", () => {
    expect(legacyEncryptionReason(writeCfb([{ path: "Workbook", bytes: workbook([0x0809, 0xffff]) }]))).toBeNull();
  });
});
