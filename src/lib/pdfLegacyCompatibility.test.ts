import { describe, expect, it } from "vitest";
import editor from "../components/usePdfEditor.ts?raw";
import thumb from "./pdfThumb.ts?raw";

describe("PDF.js supported-webview compatibility", () => {
  it("uses one matching legacy display and worker distribution", () => {
    const legacyDisplay = "pdfjs-dist/legacy/build/pdf.mjs";
    const legacyWorker = "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

    expect(editor).toContain(legacyDisplay);
    expect(editor).toContain(legacyWorker);
    expect(thumb).toContain(legacyDisplay);
    expect(thumb).toContain(legacyWorker);
    expect(editor).not.toContain('from "pdfjs-dist";');
    expect(thumb).not.toContain('import("pdfjs-dist")');
  });
});
