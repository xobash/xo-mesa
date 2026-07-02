import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

/** Body of the first rule whose selector matches `re` (text between its
 *  opening `{` and matching closing `}`). */
function ruleBody(re) {
  const m = re.exec(css);
  if (!m) return "";
  const start = m.index + m[0].length; // just after the matched `{`
  let depth = 1;
  let i = start;
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return css.slice(start, i);
}

function hexLuminance(hex) {
  const raw = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(raw.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function tokenHex(block, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
  return match?.[1] ?? "";
}

function tokenNumber(block, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}:\\s*([0-9.]+)`).exec(block);
  return match ? Number.parseFloat(match[1]) : Number.NaN;
}

describe("layout css", () => {
  describe("graph color tokens", () => {
    it("keeps isolated notes dimmer than linked notes without making them unreadable", () => {
      const themes = [
        ruleBody(/:root,\s*:root\[data-theme="void"\]\s*\{/),
        ruleBody(/:root\[data-theme="darkroom"\]\s*\{/),
        ruleBody(/:root\[data-theme="system"\]\s*\{/),
        ruleBody(/:root\[data-theme="system"\]\[data-mode="dark"\]\s*\{/),
      ];

      for (const block of themes) {
        const node = hexLuminance(tokenHex(block, "--graph-node"));
        const isolated = hexLuminance(tokenHex(block, "--graph-node-isolated"));
        expect(isolated).toBeLessThan(node);
        expect(isolated / node).toBeGreaterThanOrEqual(0.42);
      }
    });

    it("keeps the full graph bloom only on the void theme", () => {
      const voidBlock = ruleBody(/:root,\s*:root\[data-theme="void"\]\s*\{/);
      const nonVoidBlocks = [
        ruleBody(/:root\[data-theme="darkroom"\]\s*\{/),
        ruleBody(/:root\[data-theme="system"\]\s*\{/),
        ruleBody(/:root\[data-theme="system"\]\[data-mode="dark"\]\s*\{/),
      ];

      expect(tokenNumber(voidBlock, "--graph-bloom-alpha")).toBe(1);
      for (const block of nonVoidBlocks) {
        const alpha = tokenNumber(block, "--graph-bloom-alpha");
        expect(alpha).toBeGreaterThan(0);
        expect(alpha).toBeLessThan(1);
      }
    });
  });

  it("lets auto-hide fill the workspace when the right stack is closed", () => {
    const autoHideRule = css.search(/\.layout\.auto-hide\s*\{/);
    const autoHideNoRightRule = css.search(/\.layout\.auto-hide\.no-right\s*\{/);
    expect(autoHideRule).toBeGreaterThanOrEqual(0);
    expect(autoHideNoRightRule).toBeGreaterThan(autoHideRule);

    const block = ruleBody(/\.layout\.auto-hide\.no-right\s*\{/);
    expect(block).toContain("grid-template-columns: 0 minmax(0, 1fr) 0");
  });

  it("keeps the closed sidebar mounted but non-interactive", () => {
    const block = ruleBody(/\.layout\.no-sidebar\s*>\s*\.sidebar\s*\{/);
    expect(block).toContain("visibility: hidden");
    expect(block).toContain("pointer-events: none");
  });

  it("keeps auto-hide sidebar open briefly after hover leaves", () => {
    expect(ruleBody(/\.layout\.auto-hide\s+\.sidebar\s*\{/)).toContain(
      "transition-delay: 0.75s"
    );
    expect(
      ruleBody(/\.layout\.auto-hide\s+\.sidebar-edge:hover\s*\+\s*\.sidebar,\s*\.layout\.auto-hide\s+\.sidebar:hover\s*\{/)
    ).toContain("transition-delay: 0s");
  });

  describe("dock-side flip", () => {
    it("docks the side stack left by swapping center/dock grid columns", () => {
      expect(ruleBody(/\.layout\.dock-left\s*\{/)).toContain(
        "grid-template-columns: var(--sidebar-w, 240px) var(--right-w, 380px) minmax(0, 1fr)"
      );
      expect(ruleBody(/\.layout\.dock-left\s*>\s*\.center\s*\{/)).toContain(
        "grid-column: 3"
      );
      expect(ruleBody(/\.layout\.dock-left\s*>\s*\.right-stack\s*\{/)).toContain(
        "grid-column: 2"
      );
    });

    it("zeros column 1 for the auto-hide + dock-left combo", () => {
      // The auto-hide sidebar is absolutely positioned, so column 1 must be 0
      // even when the dock is flipped to the left.
      expect(ruleBody(/\.layout\.auto-hide\.dock-left\s*\{/)).toContain(
        "0 var(--right-w, 380px) minmax(0, 1fr)"
      );
    });

    it("declares the dock-left base rule before the auto-hide override", () => {
      const base = css.search(/\.layout\.dock-left\s*\{/);
      const autoHide = css.search(/\.layout\.auto-hide\.dock-left\s*\{/);
      expect(base).toBeGreaterThan(0);
      expect(autoHide).toBeGreaterThan(base);
    });

    it("resets dock-left on narrow screens so a flipped dock leaves no gap", () => {
      const idx820 = css.search(/@media \(max-width: 820px\)/);
      const idx560 = css.search(/@media \(max-width: 560px\)/);
      expect(idx820).toBeGreaterThan(0);
      expect(idx560).toBeGreaterThan(idx820);

      const block820 = css.slice(idx820, idx560);
      expect(block820).toContain(".layout.dock-left");
      expect(block820).toContain("var(--sidebar-w, 200px) minmax(0, 1fr)");
      expect(block820).toContain("grid-column: 2");

      const block560 = css.slice(idx560);
      expect(block560).toContain(".layout.dock-left");
      expect(block560).toContain("minmax(0, 1fr)");
      expect(block560).toContain("grid-column: 1");
    });
  });
});
