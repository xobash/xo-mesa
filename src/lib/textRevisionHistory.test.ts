// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearTextRevisionsForTests,
  listTextRevisions,
  migrateTextRevisions,
  recordTextRevision,
  recordTextRevisionAsync,
  migrateRevisionNamespaces,
} from "./textRevisionHistory";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
    const first = recordTextRevision("/vault", "Note.md", "same", 1);
    expect(recordTextRevision("/vault", "Note.md", "same", 2)).toEqual(first);

    expect(listTextRevisions("/vault", "Note.md")).toHaveLength(1);
  });

  it("preserves an empty baseline and reports an existing revision as available", async () => {
    const empty = await recordTextRevisionAsync("/vault", "Note.md", "", 1);
    expect(empty?.content).toBe("");
    expect(await recordTextRevisionAsync("/vault", "Note.md", "", 2)).toEqual(empty);
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

/** Transaction fixture retains staged writes until commit, including rollback. */
function historyDatabase(entries: Array<Record<string, unknown>>, rejectWrite = false) {
  const records = new Map(entries.map(entry => [entry.id, entry]));
  const db = {
    close: () => {},
    transaction: () => {
      const staged = new Map(records);
      let aborted = false;
      const tx = {
        oncomplete: null as (() => void) | null,
        onabort: null as (() => void) | null,
        onerror: null as (() => void) | null,
        error: new Error("transaction aborted"),
        abort: () => { aborted = true; tx.onabort?.(); },
        objectStore: () => ({
          put: (entry: Record<string, unknown>) => { if (rejectWrite) throw Error("quota"); staged.set(entry.id, entry); },
          getAll: () => {
            const request = { result: [...records.values()], onsuccess: null as (() => void) | null, onerror: null, error: null };
            queueMicrotask(() => {
              request.onsuccess?.();
              if (!aborted) { records.clear(); for (const [id, value] of staged) records.set(id, value); tx.oncomplete?.(); }
            });
            return request;
          },
        }),
      };
      return tx;
    },
  };
  vi.stubGlobal("indexedDB", { open: () => {
    const request = { result: db, onsuccess: null as (() => void) | null, onerror: null, onblocked: null, onupgradeneeded: null };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  } });
  return records;
}
it("migrates IndexedDB recovery identities without losing revisions or save ordering", async () => {
  const original = { id: "stored", root: "/synthetic/old", relPath: "note.md", content: "disk baseline", savedAt: 1, order: 2 };
  const records = historyDatabase([original]);
  localStorage.setItem("mesa:textRevisionHistory:v1", JSON.stringify([{ ...original, id: "legacy", content: "older draft", order: 1 }]));
  await migrateRevisionNamespaces(() => "opaque-id");
  expect([...records.values()]).toEqual([{ ...original, root: "opaque-id" }, { ...original, id: "legacy", root: "opaque-id", content: "older draft", order: 1 }]);
  expect(localStorage.getItem("mesa:textRevisionHistory:v1")).toBeNull();
});
it("rolls back a rejected history migration and retains the legacy recovery source", async () => {
  const original = { id: "stored", root: "/synthetic/old", relPath: "note.md", content: "disk baseline", savedAt: 1 };
  const records = historyDatabase([original], true);
  localStorage.setItem("mesa:textRevisionHistory:v1", JSON.stringify([original]));
  await expect(migrateRevisionNamespaces(() => "opaque-id")).rejects.toThrow("transaction aborted");
  expect(records.get("stored")).toEqual(original);
  expect(localStorage.getItem("mesa:textRevisionHistory:v1")).toContain("disk baseline");
});
