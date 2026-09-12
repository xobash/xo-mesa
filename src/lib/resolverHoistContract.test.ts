import { describe, expect, it } from "vitest";
// `resolveTarget` builds a whole-vault index (every note id, title, and alias
// lowercased into two Maps) and then throws it away, so it is O(notes) PER
// CALL. Calling it once per link is therefore quadratic: on a 698-note vault,
// a note with 341 outgoing links spent 162 ms rebuilding the same
// index 341 times, and buildResearchContext took 227 ms — all of it synchronous
// on the UI thread when a Deep Research run starts. Hoisting one `makeResolver`
// per loop cut that to 0.64 ms / 65 ms with byte-identical results.
//
// These tests pin the hoist so a later "simplification" back to the friendlier
// `resolveTarget(notes, x)` call cannot silently reintroduce the quadratic path.
import deepResearch from "./deepResearch.ts?raw";
import { makeResolver, resolveTarget } from "./graph";
import type { NoteMeta } from "../types";

const note = (title: string, aliases: string[] = []): NoteMeta =>
  ({ title, aliases, rawLinks: [], tags: [] }) as unknown as NoteMeta;

describe("resolver hoist contract", () => {
  it("deepResearch never calls resolveTarget (it resolves in loops)", () => {
    const calls = [...deepResearch.matchAll(/\bresolveTarget\s*\(/g)];
    expect(
      calls.length,
      "deepResearch resolves links in loops — build one makeResolver(notes) " +
        "and reuse it instead of calling resolveTarget per link"
    ).toBe(0);
  });

  it("deepResearch imports makeResolver rather than resolveTarget", () => {
    expect(deepResearch).toMatch(/import\s*{[^}]*\bmakeResolver\b[^}]*}\s*from\s*"\.\/graph"/);
  });

  it("buildChangeSet reuses a source lookup for generated-note source metadata", () => {
    const start = deepResearch.indexOf("export function buildChangeSet");
    const end = deepResearch.indexOf("/** Collision-free relPath", start);
    const body = deepResearch.slice(start, end);
    expect(body).toContain("const sourceByUrl = new Map");
    expect(body).not.toMatch(/result\.sources\.(?:find|some)\(/);
  });

  it("a hoisted resolver agrees with resolveTarget on every target shape", () => {
    const notes: Record<string, NoteMeta> = {
      "notes/Alpha.md": note("Alpha", ["A1"]),
      "notes/deep/Beta.md": note("Beta"),
      "Gamma.md": note("Gamma Title"),
    };
    const targets = [
      "Alpha",
      "alpha",
      "A1",
      "notes/Alpha",
      "notes/Alpha.md",
      "notes\\Alpha.md", // backslash-normalised
      "  Beta  ", // trimmed
      "Gamma Title",
      "Gamma",
      "nope",
      "notes/deep/Beta.md",
    ];
    const hoisted = makeResolver(notes);
    for (const t of targets) {
      expect(hoisted(t), `hoisted resolver disagreed on "${t}"`).toBe(
        resolveTarget(notes, t)
      );
    }
  });

  it("the hoisted resolver is reusable across many targets", () => {
    // Reusing one resolver must not accumulate state between calls.
    const notes: Record<string, NoteMeta> = { "One.md": note("One") };
    const r = makeResolver(notes);
    expect(r("One")).toBe("One.md");
    expect(r("missing")).toBe(null);
    expect(r("One")).toBe("One.md");
  });
});
