import { describe, expect, it } from "vitest";
import pdfBytesSrc from "./pdfBytes.ts?raw";
import pdfThumbSrc from "./pdfThumb.ts?raw";
import pdfSrc from "./pdf.ts?raw";
import usePdfEditorSrc from "../components/usePdfEditor.ts?raw";
import pdfViewSrc from "../components/PdfView.tsx?raw";
import documentViewSrc from "../components/DocumentView.tsx?raw";

/**
 * Bundle-layering contract for the PDF modules.
 *
 * `pdfThumb.ts` is statically reachable from the main bundle (hover previews
 * via `PreviewCard`), so nothing it statically imports may pull in pdf-lib —
 * that's what keeps ~450 kB of PDF editing code inside the lazy `PdfView`
 * chunk instead of the startup bundle. These assertions read the source the
 * same way the launcher/install contract tests do.
 */

/** Static imports only: `from "x"` — dynamic `import("x")` is fine. */
function staticImports(source: string): string[] {
  const specs: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)[^;]*?from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) specs.push(m[1]);
  return specs;
}

describe("pdf module layering", () => {
  it("pdfBytes.ts stays dependency-free (no static imports at all)", () => {
    expect(staticImports(pdfBytesSrc)).toEqual([]);
  });

  it("pdfThumb.ts never statically imports pdf.ts or pdf-lib", () => {
    const specs = staticImports(pdfThumbSrc);
    expect(specs).not.toContain("./pdf");
    expect(specs).not.toContain("pdf-lib");
  });

  it("pdf.ts re-exports the byte helpers so `from \"./pdf\"` imports keep working", () => {
    for (const name of [
      "findPdfHeader",
      "sniffFileType",
      "sanitizePdfBytes",
      "hasPdfEofMarker",
      "copyPdfBytes",
      "pdfBytesEqual",
      "isLikelyBlankPdfPaint",
    ]) {
      expect(pdfSrc, `pdf.ts should re-export ${name}`).toContain(name);
    }
    expect(staticImports(pdfSrc)).toContain("./pdfBytes");
  });

  it("bounds PDF rerender scratch memory to one effect-local canvas", () => {
    expect(usePdfEditorSrc).toContain(
      'const renderCanvas = document.createElement("canvas")'
    );
    expect(usePdfEditorSrc).not.toContain(
      "renderCanvasRefs.current.set"
    );
    expect(usePdfEditorSrc).not.toMatch(
      /Map<number,\s*HTMLCanvasElement>\(new Map\(\)\).*renderCanvas/i
    );
  });

  it("tracks all painted pages without publishing React state per page", () => {
    // Painted pixels are credited per page, keyed by the scale they were drawn
    // at, and only after they reach the visible canvas.
    expect(usePdfEditorSrc).toContain(
      "paintedPagesRef.current.set(i - 1, renderScale)"
    );
    expect(usePdfEditorSrc).toContain("setFirstPagePainted(true)");
    expect(usePdfEditorSrc).toContain('markPdfPerf(pdfPerfRunRef.current, "first-meaningful-page")');
    expect(usePdfEditorSrc).not.toContain("setRenderedPages((prev)");
    expect(usePdfEditorSrc).not.toContain("setPaintedPages((prev)");
  });

  it("keeps first-page PDF paint off the all-pages mount path", () => {
    expect(pdfViewSrc).toContain("const [mountedPageCount, setMountedPageCount]");
    // Page 1's shell is admitted in the same commit that learns the page count
    // (render-phase reset keyed by path), never one commit later.
    expect(pdfViewSrc).toContain("if (mountedForPath !== (file?.path ?? null))");
    expect(pdfViewSrc).toContain(
      "pageCount > 0 ? Math.min(pageCount, Math.max(mountedPageCount, 1)) : 0"
    );
    expect(pdfViewSrc).toContain("Array.from({ length: shellCount }");
    expect(usePdfEditorSrc).toContain(
      "const mountedPageNumbers = Array.from(canvasRefs.current.keys())"
    );
    expect(usePdfEditorSrc).toContain("const targetPageNumbers =");
    expect(usePdfEditorSrc).toContain("targetPageNumbers.filter(");
  });

  it("refuses pointer mapping through a canvas whose pixels were released", () => {
    // The viewport a page was last painted with outlives the release of its
    // bitmap. Scaling a click by a zero-width canvas maps every point onto the
    // page origin, so an annotation would land in the corner.
    expect(pdfViewSrc).toContain("if (canvas.width <= 0 || canvas.height <= 0) return null;");
  });

  it("keeps the render pass idempotent so mounting pages cannot restart it", () => {
    // Both halves of the invariant: a page already holding this scale's pixels
    // is skipped, and anything that invalidates those pixels drops the credit.
    expect(usePdfEditorSrc).toContain(
      "paintedPagesRef.current.get(pageNumber - 1) !== renderScale"
    );
    expect(usePdfEditorSrc).toContain("for (const page of next) paintedPagesRef.current.delete(page)");
    expect(usePdfEditorSrc).toContain("paintedPagesRef.current.delete(pageIdx)");
  });

  it("does not stand up a second PDF stack before Mesa's own first page", () => {
    // The native read-only renderer is a SECOND full PDF stack over the same
    // file: the OS renderer maps the document again, alongside Mesa's copy and
    // the pdf.js worker's. It covers a slow open, so it must stay — but it must
    // not be started for opens that land in tens of milliseconds.
    expect(pdfViewSrc).toContain("const NATIVE_WARM_START_DELAY_MS");
    expect(pdfViewSrc).toContain(
      "!loadFailed && !renderError && !firstPagePainted && warmStartDue"
    );
  });

  it("adopts the freshly read PDF buffer rather than snapshotting it", () => {
    expect(usePdfEditorSrc).toContain("const adoptSavedBytes = useCallback");
    expect(usePdfEditorSrc).not.toContain("const setSavedBytes = useCallback");
  });

  it("keeps stable hooks for the living browser PDF workflow", () => {
    expect(pdfViewSrc).toContain('data-testid="pdf-editor"');
    expect(pdfViewSrc).toContain('data-testid="pdf-pages"');
    expect(pdfViewSrc).toContain('data-testid="pdf-page-canvas"');
    expect(pdfViewSrc).toContain('data-page-number={i + 1}');
  });

  it("keeps standalone PDF windows on the same lazy PdfView pipeline", () => {
    expect(documentViewSrc).toContain('import("./PdfView")');
    expect(documentViewSrc).toContain(
      "<LazyPdfView rel={rel} file={selectedFile} />"
    );
    expect(documentViewSrc).not.toContain('<iframe className="doc-pdf"');
    expect(pdfViewSrc).toContain("file?: VaultFile");
  });
});
