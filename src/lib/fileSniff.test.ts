import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { detectFileType, isExtensionMismatch, sniffFileType } from "./fileSniff";

const text = (value: string) => new TextEncoder().encode(value);

describe("content type detection", () => {
  it("names a .pdf that is really a saved HTML page as a mislabel", () => {
    const detected = detectFileType(text("\n  <!DOCTYPE html><html><head><title>Access denied</title>"), "pdf");
    expect(detected.id).toBe("html");
    expect(detected.label).toBe("an HTML page");
    expect(isExtensionMismatch(detected, "pdf")).toBe(true);
    expect(isExtensionMismatch(detected, "html")).toBe(false);
  });

  it("flags plain text under a binary format's name but not under an unknown name", () => {
    const detected = detectFileType(text("just some notes\n"), "docx");
    expect(detected.family).toBe("text");
    expect(isExtensionMismatch(detected, "png")).toBe(true);
    expect(isExtensionMismatch(detected, "bin")).toBe(false);
    expect(isExtensionMismatch(detected, "nfo")).toBe(false);
  });

  it("does not call a password-protected .docx/.xlsx/.pptx mislabelled", () => {
    // Office stores password-protected OOXML inside a compound file; the
    // native app warned "Named .docx, but ... legacy Microsoft Office file".
    const cfb = detectFileType(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]));
    for (const ext of ["docx", "xlsx", "pptx", "docm", "xlsm", "pptm"]) expect(isExtensionMismatch(cfb, ext)).toBe(false);
    expect(isExtensionMismatch(cfb, "pdf")).toBe(true);
  });

  it("recognizes common binary signatures", () => {
    expect(detectFileType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).id).toBe("png");
    expect(detectFileType(text("SQLite format 3\0rest")).id).toBe("sqlite");
    expect(detectFileType(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])).id).toBe("cfb");
    expect(detectFileType(new Uint8Array([0, 0, 0, 0x18, ...text("ftypheic")])).id).toBe("heif");
    expect(detectFileType(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1])).id).toBe("elf");
  });

  it("does not mistake text or UTF-16 for binary formats", () => {
    expect(detectFileType(text("true\n")).family).toBe("text");
    expect(detectFileType(new Uint8Array([0xff, 0xfe, 0x68, 0x00])).id).toBe("utf16");
    expect(detectFileType(new Uint8Array([0x00, 0x01, 0x02, 0x9f])).id).toBe("unknown");
    expect(detectFileType(new Uint8Array()).family).toBe("empty");
  });

  it("identifies EPUB and Office packages from the first ZIP entry", () => {
    const epub = zipSync({ mimetype: text("application/epub+zip"), "META-INF/container.xml": text("<x/>") }, { level: 0 });
    expect(detectFileType(epub, "zip").family).toBe("epub");
    const docx = zipSync({ "[Content_Types].xml": text("<Types/>"), "word/document.xml": text("<w/>") });
    const detected = detectFileType(docx, "docx");
    expect(detected.family).toBe("zip");
    expect(detected.name).toMatch(/Word document/);
    expect(isExtensionMismatch(detected, "docx")).toBe(false);
    expect(isExtensionMismatch(detectFileType(zipSync({ "a.txt": text("a") })), "sketch")).toBe(false);
  });

  // Mesa opens these as Office files, but the details view called them
  // "may be mislabeled" because the sniff tables did not list them.
  it("accepts every Office package extension Mesa opens", () => {
    const office = detectFileType(zipSync({ "[Content_Types].xml": text("<Types/>"), "x.xml": text("<x/>") }));
    const plainZip = detectFileType(zipSync({ "a.txt": text("a") }));
    for (const ext of ["docx", "docm", "dotx", "dotm", "xlsx", "xlsm", "xltx", "xltm", "pptx", "pptm", "ppsx", "potx", "ott", "ots", "otp"]) {
      expect(isExtensionMismatch(plainZip, ext), ext).toBe(false);
      if (!/^o/.test(ext)) expect(isExtensionMismatch(office, ext), ext).toBe(false);
    }
  });

  it("keeps the short phrase PDF errors use", () => {
    expect(sniffFileType(text("<html><body>404"))).toBe("an HTML page");
    expect(sniffFileType(text("%PDF-1.7"))).toBe("a PDF");
  });
});
