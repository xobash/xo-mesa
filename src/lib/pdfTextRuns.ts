/** Group document-wide PDF text runs by zero-based page, preserving run order. */
export function groupPdfTextRunsByPage<T extends { page: number }>(
  runs: readonly T[]
): Map<number, T[]> {
  const byPage = new Map<number, T[]>();
  for (const run of runs) {
    const pageRuns = byPage.get(run.page);
    if (pageRuns) pageRuns.push(run);
    else byPage.set(run.page, [run]);
  }
  return byPage;
}

/**
 * One extracted text run in ZOOM-INDEPENDENT form.
 *
 * Store pdf.js text geometry at scale 1 so zooming only re-runs the
 * arithmetic in `projectPdfTextRun`.
 */
export interface PdfTextRunSource {
  page: number;
  /** Untrimmed original string, as shown in the edit affordance. */
  text: string;
  /** Screen-space position at scale 1 (viewport transform already applied). */
  unitLeft: number;
  unitTop: number;
  /** Glyph-run height at scale 1; 0 when the transform is degenerate. */
  unitHeight: number;
  /** pdf.js's own reported extents, absent for some producers. */
  rawWidth?: number;
  rawHeight?: number;
  /** Width estimate used when pdf.js reports none. */
  fallbackWidth: number;
  /** PDF user-space origin of the run (bottom-left, zoom-independent). */
  pdfX: number;
  pdfYBase: number;
}

/** One text run projected into the screen space of a given render scale. */
export interface PdfTextRun {
  page: number;
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  pdfX: number;
  pdfY: number;
  pdfWidth: number;
  pdfHeight: number;
}

/** Project scale-1 geometry and apply minimum-size clamps after scaling. */
export function projectPdfTextRun(
  src: PdfTextRunSource,
  scale: number
): PdfTextRun {
  const height =
    src.unitHeight * scale || Math.max(8, (src.rawHeight ?? 10) * scale);
  const width = Math.max(8, (src.rawWidth ?? src.fallbackWidth) * scale);
  const pdfHeight = Math.max(6, src.rawHeight ?? height / scale);
  const pdfWidth = Math.max(6, src.rawWidth ?? width / scale);
  return {
    page: src.page,
    text: src.text,
    left: src.unitLeft * scale,
    top: src.unitTop * scale - height,
    width,
    height,
    pdfX: src.pdfX,
    pdfY: src.pdfYBase - pdfHeight * 0.22,
    pdfWidth,
    pdfHeight: pdfHeight * 1.15,
  };
}

export function projectPdfTextRuns(
  sources: readonly PdfTextRunSource[],
  scale: number
): PdfTextRun[] {
  return sources.map((src) => projectPdfTextRun(src, scale));
}

/** Replace changed-page runs in page order; structural changes require full re-extraction. */
export function mergePdfTextRunSources(
  previous: readonly PdfTextRunSource[],
  replacements: readonly PdfTextRunSource[],
  pages: ReadonlySet<number>
): PdfTextRunSource[] {
  const byPage = new Map<number, PdfTextRunSource[]>();
  for (const run of previous) {
    if (pages.has(run.page)) continue;
    const existing = byPage.get(run.page);
    if (existing) existing.push(run);
    else byPage.set(run.page, [run]);
  }
  for (const run of replacements) {
    if (!pages.has(run.page)) continue;
    const existing = byPage.get(run.page);
    if (existing) existing.push(run);
    else byPage.set(run.page, [run]);
  }
  const out: PdfTextRunSource[] = [];
  for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
    out.push(...byPage.get(page)!);
  }
  return out;
}
