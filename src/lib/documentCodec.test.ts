import { describe, expect, it } from "vitest";
import { encodeDocument } from "./documentCodec";
import { indexedContentCache } from "./documentWorkingSet";

describe("document codec", () => {
  it("preserves text that cannot be represented as strict UTF-8", () => {
    const text = "draft \ud800";
    const cache = indexedContentCache([["note.md", encodeDocument(text)]]);
    expect(cache["note.md"]).toBe(text);
  });

  it("stores task summaries with the compressed document", () => {
    const doc = encodeDocument("- [x] done\n- [ ] next");
    expect(doc.tasks.map((task) => task.text)).toEqual(["done", "next"]);
  });
});
