import { expect, it } from "vitest";
import { referenceMayTarget, rewriteInboundLinks } from "./linkRewrite";
import { makeResolver } from "./graph";
import type { NoteMeta } from "../types";

it("rewrites a relative Markdown link while preserving code examples and external links", () => {
  const source = "[open](../old/Note.md#part) `[[Note]]`\n```md\n[[Note]]\n```\n[web](https://example.test/Note.md)";
  const result = rewriteInboundLinks("docs/Index.md", source, "old/Note.md", "new/Note.md", () => null, true, false);
  expect(result.changed).toBe(true);
  expect(result.text).toBe("[open](../new/Note.md#part) `[[Note]]`\n```md\n[[Note]]\n```\n[web](https://example.test/Note.md)");
  expect(referenceMayTarget("docs/Index.md", "../old/Note.md#part", "old/Note.md", false)).toBe(true);
});

it("does not guess an ambiguous bare attachment name", () => {
  expect(rewriteInboundLinks("docs/Index.md", "![[photo.png]]", "assets/photo.png", "new/photo.png", () => null, false, false))
    .toEqual({ text: "![[photo.png]]", changed: false });
});

it("keeps a vault-path wikilink vault-relative instead of writing an unresolvable ../ path", () => {
  const resolve = (target: string) => target.toLowerCase().replace(/\.md$/, "") === "b/note" ? "b/Note.md" : null;
  expect(rewriteInboundLinks("a/src.md", "see [[b/Note]] and [md](b/Note.md)", "b/Note.md", "b/Renamed.md", resolve, true, true).text)
    .toBe("see [[b/Renamed]] and [md](b/Renamed.md)");
});

it("writes the full path when a bare link's new name already belongs to another note", () => {
  const resolve = (target: string) => {
    const t = target.toLowerCase().replace(/\.md$/, "");
    return t === "note" ? "b/Note.md" : t === "renamed" ? "c/Renamed.md" : null;
  };
  expect(rewriteInboundLinks("a/src.md", "[[Note]] and [[Note|alias]]", "b/Note.md", "b/Renamed.md", resolve, true, true).text)
    .toBe("[[b/Renamed]] and [[b/Renamed|alias]]");
  expect(rewriteInboundLinks("a/src.md", "[[Note]]", "b/Note.md", "b/Unique.md", resolve, true, true).text).toBe("[[Unique]]");
});

it("repairs titled, angle-bracket, table-escaped and leading-slash links and encodes % and #", () => {
  const resolve = (target: string) => target.toLowerCase().replace(/^\//, "").replace(/\.md$/, "") === "b/note" ? "b/Note.md" : null;
  const source = [
    '[t](b/Note.md "Title")',
    "[a](<b/Note.md#Part>)",
    "| [[b/Note\\|alias]] |",
    "[s](/b/Note.md)",
  ].join("\n");
  expect(rewriteInboundLinks("a/src.md", source, "b/Note.md", "b/100% done.md", resolve, true, true).text).toBe([
    '[t](b/100%25%20done.md "Title")',
    "[a](<b/100% done.md#Part>)",
    "| [[b/100% done\\|alias]] |",
    "[s](/b/100%25%20done.md)",
  ].join("\n"));
  expect(rewriteInboundLinks("a/src.md", "[x](b/Note.md)", "b/Note.md", "b/C#.md", resolve, false, true).text)
    .toBe("[x](b/C%23.md)");
});

const noteMeta = (relPath: string, aliases: string[] = []): NoteMeta => ({
  relPath, title: relPath.slice(relPath.lastIndexOf("/") + 1).replace(/\.md$/, ""), rawLinks: [], tags: [], aliases,
});

it("a dot in a note name is not read as a file extension", () => {
  const before = { "archive/v2.0 notes.md": noteMeta("archive/v2.0 notes.md"), "sub/v1.2 notes.md": noteMeta("sub/v1.2 notes.md"), "other/src.md": noteMeta("other/src.md") };
  const nested = rewriteInboundLinks("other/src.md", "see [[sub/v1.2 notes]]", "sub/v1.2 notes.md", "sub/v2.0 notes.md", makeResolver(before), true, false);
  expect(nested.text).toBe("see [[sub/v2.0 notes]]");
  const after = { "archive/v2.0 notes.md": noteMeta("archive/v2.0 notes.md"), "sub/v2.0 notes.md": noteMeta("sub/v2.0 notes.md"), "other/src.md": noteMeta("other/src.md") };
  expect(makeResolver(after)("sub/v2.0 notes")).toBe("sub/v2.0 notes.md");
  const bare = rewriteInboundLinks("src.md", "see [[v1.2 notes]]", "v1.2 notes.md", "v2.0 notes.md", makeResolver({ "v1.2 notes.md": noteMeta("v1.2 notes.md") }), true, true);
  expect(bare.text).toBe("see [[v2.0 notes]]");
});

it("an unmatched backtick does not hide a later live link", () => {
  const resolver = makeResolver({ "Note.md": noteMeta("Note.md") });
  expect(rewriteInboundLinks("src.md", "press ` then [[Note]]", "Note.md", "Renamed.md", resolver, true, true).text).toBe("press ` then [[Renamed]]");
  expect(rewriteInboundLinks("src.md", "``a` [[Note]]", "Note.md", "Renamed.md", resolver, true, true).text).toBe("``a` [[Renamed]]");
});

it("leaves a frontmatter-alias wikilink as written", () => {
  const r = rewriteInboundLinks("src.md", "[[Nick]] [[Note]]", "Note.md", "Renamed.md", makeResolver({ "Note.md": noteMeta("Note.md", ["Nick"]) }), true, true);
  expect(r.text).toBe("[[Nick]] [[Renamed]]");
});

it("percent-encodes % in a rewritten reference definition so the next rename still finds it", () => {
  const first = rewriteInboundLinks("src.md", "[x][r]\n\n[r]: Note.md", "Note.md", "100% done.md", makeResolver({ "Note.md": noteMeta("Note.md") }), true, true);
  expect(first.text).toBe("[x][r]\n\n[r]: 100%25%20done.md");
  expect(referenceMayTarget("src.md", "100%25%20done.md", "100% done.md", true)).toBe(true);
  const second = rewriteInboundLinks("src.md", first.text, "100% done.md", "Final.md", makeResolver({ "100% done.md": noteMeta("100% done.md") }), true, true);
  expect(second.text).toBe("[x][r]\n\n[r]: Final.md");
});

it("repairs a badge link and its image independently", () => {
  const resolver = makeResolver({ "Note.md": noteMeta("Note.md") });
  const source = "[![b](x.png)](Note.md)";
  expect(rewriteInboundLinks("src.md", source, "Note.md", "Renamed.md", resolver, true, true).text)
    .toBe("[![b](x.png)](Renamed.md)");
  expect(rewriteInboundLinks("src.md", source, "x.png", "y.png", resolver, false, true).text)
    .toBe("[![b](y.png)](Note.md)");
  expect(rewriteInboundLinks("src.md", "[![b](x.png)](https://example.test)", "x.png", "y.png", resolver, false, true).text)
    .toBe("[![b](y.png)](https://example.test)");
});

it("matches NFD and NFC spellings of the renamed file and keeps a leading ./", () => {
  const nfd = "Café.png";
  const nfc = "Café.png";
  expect(rewriteInboundLinks("Index.md", `![[${nfc}]]`, nfd, "Menu.png", () => null, false, true))
    .toEqual({ text: "![[Menu.png]]", changed: true });
  expect(referenceMayTarget("Index.md", nfc, nfd, true)).toBe(true);
  expect(rewriteInboundLinks("docs/Index.md", "[a](./Note.md) [c](../docs/Note.md)", "docs/Note.md", "docs/Renamed.md", () => null, true, false).text)
    .toBe("[a](./Renamed.md) [c](Renamed.md)");
});

it("scans malformed link runs in linear time and still repairs the following links", () => {
  const resolve = (target: string) => target.toLowerCase().replace(/\.md$/, "") === "note" ? "Note.md" : null;
  // Measured near 10 ms; the bound separates linear from quadratic work.
  for (const noise of ["![".repeat(100_000), "[[".repeat(100_000), "[](".repeat(66_000), "[![a](b)".repeat(25_000), `${"[[a".repeat(66_000)}]x`]) {
    const start = performance.now();
    const result = rewriteInboundLinks("a.md", `${noise}\n[n](Note.md) [[Note]] [![i](p.png)](Note.md)`, "Note.md", "New.md", resolve, true, true);
    expect(performance.now() - start).toBeLessThan(200);
    expect(result.text.endsWith("\n[n](New.md) [[New]] [![i](p.png)](New.md)")).toBe(true);
  }
});

it("keeps wiki-link edge cases: a single bracket ends a candidate, an embedded [[ starts the body", () => {
  const resolve = (target: string) => target.toLowerCase() === "note" ? "Note.md" : null;
  expect(rewriteInboundLinks("a.md", "[[Note]x [[Note]] [[a\n[[Note]]", "Note.md", "New.md", resolve, true, true).text)
    .toBe("[[Note]x [[New]] [[a\n[[New]]");
});
