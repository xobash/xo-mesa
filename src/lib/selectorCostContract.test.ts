import { describe, expect, it } from "vitest";
// A Zustand selector runs on EVERY store `set()`, and `setContentFromEditor`
// calls `set()` once per keystroke. Anything a selector derives from a whole
// collection is therefore paid per character by every mounted component:
// `files.find(...)` measured 16.6 us per call at 4,165 files (0.03 us through
// the store's identity-keyed index), and `Object.keys(notes).length` measured
// 63 us plus a 2,400-entry throwaway array. Both have exact O(1)/memoized
// equivalents, so the linear forms are pinned out of the live surfaces here.
import app from "../App.tsx?raw";
import preview from "../components/Preview.tsx?raw";
import pdfView from "../components/PdfView.tsx?raw";
import previewTriggers from "../components/previewTriggers.ts?raw";
import statusBar from "../components/StatusBar.tsx?raw";
import deepResearchPanel from "../components/DeepResearchPanel.tsx?raw";
import fileTree from "../components/FileTree.tsx?raw";

const SOURCES: [string, string][] = [
  ["App.tsx", app],
  ["Preview.tsx", preview],
  ["PdfView.tsx", pdfView],
  ["previewTriggers.ts", previewTriggers],
  ["StatusBar.tsx", statusBar],
  ["DeepResearchPanel.tsx", deepResearchPanel],
];

describe("path lookups go through the store index, not a linear scan", () => {
  it.each(SOURCES)("%s never scans `files` for a relPath", (_name, source) => {
    // Matches `files.find((f) => f.relPath === …)` in any receiver spelling
    // (`files`, `s.files`, `store.files`) and with any parameter name.
    expect(source).not.toMatch(
      /files\s*\.find\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\1\.relPath\s*===/
    );
  });

  it("the per-keystroke viewer surfaces resolve through fileFor", () => {
    expect(preview).toContain("s.fileFor(activePath)");
    expect(pdfView).toContain("s.fileFor(rel)?.mtime");
    expect(previewTriggers).toContain("store.fileFor(target.id)");
    expect(app).toContain("s.fileFor(s.activePath)");
  });
});

describe("whole-collection derivations are memoized, not computed in a selector", () => {
  it.each([
    ["StatusBar.tsx", statusBar],
    ["DeepResearchPanel.tsx", deepResearchPanel],
  ])("%s does not count notes inside a selector", (_name, source) => {
    // `useAppStore((s) => Object.keys(s.notes).length)` — the array is rebuilt
    // on every set() purely to read its length.
    expect(source).not.toMatch(/useAppStore\(\s*\(\s*\w+\s*\)\s*=>\s*Object\.keys\(/);
    expect(source).toContain("useMemo(() => Object.keys(notes).length, [notes])");
  });
});

describe("sidebar sort uses the shared natural-name comparator", () => {
  it("does not re-resolve numeric localeCompare options in FileTree", () => {
    expect(fileTree).toContain("compareNames(a.name, b.name)");
    expect(fileTree).not.toContain("localeCompare(b.name, undefined, { numeric: true })");
  });
});
