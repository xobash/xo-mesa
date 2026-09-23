// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearTextRevisionsForTests,
  listTextRevisions,
  migrateTextRevisions,
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

  it("keeps monotonic newest-first order when saves share a timestamp", () => {
    recordTextRevision("/vault", "Note.md", "first", 10);
    recordTextRevision("/vault", "Note.md", "second", 10);
    recordTextRevision("/vault", "Note.md", "third", 10);

    expect(listTextRevisions("/vault", "Note.md").map((revision) => revision.content)).toEqual([
      "third",
      "second",
      "first",
    ]);
  });

  it("moves revisions with a verified file rename", () => {
    recordTextRevision("/vault", "Old.md", "first", 1);
    recordTextRevision("/vault", "Old.md", "second", 2);
    expect(migrateTextRevisions("/vault", "Old.md", "New.md")).toBe(true);
    expect(listTextRevisions("/vault", "Old.md")).toEqual([]);
    expect(listTextRevisions("/vault", "New.md").map((revision) => revision.content)).toEqual([
      "second",
      "first",
    ]);
  });

  it("does not store duplicate consecutive content", () => {
    recordTextRevision("/vault", "Note.md", "same", 1);
    recordTextRevision("/vault", "Note.md", "same", 2);

    expect(listTextRevisions("/vault", "Note.md")).toHaveLength(1);
  });

  it("fails closed when browser history storage is full without throwing", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });

    expect(recordTextRevision("/vault", "Note.md", "saved text", 1)).toBeNull();
    setItem.mockRestore();
  });

  it("does not depend on settings storage to mint the next revision identity", () => {
    const first = recordTextRevision("/vault", "Note.md", "first", 10);
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    // A localStorage-only browser cannot retain this copy, but an IDB-backed
    // desktop history must never derive its identity from this settings write.
    expect(recordTextRevision("/vault", "Other.md", "second", 10)).toBeNull();
    setItem.mockRestore();
    const revision = recordTextRevision("/vault", "Other.md", "third", 10);
    expect(revision?.id).not.toBe(first?.id);
    expect(revision?.order).toBeGreaterThan(first?.order ?? 0);
  });
});
