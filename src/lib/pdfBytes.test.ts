import { describe, expect, it } from "vitest";
import pdfBytesSrc from "./pdfBytes.ts?raw";
import pdfThumbSrc from "./pdfThumb.ts?raw";
import pdfSrc from "./pdf.ts?raw";

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
});
