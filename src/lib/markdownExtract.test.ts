import { describe, expect, it } from "vitest";
import { extractLinks, extractFirstImage, extractLinksAndFirstImage } from "./markdownExtract";

function legacy(source: string) {
  const links: string[] = [];
  let firstImage: string | null = null;
  for (const m of source.matchAll(/!?\[\[([^\]\n]+?)\]\]/g)) {
    const target = (m[1].split("|")[0] || "").trim();
    if (m[0][0] === "!" && /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(target)) {
      firstImage ??= target;
    } else if (target) links.push(target);
  }
  for (const m of source.matchAll(/(^|[^!])\[[^\]]*\]\(([^)\s]+)\)/g)) {
    let target = m[2].trim();
    if (/^(https?:|mailto:|tel:|data:|#)/i.test(target)) continue;
    target = target.split("#")[0];
    try { target = decodeURIComponent(target); } catch { /* preserve raw target */ }
    if (/\.(md|markdown)$/i.test(target)) links.push(target);
  }
  firstImage ??= /!\[[^\]]*\]\(([^)\s]+)/.exec(source)?.[1]?.trim() ?? null;
  return { links, firstImage };
}

describe("metadata delimiter scanning", () => {
  it("preserves legacy results for nested, adjacent, and malformed links", () => {
    const examples = [
      "[a](a.md)[b](b.md) [c](c.md)", "![a [b](b.md) [c](c.md)",
      "[[[nested]]] ![[photo.PNG|label]] [[alias|label]]",
      "![](image.png no closing parenthesis", "[a](A%20B.md#section)",
      "[a](https://example.com/a.md) [b](bad%path.md)", "[[]] [[real]]",
    ];
    let seed = 123456789;
    const tokens = ["[", "]", "!", "(", ")", "a.md", "b.png", "\n", " ", "|", "[[", "](", "%20"];
    for (let i = 0; i < 20000; i++) {
      let source = "";
      for (let j = 0; j < 20; j++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        source += tokens[seed % tokens.length];
      }
      examples.push(source);
    }
    for (const source of examples) {
      const expected = legacy(source);
      expect(extractLinksAndFirstImage(source), source).toEqual(expected);
      expect(extractLinks(source), source).toEqual(expected.links);
      expect(extractFirstImage(source), source).toEqual(expected.firstImage);
    }
  });

  it("bounds scans of unmatched labels and unterminated targets", () => {
    const start = performance.now();
    for (const source of ["[".repeat(40000), "![".repeat(20000), "[](text".repeat(10000)]) {
      expect(extractLinks(source)).toEqual([]);
    }
    expect(extractLinks("[".repeat(20000) + "\n[[valid]]")).toEqual(["valid"]);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
