import { expect, it } from "vitest";
import { referenceMayTarget, rewriteInboundLinks } from "./linkRewrite";

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
