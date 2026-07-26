import { describe, expect, it } from "vitest";
// The markdown RENDERING stack (markdown-it + dompurify and their transitive
// entities/linkify-it/uc.micro/mdurl/punycode deps, ~120 kB minified — ~20% of
// the entry chunk) is deliberately kept OUT of the startup bundle. Two halves
// make that work, and both are pinned here:
//
//   1. `markdownExtract.ts` holds the scan-time metadata extraction
//      (links/tags/aliases/frontmatter/first image). It is plain regex with NO
//      dependencies, so store.ts + graph.ts + deepResearch.ts can read every
//      note in the vault without dragging in the renderer.
//   2. Only `components/MarkdownView.tsx` reaches `lib/markdown.ts`, and it
//      does so with a dynamic import, so the renderer resolves as its own
//      chunk off the first-paint critical path.
//
// Same stance as the CodeMirror split (editorLoadContract.test.ts), the
// pdf-lib split in pdfBytes.ts, and the xterm split.
import markdownExtract from "./markdownExtract.ts?raw";
import markdownView from "../components/MarkdownView.tsx?raw";

const allSources = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("markdown renderer lazy-load contract", () => {
  it("the extraction module pulls in no dependencies at all", () => {
    const imports = markdownExtract
      .split("\n")
      .filter((l) => /^\s*import\s/.test(l));
    expect(imports).toEqual([]);
  });

  it("MarkdownView does not statically import the renderer", () => {
    expect(markdownView).not.toMatch(
      /^import\s+[^;]*from\s+"\.\.\/lib\/markdown";/m
    );
  });

  it("MarkdownView loads the renderer dynamically", () => {
    expect(markdownView).toContain('import("../lib/markdown")');
  });

  it("only lib/markdown.ts statically imports markdown-it or dompurify", () => {
    const offenders: string[] = [];
    for (const [file, text] of Object.entries(allSources)) {
      if (file.includes(".test.")) continue;
      if (/(^|\/)markdown\.ts$/.test(file)) continue;
      for (const line of text.split("\n")) {
        if (/^\s*import\s+type\b/.test(line)) continue;
        if (/^\s*import\s+[^("']*["'](markdown-it|dompurify)["']/.test(line)) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("scan-time modules import extraction from the dependency-free module", () => {
    for (const suffix of ["store.ts", "graph.ts", "deepResearch.ts"]) {
      const entry = Object.entries(allSources).find(
        ([f]) => f.endsWith(`/${suffix}`) && !f.includes(".test.")
      );
      expect(entry, `missing source for ${suffix}`).toBeTruthy();
      const text = entry![1];
      // Extraction comes from markdownExtract; the renderer is never imported.
      expect(text).toMatch(/from\s+"(\.\/|\.\/lib\/)markdownExtract";/);
      expect(text).not.toMatch(/from\s+"(\.\/|\.\.\/lib\/)markdown";/);
    }
  });
});
