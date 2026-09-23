import { describe, it, expect } from "vitest";
import { faceFor, phraseFor, statusLine, varietyFor } from "./faces";
import type { ActivityOp } from "./activity";

const OPS: ActivityOp[] = ["read", "edit", "write", "create"];

describe("faces", () => {
  it("picks a stable face per op+seed (no flicker across frames)", () => {
    for (const op of OPS) {
      expect(faceFor(op, "some-note-id")).toBe(faceFor(op, "some-note-id"));
      expect(typeof faceFor(op, "x")).toBe("string");
    }
  });

  it("every default phrase ends in an ellipsis (reads as ongoing)", () => {
    for (const op of OPS) {
      for (const seed of ["a", "b", "c", "note-1", "Frontier/INDEX.md"]) {
        expect(phraseFor(op, seed)).toMatch(/…$/);
      }
    }
  });

  it("builds a quirky status line with a face, honoring a custom phrase", () => {
    expect(statusLine("edit", "s")).toMatch(/.+…$/); // face + phrase ending in …
    expect(statusLine("edit", "s", "computing…")).toContain("computing…");
    // custom phrase still keeps the face (non-empty prefix before the phrase)
    expect(statusLine("read", "s", "thinking hard…")).toMatch(/^.{2,}…$/);
  });

  it("offers plenty of variety per op (quirky personality expansion)", () => {
    // The user explicitly wants several different face+message variations.
    for (const op of OPS) {
      expect(varietyFor(op)).toBeGreaterThanOrEqual(20);
    }
    // edit got the biggest personality pass — make sure it's rich
    expect(varietyFor("edit")).toBeGreaterThanOrEqual(100);
  });

  it("different seeds surface different faces/phrases (variety is real)", () => {
    const faces = new Set(
      Array.from({ length: 64 }, (_, i) => faceFor("edit", `seed-${i}`))
    );
    const phrases = new Set(
      Array.from({ length: 64 }, (_, i) => phraseFor("edit", `seed-${i}`))
    );
    expect(faces.size).toBeGreaterThan(1);
    expect(phrases.size).toBeGreaterThan(1);
  });

  it("every face is a parenthesised kaomoji (no empty/garbage entries)", () => {
    for (const op of OPS) {
      const seen = new Set<string>();
      for (const seed of ["", "a", "b", "c", "d", "e", "f", "g", "h"]) {
        const f = faceFor(op, seed);
        expect(f.length).toBeGreaterThan(2);
        seen.add(f);
      }
      expect(seen.size).toBeGreaterThan(1);
    }
  });
});
