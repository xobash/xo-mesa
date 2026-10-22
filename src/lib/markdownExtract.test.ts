import { describe, expect, it } from "vitest";
import { extractLinks, extractLinksAndFirstImage } from "./markdownExtract";

function legacy(source: string) {
  const links: string[] = [];
  let firstImage: string | null = null;
  for (const m of source.matchAll(/!?\[\[([^\]\n]+?)\]\]/g)) {
    const target = (m[1].split("|")[0] || "").replace(/\\$/, "").trim();
    if (m[0][0] === "!" && /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(target)) {
      firstImage ??= target;
    } else if (target) links.push(target);
  }
  // CommonMark link: `<destination>` or a bare one, then an optional title and spaces.
  // A label that holds an inline image (`[![alt](img)](Note.md)`) closes after the image.
  const imageLabel = String.raw`[^\]]*!\[[^\[\]]*\]\([^)\s]+\)[^\]]*`;
  const label = `(?:(?=${imageLabel}\\]\\()${imageLabel}|(?!${imageLabel}\\]\\()[^\\]]*)`;
  const link = new RegExp(String.raw`(^|[^!])\[` + label + String.raw`\]\((?:<([^>\n]+)>|([^)\s]+))(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*\)`, "g");
  for (const m of source.matchAll(link)) {
    let target = (m[2] ?? m[3]).trim();
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
      '[t](Note.md "Title") [a](<My Note.md>) [p](Other.md (paren)) [s](Spaced.md )', "[bad](<Open.md\n>) [x](No.md \"open)",
      "[a](a.md)[b](b.md) [c](c.md)", "![a [b](b.md) [c](c.md)",
      "[[[nested]]] ![[photo.PNG|label]] [[alias|label]]",
      "![](image.png no closing parenthesis", "[a](A%20B.md#section)",
      "[a](https://example.com/a.md) [b](bad%path.md)", "[[]] [[real]]",
    ];
    let seed = 123456789;
    const tokens = ["[", "]", "!", "(", ")", "a.md", "b.png", "\n", " ", "|", "[[", "](", "%20", '"', "<", ">", "\\"];
    // A deterministic 4,000-case corpus covers the delimiter state space while
    // staying well below Vitest's timeout under a loaded CI runner. The former
    // 20,000 cases repeated three extractors per sample and was a 5-6 second
    // brute-force test rather than a stronger behavioral assertion.
    for (let i = 0; i < 4000; i++) {
      let source = "";
      for (let j = 0; j < 20; j++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        source += tokens[seed % tokens.length];
      }
      examples.push(source);
    }
    for (const source of examples) {
      const expected = legacy(source);
      expect(extractLinksAndFirstImage(source), source).toMatchObject(expected);
      expect(extractLinks(source), source).toEqual(expected.links);
    }
  });

  it("indexes local attachment and note destinations for bounded rename repair", () => {
    expect(extractLinksAndFirstImage(
      "[[Note]] ![[assets/Photo.png]] [note](docs/Note.md) ![image](assets/Photo.png) [web](https://example.com)"
    ).references).toEqual([
      "Note",
      "assets/Photo.png",
      "docs/Note.md",
      "assets/Photo.png",
    ]);
  });

  it("indexes local reference-style definition destinations", () => {
    expect(extractLinksAndFirstImage(
      "[scan]: <assets/Scan.pdf#page=2> \"title\"\n[web]: https://example.com"
    ).references).toEqual(["assets/Scan.pdf#page=2"]);
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

it("links titled and angle-bracket Markdown destinations into the graph", () => {
  expect(extractLinks('[t](Note.md "Title") [a](<My Note.md>) [p](Other.md (paren)) [s](Spaced.md )'))
    .toEqual(["Note.md", "My Note.md", "Other.md", "Spaced.md"]);
  expect(extractLinks("| [[b/Note\\|alias]] |")).toEqual(["b/Note"]);
});

it("does not read tags inside a ~~~ fence", async () => {
  const { extractTags } = await import("./markdownExtract");
  expect(extractTags("~~~\n#notatag\n~~~\n#real")).toEqual(["real"]);
});

it("links and indexes a Markdown link whose label is an image", () => {
  const { links, references } = extractLinksAndFirstImage("[![b](x.png)](Note.md) [t ![i](y.png) more](<My N.md> \"t\")");
  expect(links).toEqual(["Note.md", "My N.md"]);
  expect(references).toEqual(["Note.md", "My N.md", "x.png", "y.png"]);
  expect(extractLinks("[![b](x.png)](no destination [a](A.md)")).toEqual(["A.md"]);
});

it("extracts tags in any script without matching numbers or URL fragments", async () => {
  const { extractTags } = await import("./markdownExtract");
  expect(extractTags("#café #日本語 #straße/sub-1 #über_x")).toEqual(["café", "日本語", "straße/sub-1", "über_x"]);
  expect(extractTags("#cafe\u0301 tag")).toEqual(["cafe\u0301"]);
  expect(extractTags("#123 #1st https://example.com/#anchor a#b")).toEqual([]);
  expect(extractTags("# Heading\n## Sub")).toEqual([]);
});
