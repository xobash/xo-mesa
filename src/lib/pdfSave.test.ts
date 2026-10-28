import { describe, expect, it, vi } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
const parse = vi.hoisted(() => ({ calls: 0 }));
vi.mock("./pdf", async (original) => {
  const actual = await original<typeof import("./pdf")>();
  return { ...actual, assertValidPdfBytes: async (bytes: Uint8Array) => { parse.calls++; await actual.assertValidPdfBytes(bytes); } };
});
import { assertValidPdfSnapshot, persistPdfBytes, type PdfSaveFs } from "./pdfSave";

async function makePdf(text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 24, y: 140, size: 18, font });
  return doc.save();
}

function makeFs(initial: Uint8Array): {
  fs: PdfSaveFs;
  files: Map<string, Uint8Array>;
} {
  const files = new Map<string, Uint8Array>([["/vault/test.pdf", initial.slice(0)]]);
  const fs: PdfSaveFs = {
    async readFile(path) {
      const found = files.get(path);
      if (!found) throw new Error(`Missing file: ${path}`);
      return found.slice(0);
    },
    async writeFile(path, data) {
      files.set(path, data.slice(0));
    },
    async remove(path) {
      files.delete(path);
    },
    async exists(path) {
      return files.has(path);
    },
  };
  return { fs, files };
}

describe("persistPdfBytes", () => {
  it("flushes the verified backup, candidate and committed PDF", async () => {
    const original = await makePdf("before");
    const next = await makePdf("after");
    const { fs, files } = makeFs(original);
    const flushed: string[] = [];
    await persistPdfBytes("/vault/test.pdf", next, {
      ...fs,
      async rename(from, to) {
        files.set(to, files.get(from)!);
        files.delete(from);
      },
      async flush(path) {
        expect(files.has(path)).toBe(true);
        flushed.push(path.includes(".mesa-backup-") ? "backup"
          : path.includes(".mesa-save-") ? "candidate" : "committed");
      },
    });
    expect(flushed).toEqual(["backup", "candidate", "committed"]);
    expect(files.get("/vault/test.pdf")).toEqual(next);
  });

  it("writes the target bytes and removes temp artifacts", async () => {
    const original = await makePdf("before");
    const next = await makePdf("after");
    const { fs, files } = makeFs(original);

    await persistPdfBytes("/vault/test.pdf", next, fs);

    expect(files.get("/vault/test.pdf")).toEqual(next);
    expect([...files.keys()]).toEqual(["/vault/test.pdf"]);
  });

  it("saves an edit to a PDF carrying trailing bytes after its %%EOF", async () => {
    // Real documents pick up debris after %%EOF (incremental-update leftovers,
    // a server footer, a scanner tag). pdf-lib parses and edits them happily,
    // so Mesa opens and edits them — the save must not then refuse because the
    // ORIGINAL fails Mesa's own format opinion. Validation belongs on the bytes
    // Mesa authored, not on the user's existing file.
    const clean = await makePdf("before");
    const trailing = new Uint8Array(clean.length + 5000);
    trailing.set(clean, 0);
    trailing.fill(0x20, clean.length);
    const edited = await makePdf("after");
    const { fs, files } = makeFs(trailing);

    await persistPdfBytes("/vault/test.pdf", edited, fs, {
      expectedCurrentBytes: trailing,
    });

    expect(files.get("/vault/test.pdf")).toEqual(edited);
    expect([...files.keys()]).toEqual(["/vault/test.pdf"]);
  });

  it("still rejects candidate bytes that are not a valid PDF", async () => {
    const original = await makePdf("before");
    const { fs, files } = makeFs(original);

    await expect(
      persistPdfBytes("/vault/test.pdf", new Uint8Array([1, 2, 3]), fs)
    ).rejects.toThrow(/verification failed/i);
    // The original is untouched and no debris is left behind.
    expect(files.get("/vault/test.pdf")).toEqual(original);
    expect([...files.keys()]).toEqual(["/vault/test.pdf"]);
  });

  it("enforces the caller's expected on-disk PDF bytes inside the transaction", async () => {
    const opened = await makePdf("opened");
    const external = await makePdf("external");
    const edited = await makePdf("edited");
    const { fs, files } = makeFs(external);

    await expect(
      persistPdfBytes("/vault/test.pdf", edited, fs, {
        expectedCurrentBytes: opened,
      })
    ).rejects.toThrow(/changed before the verified write/i);

    expect(files.get("/vault/test.pdf")).toEqual(external);
    expect([...files.keys()]).toEqual(["/vault/test.pdf"]);
  });

  it("restores the original bytes when the final write is truncated", async () => {
    const original = await makePdf("before");
    const next = await makePdf("after");
    const { files } = makeFs(original);
    let targetWrites = 0;
    const fs: PdfSaveFs = {
      async readFile(path) {
        const found = files.get(path);
        if (!found) throw new Error(`Missing file: ${path}`);
        return found.slice(0);
      },
      async writeFile(path, data) {
        if (path === "/vault/test.pdf") {
          targetWrites++;
          if (targetWrites === 1) {
            files.set(path, new Uint8Array());
            return;
          }
        }
        files.set(path, data.slice(0));
      },
      async remove(path) {
        files.delete(path);
      },
      async exists(path) {
        return files.has(path);
      },
    };

    await expect(persistPdfBytes("/vault/test.pdf", next, fs)).rejects.toThrow(
      "Final PDF write verification failed."
    );
    expect(files.get("/vault/test.pdf")).toEqual(original);
    expect([...files.keys()]).toEqual(["/vault/test.pdf"]);
  });

  it("removes a newly-created PDF when final verification fails", async () => {
    const next = await makePdf("after");
    const files = new Map<string, Uint8Array>();
    const fs: PdfSaveFs = {
      async readFile(path) {
        const found = files.get(path);
        if (!found) throw new Error(`Missing file: ${path}`);
        return found.slice(0);
      },
      async writeFile(path, data) {
        if (path === "/vault/test.pdf") {
          files.set(path, new Uint8Array());
          return;
        }
        files.set(path, data.slice(0));
      },
      async remove(path) {
        files.delete(path);
      },
      async exists(path) {
        return files.has(path);
      },
    };

    await expect(persistPdfBytes("/vault/test.pdf", next, fs)).rejects.toThrow(
      "Final PDF write verification failed."
    );
    expect(files.has("/vault/test.pdf")).toBe(false);
  });
});

describe("validated save snapshots", () => {
  it("parses a validated snapshot once on the native atomic path", async () => {
    const original = await makePdf("before");
    const next = await makePdf("after");
    const { fs } = makeFs(original);
    const atomicWrite = vi.fn(async () => {});
    parse.calls = 0;
    await assertValidPdfSnapshot(next);
    await persistPdfBytes("/vault/test.pdf", next, { ...fs, atomicWrite }, { expectedCurrentBytes: original });
    expect(parse.calls).toBe(1);
    expect(atomicWrite).toHaveBeenCalledWith("/vault/test.pdf", next, original);
  });

  it("keeps the specific pre-check error and still rejects unvalidated bytes", async () => {
    const { fs } = makeFs(await makePdf("before"));
    const truncated = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n");
    const atomicWrite = vi.fn(async () => {});
    await expect(assertValidPdfSnapshot(truncated)).rejects.toThrow(/%%EOF/);
    await expect(persistPdfBytes("/vault/test.pdf", truncated, { ...fs, atomicWrite }))
      .rejects.toThrow("Temporary PDF write verification failed.");
    expect(atomicWrite).not.toHaveBeenCalled();
  });

  it("still parses every disk read-back on the compatibility path", async () => {
    const next = await makePdf("after");
    const { fs, files } = makeFs(await makePdf("before"));
    await assertValidPdfSnapshot(next);
    parse.calls = 0;
    await persistPdfBytes("/vault/test.pdf", next, {
      ...fs,
      async rename(from, to) { files.set(to, files.get(from)!); files.delete(from); },
    });
    expect(parse.calls).toBeGreaterThan(0);
    expect(files.get("/vault/test.pdf")).toEqual(next);
  });
});
