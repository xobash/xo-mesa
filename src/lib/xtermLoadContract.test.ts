import { describe, expect, it } from "vitest";
// xterm.js is deliberately kept OUT of the startup bundle: AgentPanel loads
// the engine on demand when a Pi surface first mounts (createSharedPiTerminal,
// same stance as the pdf-lib split in pdfBytes.ts). These contract tests pin
// both halves of that split so a refactor cannot silently pull ~330 kB of
// terminal engine back into the entry chunk — and pin xterm.css's place
// BEFORE styles.css, because Mesa's .xterm-host overrides win by ORDER at
// equal specificity (e.g. viewport overflow-y: auto vs xterm.css's scroll).
import agentPanel from "../components/AgentPanel.tsx?raw";
import main from "../main.tsx?raw";

const allSources = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("xterm lazy-load contract", () => {
  it("AgentPanel's static @xterm imports are type-only", () => {
    const staticImports = [
      ...agentPanel.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"(@xterm[^"]*)";/gm),
    ];
    expect(staticImports.length).toBeGreaterThan(0);
    for (const m of staticImports) {
      expect(m[1], `static value import of ${m[2]} in AgentPanel.tsx`).toBe("type ");
    }
  });

  it("AgentPanel loads the terminal engine dynamically", () => {
    expect(agentPanel).toContain('import("@xterm/xterm")');
    expect(agentPanel).toContain('import("@xterm/addon-fit")');
  });

  it("keeps xterm.css statically imported before styles.css (cascade order)", () => {
    const xtermCss = main.indexOf('"@xterm/xterm/css/xterm.css"');
    const styles = main.indexOf('"./styles.css"');
    expect(xtermCss).toBeGreaterThan(-1);
    expect(styles).toBeGreaterThan(xtermCss);
  });

  it("no module statically pulls the xterm engine into the entry bundle", () => {
    const offenders: string[] = [];
    for (const [file, text] of Object.entries(allSources)) {
      if (file.includes(".test.")) continue;
      for (const line of text.split("\n")) {
        if (/^\s*import\s+type\b/.test(line)) continue;
        // Static `import …` statements only (`import\s` excludes dynamic
        // `import(...)` calls); bare "@xterm/xterm" / "@xterm/addon-fit"
        // specifiers only — the xterm.css deep path is the deliberate static
        // exception (see above).
        if (/^\s*import\s+[^("']*["']@xterm\/(xterm|addon-fit)["']/.test(line)) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
