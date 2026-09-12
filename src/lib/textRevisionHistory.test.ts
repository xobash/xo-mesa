// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearTextRevisionsForTests,
  listTextRevisions,
  recordTextRevision,
} from "./textRevisionHistory";

afterEach(() => {
  vi.useRealTimers();
  clearTextRevisionsForTests();
});

describe("text revision history", () => {
  it("keeps bounded local revisions per vault file", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    for (let i = 0; i < 25; i++) {
      recordTextRevision("/vault", "Note.md", `v${i}`, i + 1);
    }

    const revisions = listTextRevisions("/vault", "Note.md");
    expect(revisions).toHaveLength(20);
    expect(revisions[0].content).toBe("v24");
    expect(revisions[revisions.length - 1]?.content).toBe("v5");
  });

  it("does not store duplicate consecutive content", () => {
    recordTextRevision("/vault", "Note.md", "same", 1);
    recordTextRevision("/vault", "Note.md", "same", 2);

    expect(listTextRevisions("/vault", "Note.md")).toHaveLength(1);
  });
});
