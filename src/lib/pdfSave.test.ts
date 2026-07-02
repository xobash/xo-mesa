import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { persistPdfBytes, type PdfSaveFs } from "./pdfSave";

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
  it("writes the target bytes and removes temp artifacts", async () => {
    const original = await makePdf("before");
    const next = await makePdf("after");
    const { fs, files } = makeFs(original);

    await persistPdfBytes("/vault/test.pdf", next, fs);

    expect(files.get("/vault/test.pdf")).toEqual(next);
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
