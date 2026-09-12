import { describe, expect, it } from "vitest";
import pdfBytesSrc from "./pdfBytes.ts?raw";
import pdfThumbSrc from "./pdfThumb.ts?raw";
import pdfThumbInvalidationSrc from "./pdfThumbInvalidation.ts?raw";
import pdfSrc from "./pdf.ts?raw";
import pdfSaveSrc from "./pdfSave.ts?raw";
import pdfRenderPlanSrc from "./pdfRenderPlan.ts?raw";
import usePdfEditorSrc from "../components/usePdfEditor.ts?raw";
import pdfViewSrc from "../components/PdfView.tsx?raw";
import documentViewSrc from "../components/DocumentView.tsx?raw";
import previewCardSrc from "../components/PreviewCard.tsx?raw";
import previewTriggersSrc from "../components/previewTriggers.ts?raw";
import storeSrc from "../store.ts?raw";
import viteConfigSrc from "../../vite.config.ts?raw";

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

function staticRuntimeImports(source: string): string[] {
  const specs: string[] = [];
  const re = /(?:^|\n)\s*import\s+(?!type\b)[^;]*?from\s*["']([^"']+)["']/g;
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

  it("keeps thumbnail invalidation startup-safe for store.ts", () => {
    expect(staticImports(pdfThumbInvalidationSrc)).toEqual([]);
    expect(storeSrc).toContain('from "./lib/pdfThumbInvalidation"');
    expect(storeSrc).not.toContain('from "./lib/pdfThumb"');
  });

  it("loads PDF thumbnail rendering only for PDF previews", () => {
    expect(staticRuntimeImports(previewCardSrc)).not.toContain("./PdfThumb");
    expect(staticRuntimeImports(previewTriggersSrc)).not.toContain("../lib/pdfThumb");
    expect(previewCardSrc).toContain('import("./PdfThumb")');
    expect(previewTriggersSrc).toContain('import("../lib/pdfThumb")');
    expect(viteConfigSrc).toContain("onlyExplicitManualChunks: true");
  });

  it("pdf.ts re-exports the byte helpers so `from \"./pdf\"` imports keep working", () => {
    for (const name of [
      "findPdfHeader",
      "sniffFileType",
      "sanitizePdfBytes",
      "isNotAPdf",
      "markNotAPdf",
      "hasPdfEofMarker",
      "copyPdfBytes",
      "pdfBytesEqual",
      "isLikelyBlankPdfPaint",
    ]) {
      expect(pdfSrc, `pdf.ts should re-export ${name}`).toContain(name);
    }
    expect(staticImports(pdfSrc)).toContain("./pdfBytes");
  });

  it("keeps pdf-lib editing code out of the read-only PDF open path", () => {
    // A read-only PDF open should load pdf.js and the dependency-free byte
    // helpers. The pdf-lib editing module is still available through dynamic
    // import when the user edits, fills a form, saves, or validates edit bytes.
    expect(staticRuntimeImports(pdfViewSrc)).toContain("../lib/pdfBytes");
    expect(staticRuntimeImports(usePdfEditorSrc)).toContain("../lib/pdfBytes");
    expect(staticRuntimeImports(pdfViewSrc)).not.toContain("../lib/pdf");
    expect(staticRuntimeImports(usePdfEditorSrc)).not.toContain("../lib/pdf");
    expect(staticRuntimeImports(pdfSaveSrc)).not.toContain("./pdf");
    expect(pdfViewSrc).toContain('import("../lib/pdf")');
    expect(usePdfEditorSrc).toContain('import("../lib/pdf")');
    expect(pdfSaveSrc).toContain('import("./pdf")');
  });

  it("defines the not-a-PDF tag exactly once, in pdfBytes.ts", () => {
    // Both PDF surfaces keep a pdf.js worker warm across documents and destroy
    // it when a document wedges it. "Mesa rejected these bytes itself" must not
    // count as wedging — that cost the next real open a full worker boot on the
    // 54% of a real vault's `.pdf` files that are not PDFs. The rule is one
    // sentence, so it gets one definition; a second copy is how the viewer and
    // the thumbnail path drift apart.
    expect(pdfBytesSrc).toContain('const NOT_A_PDF = "__mesaNotAPdf"');
    for (const [name, src] of [
      ["pdfThumb.ts", pdfThumbSrc],
      ["usePdfEditor.ts", usePdfEditorSrc],
      ["PdfView.tsx", pdfViewSrc],
    ] as const) {
      expect(src, `${name} must not redefine the tag`).not.toContain("__mesaNotAPdf");
    }
    // …and the callers read it rather than tagging anything themselves.
    expect(pdfThumbSrc).toContain("isNotAPdf");
    expect(usePdfEditorSrc).toContain("isNotAPdf");
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
    expect(usePdfEditorSrc.indexOf('document.createElement("canvas")')).toBeGreaterThan(
      usePdfEditorSrc.indexOf("if (!pageNumbers.length)")
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
    expect(usePdfEditorSrc).toContain("const pageNumbers = pdfPagesToRender(");
    expect(pdfRenderPlanSrc).toContain("return mountedPageNumbers.filter(");
    expect(pdfRenderPlanSrc).not.toContain("Array.from({ length: pageCount }");
  });

  it("does not cancel and restart the initial page-one raster", () => {
    // The document-change effect already sees refs committed in the same
    // render. Initial canvas/observer publications therefore must not schedule
    // competing passes before firstPagePainted retires the native warm start.
    expect(pdfViewSrc).toContain(
      "if (!firstPagePainted || !scroller || !inner || shellCount === 0) return;"
    );
    expect(usePdfEditorSrc).toContain(
      "if (currentDoc && lastRenderedDocRef.current === currentDoc)"
    );
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
    expect(pdfRenderPlanSrc).toContain(
      "paintedPages.get(pageNumber - 1) !== renderScale"
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

  it("reuses immutable save snapshots instead of copying whole PDFs twice", () => {
    const savePath = usePdfEditorSrc.slice(
      usePdfEditorSrc.indexOf("const save = async"),
      usePdfEditorSrc.indexOf("const reset = async")
    );
    expect(savePath).toContain("const snapshot = copyPdfBytes(current)");
    expect(savePath).toContain("const expectedCurrentBytes = baseline");
    expect(savePath).toContain("savedBytesRef.current = snapshot");
    expect(savePath).not.toContain("copyPdfBytes(baseline)");
    expect(savePath).not.toContain("copyPdfBytes(snapshot)");
  });

  it("keeps stable hooks for the living browser PDF workflow", () => {
    expect(pdfViewSrc).toContain('data-testid="pdf-editor"');
    expect(pdfViewSrc).toContain('data-testid="pdf-pages"');
    expect(pdfViewSrc).toContain('data-testid="pdf-page-canvas"');
    expect(pdfViewSrc).toContain('data-page-number={i + 1}');
  });

  it("keeps PDF zoom compositor-first and re-anchors after raster resize", () => {
    // Pinch samples stay out of React until the gesture settles. The preview
    // is written once per animation frame, then pdf.js repaints at the final
    // scale and the anchor is corrected against the real canvas geometry.
    expect(pdfViewSrc).toContain("if (clamped === scaleRef.current) return;");
    expect(pdfViewSrc).toContain("requestAnimationFrame(flushZoomPreview)");
    expect(pdfViewSrc).toContain('innerEl.style.setProperty("--pdf-zoom"');
    expect(pdfViewSrc).toContain('source: "button" | "pinch"');
    expect(pdfViewSrc).toContain("const factor = Math.exp(-normalizedDelta * 0.003)");
    expect(pdfViewSrc).toContain('setScale(scaleRef.current)');
    expect(pdfViewSrc).toContain("correctZoomAnchor(true)");
    expect(pdfViewSrc).not.toContain('style={{ "--pdf-zoom"');
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
