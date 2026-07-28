/**
 * Reproduction of the reported PDF corruption, and the guarantee that fixes it.
 *
 * `agent.test.ts` unit-tests the block decision and `harnessContract.test.ts`
 * proves the shipped Pi extension mirrors it exactly. Neither shows *why* the
 * block has to exist. This file does, on real PDF bytes: it reproduces the
 * corruption end to end and then asserts the decision that prevents it.
 *
 * Deliberately written against web-standard APIs only (`Uint8Array`,
 * `TextDecoder`/`TextEncoder`) rather than Node's `Buffer`/`fs`: Mesa's
 * tsconfig covers `src` with DOM libs and no `@types/node`, and the Pi
 * extensions in `src-tauri/resources` are Node code that lives outside that
 * boundary on purpose. Keeping this test inside the boundary means it is
 * typechecked like the rest of the app.
 */
import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { piBinaryWriteBlock } from "./agent";
import { hasPdfEofMarker, sanitizePdfBytes } from "./pdfBytes";

/** A realistic PDF: real files carry compressed streams and embedded font
 *  programs, and that is where the non-UTF-8 bytes live. A text-only PDF with
 *  no embedded resources survives a round-trip nearly intact and would not
 *  reproduce this at all. */
async function makeRealisticPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([300, 200]).drawText("Mesa corruption regression fixture", {
    font,
    size: 14,
  });
  return doc.save();
}

/** Exactly what a text-oriented `write`/`edit` tool does to a file: decode the
 *  bytes to a string, hand that to the model, encode the result back. */
function textToolRoundTrip(bytes: Uint8Array): {
  text: string;
  bytes: Uint8Array;
} {
  const text = new TextDecoder().decode(bytes);
  return { text, bytes: new TextEncoder().encode(text) };
}

describe("Pi writing a PDF (the reported corruption)", () => {
  it("reproduces it: a text round-trip destroys a real PDF", async () => {
    const original = await makeRealisticPdf();
    const roundTripped = textToolRoundTrip(original);

    // Every byte sequence that isn't valid UTF-8 decodes to U+FFFD and can
    // never be encoded back to what it was. No malice, no bug in the tool —
    // the encode step alone is lossy and irreversible.
    const destroyed = (roundTripped.text.match(/�/g) ?? []).length;
    expect(destroyed).toBeGreaterThan(100);

    // Each destroyed sequence becomes a 3-byte U+FFFD, so the file grows even
    // though nothing was added: a size change with no edit.
    expect(roundTripped.bytes).not.toEqual(original);
    expect(roundTripped.bytes.length).toBeGreaterThan(original.length);

    // The original parses cleanly; the round-tripped bytes carry objects that
    // no longer parse. Asserted strictly on purpose — pdf-lib's default lenient
    // mode often *appears* to recover such a file, which is exactly why this
    // corruption goes unnoticed until something needs the damaged object.
    await expect(
      PDFDocument.load(original, { throwOnInvalidObject: true })
    ).resolves.toBeDefined();
    await expect(
      PDFDocument.load(roundTripped.bytes, { throwOnInvalidObject: true })
    ).rejects.toThrow();
  });

  it("is undetectable downstream — the wreckage still looks like a PDF", async () => {
    const roundTripped = textToolRoundTrip(await makeRealisticPdf()).bytes;
    // Both of Mesa's cheap structural checks pass on the corrupted bytes, so
    // nothing after the write can be relied on to notice. Refusing the write is
    // the only place this is catchable.
    expect(() => sanitizePdfBytes(roundTripped)).not.toThrow();
    expect(hasPdfEofMarker(roundTripped)).toBe(true);
  });

  it("never happens now: every content-write tool is refused on a PDF", () => {
    for (const tool of ["write", "edit", "apply_patch"]) {
      expect(piBinaryWriteBlock(tool, "/vault/report.pdf")?.block, tool).toBe(true);
    }
  });

  it("leaves the rest of the agent workflow intact", () => {
    // Reading a PDF is fine, and bash still reaches it so the agent can use a
    // real format-aware tool.
    expect(piBinaryWriteBlock("read", "/vault/report.pdf")).toBeNull();
    expect(piBinaryWriteBlock("bash", "/vault/report.pdf")).toBeNull();
    // Writing notes — the intended workflow — is untouched.
    for (const path of ["note.md", "data.json", "Notes/deep/nested.md", "styles.css"]) {
      expect(piBinaryWriteBlock("write", path), path).toBeNull();
    }
  });
});
