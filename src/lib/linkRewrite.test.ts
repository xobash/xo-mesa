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
