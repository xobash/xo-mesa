import { describe, it, expect } from "vitest";
import { planTextCache, TEXT_CACHE_BUDGET_BYTES } from "./textCachePlan";
import { isTextualVaultFile } from "./vault";
import type { VaultFile } from "../types";

function file(relPath: string, size?: number): VaultFile {
  const ext = relPath.includes(".") ? relPath.split(".").pop()!.toLowerCase() : "";
  return {
    path: "/v/" + relPath,
    relPath,
    name: relPath.replace(/\.[^.]*$/, "").split("/").pop()!,
    ext,
    isMarkdown: ext === "md" || ext === "markdown",
    size,
  } as VaultFile;
}

const plan = (files: VaultFile[], budget?: number) =>
  planTextCache(files, isTextualVaultFile, budget);

describe("planTextCache", () => {
  it("selects non-markdown textual files and never markdown", () => {
    const files = [
      file("notes/a.md", 100),
      file("notes/b.txt", 100),
      file("code/c.py", 100),
      file("data/d.json", 100),
      file("page/e.html", 100),
    ];
    const p = plan(files);
    expect(p.extra.map((f) => f.relPath)).toEqual([
      "notes/b.txt",
      "code/c.py",
      "data/d.json",
      "page/e.html",
    ]);
    expect(p.skipped).toBe(0);
    expect(p.bytes).toBe(400);
  });

  it("never selects binaries the text pipeline does not own", () => {
    const files = [
      file("doc.pdf", 10),
      file("img.png", 10),
      file("clip.mp4", 10),
      file("archive.zip", 10),
      file("keep.txt", 10),
    ];
    const p = plan(files);
    expect(p.extra.map((f) => f.relPath)).toEqual(["keep.txt"]);
    expect(p.skipped).toBe(0);
  });

  it("stops at the budget and counts what it left out", () => {
    const files = [
      file("a.txt", 60),
      file("b.txt", 60),
      file("c.txt", 60),
      file("d.txt", 60),
    ];
    const p = plan(files, 150);
    expect(p.extra.map((f) => f.relPath)).toEqual(["a.txt", "b.txt"]);
    expect(p.bytes).toBe(120);
    expect(p.skipped).toBe(2);
  });

  it("keeps scanning past one oversized file instead of stopping", () => {
    // A single huge log must not cost every smaller file its cache entry.
    const files = [file("huge.txt", 1000), file("small.txt", 10)];
    const p = plan(files, 100);
    expect(p.extra.map((f) => f.relPath)).toEqual(["small.txt"]);
    expect(p.skipped).toBe(1);
  });

  it("is deterministic in file order, not resolution order", () => {
    const files = [file("z.txt", 60), file("a.txt", 60), file("m.txt", 60)];
    const p = plan(files, 150);
    expect(p.extra.map((f) => f.relPath)).toEqual(["z.txt", "a.txt"]);
    expect(plan([...files], 150).extra.map((f) => f.relPath)).toEqual([
      "z.txt",
      "a.txt",
    ]);
  });

  it("treats an unknown size as zero rather than dropping the file", () => {
    const files = [file("nostat.txt", undefined), file("sized.txt", 10)];
    const p = plan(files, 10);
    expect(p.extra.map((f) => f.relPath)).toEqual(["nostat.txt", "sized.txt"]);
    expect(p.skipped).toBe(0);
  });

  it("markdown is exempt from the budget entirely", () => {
    const files = [file("big.md", 10_000_000), file("small.txt", 10)];
    const p = plan(files, 100);
    expect(p.extra.map((f) => f.relPath)).toEqual(["small.txt"]);
    expect(p.bytes).toBe(10);
    expect(p.skipped).toBe(0);
  });

  it("handles an empty vault", () => {
    expect(plan([])).toEqual({ extra: [], skipped: 0, bytes: 0 });
  });

  it("the default budget covers a realistic large vault", () => {
    // 1,506 .txt averaging 20 kB — the shape that exposed the original gap.
    const files = Array.from({ length: 1506 }, (_, i) =>
      file(`t/${i}.txt`, 20_000)
    );
    const p = plan(files, TEXT_CACHE_BUDGET_BYTES);
    expect(p.skipped).toBe(0);
    expect(p.extra).toHaveLength(1506);
  });
});
