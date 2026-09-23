import { describe, expect, it } from "vitest";
import usePdfEditorSrc from "../components/usePdfEditor.ts?raw";
import perfScriptSrc from "../../scripts/pdf-perf-browser.mjs?raw";

/**
 * The PDF timeline is only as good as what reads it.
 *
 * `usePdfEditor.ts` records marks; `scripts/pdf-perf-browser.mjs` is the one
 * tracked harness that turns them into numbers. They drifted once already —
 * the worker-boot and page-1 split marks were added during an optimization
 * pass and the script kept summarizing the old seven, so the very marks the
 * conclusions rested on were absent from its `metrics`. This pins the pairing
 * rather than the individual names, so adding a mark forces the decision about
 * whether it is worth reporting instead of letting it be forgotten.
 */

/** Every literal handed to `markPdfPerf(run, "…")` in the viewer. */
function emittedMarks(source: string): string[] {
  return [...source.matchAll(/markPdfPerf\([^,]+,\s*"([a-z0-9-]+)"/g)].map((m) => m[1]);
}

/** Marks the harness reads, whether through `eventAt`, `has`, or `delta`. */
function consumedMarks(source: string): Set<string> {
  const names = new Set<string>();
  for (const m of source.matchAll(/(?:eventAt|has)\("([a-z0-9-]+)"\)/g)) names.add(m[1]);
  for (const m of source.matchAll(/delta\(run,\s*"([a-z0-9-]+)",\s*"([a-z0-9-]+)"\)/g)) {
    names.add(m[1]);
    names.add(m[2]);
  }
  return names;
}

describe("PDF perf timeline contract", () => {
  it("emits the marks the open-path analysis depends on", () => {
    const marks = new Set(emittedMarks(usePdfEditorSrc));
    for (const name of [
      "bytes-read-start",
      "bytes-read-end",
      "pdfjs-parse-start",
      "pdfjs-parse-end",
      "worker-boot-start",
      "worker-boot-ready",
      "worker-adopted-warm",
      "page-1-render-start",
      "page-1-ready",
      "page-1-raster-end",
      "blank-check-start",
      "blank-check-end",
      "first-meaningful-page",
    ]) {
      expect(marks, `usePdfEditor should record ${name}`).toContain(name);
    }
  });

  it("summarizes every mark the viewer records", () => {
    const consumed = consumedMarks(perfScriptSrc);
    const unread = [...new Set(emittedMarks(usePdfEditorSrc))].filter(
      (name) => !consumed.has(name)
    );
    // A mark that nothing reads is a measurement nobody sees. If a new one is
    // genuinely internal, either drop it or add it to the harness — do not
    // loosen this into an allowlist without a reason written down here.
    expect(unread, `marks recorded but never summarized: ${unread.join(", ")}`).toEqual(
      []
    );
  });

  it("keeps warm-adoption visible, so first-page numbers stay comparable", () => {
    // An open that adopted a pre-warmed worker and one that booted its own
    // differ by ~46-145 ms of pure boot. Medians taken across a mix of the two
    // describe nothing.
    expect(perfScriptSrc).toContain("workerAdoptedWarm");
    expect(perfScriptSrc).toContain('has("worker-adopted-warm")');
  });

  it("suppresses the first-run tour before it can cover the PDF fixture", () => {
    expect(perfScriptSrc).toContain("page.addInitScript");
    expect(perfScriptSrc).toContain(
      'localStorage.setItem("mesa:toured", "1")'
    );
  });
});
