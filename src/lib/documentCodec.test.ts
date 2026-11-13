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

  it("stores task records that survive storage and worker cloning unchanged", () => {
    const doc = encodeDocument("- [ ] call @agent 📅 2026-07-01\n- [x] done", true);
    expect(structuredClone(doc.tasks)).toEqual(doc.tasks);
    expect(JSON.parse(JSON.stringify(doc.tasks))).toEqual(doc.tasks);
    expect(doc.tasks[0]).toMatchObject({ line: 0, checked: false, due: "2026-07-01" });
  });
});
