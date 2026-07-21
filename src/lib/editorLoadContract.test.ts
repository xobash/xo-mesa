import { describe, expect, it } from "vitest";
// The CodeMirror editor stack (codemirror + @codemirror/* + @lezer/*, ~590 kB
// minified) is deliberately kept OUT of the startup bundle: App.tsx lazy-loads
// the Editor component, so the main-window shell paints before the editor
// chunk parses and popout windows (?doc / ?panel / ?agent) never pay for an
// editor they cannot render. Same stance as the pdf-lib split in pdfBytes.ts
// and the xterm split in xtermLoadContract.test.ts. These tests pin both
// halves so a refactor cannot silently pull the editor back into the entry
// chunk.
import app from "../App.tsx?raw";

const allSources = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("editor lazy-load contract", () => {
  it("App.tsx does not statically import the Editor component", () => {
    expect(app).not.toMatch(/^import\s+[^;]*from\s+"\.\/components\/Editor";/m);
  });

  it("App.tsx loads the Editor dynamically", () => {
    expect(app).toContain('import("./components/Editor")');
  });

  it("only Editor.tsx statically imports the CodeMirror stack", () => {
    const offenders: string[] = [];
    for (const [file, text] of Object.entries(allSources)) {
      if (file.includes(".test.")) continue;
      if (file.endsWith("components/Editor.tsx")) continue;
      for (const line of text.split("\n")) {
        if (/^\s*import\s+type\b/.test(line)) continue;
        // Static `import …` statements only (`import\s` excludes dynamic
        // `import(...)` calls); bare "codemirror" / "@codemirror/*" /
        // "@lezer/*" specifiers.
        if (/^\s*import\s+[^("']*["'](codemirror|@codemirror\/|@lezer\/)/.test(line)) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
