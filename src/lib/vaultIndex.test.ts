import { describe, expect, it, vi } from "vitest";
import type { VaultFile } from "../types";
import { fingerprintText, loadIndexedNotes, retainedSnapshotMetadata, type VaultIndexStorage } from "./vaultIndex";

describe("persisted vault-index accounting", () => {
  it("retains newest metadata inside the shared budget without document payloads", () => {
    const retained = retainedSnapshotMetadata([
      { root: "old", bytes: 8, cachedAt: 1 },
      { root: "middle", bytes: 8, cachedAt: 2 },
      { root: "new", bytes: 8, cachedAt: 3 },
    ], 16);
    expect(retained.map((entry) => entry.root).sort()).toEqual(["middle", "new"]);
  });

  it("keeps one oversized current snapshot rather than reporting an impossible empty cache", () => {
    expect(retainedSnapshotMetadata([{ root: "only", bytes: 99, cachedAt: 1 }], 1))
      .toEqual([{ root: "only", bytes: 99, cachedAt: 1 }]);
  });
});

describe("reopening an indexed vault", () => {
  const files: VaultFile[] = ["A.md", "B.md", "C.txt"].map((relPath) => ({
    path: `/v/${relPath}`, relPath, name: relPath.replace(/\.\w+$/, ""), ext: relPath.split(".").pop()!, isMarkdown: relPath.endsWith(".md"),
  }));
  const disk: Record<string, string> = { "A.md": "[[B]] #one", "B.md": "plain", "C.txt": "text" };
  const memory = () => {
    let stored: Parameters<VaultIndexStorage["save"]>[0] | null = null;
    const storage: VaultIndexStorage & { save: ReturnType<typeof vi.fn> } = {
      load: async () => stored && structuredClone(stored),
      save: vi.fn(async (snapshot) => { stored = structuredClone(snapshot); }),
    };
    return storage;
  };
  const open = (storage: VaultIndexStorage, onCached?: Parameters<typeof loadIndexedNotes>[0]["onCached"]) => {
    const read = vi.fn(async (batch: VaultFile[]) => batch.map((file) => ({ kind: "content" as const, text: disk[file.relPath] })));
    const result = loadIndexedNotes({
      root: "/v", files, read, stopped: () => false, storage, onCached,
      fingerprints: (rels) => Promise.all(rels.map((rel) => fingerprintText(disk[rel]))),
    });
    return { read, result };
  };

  it("shows the stored index before verification and does not rewrite an unchanged snapshot", async () => {
    const storage = memory();
    const cold = open(storage);
    expect((await cold.result).read).toBe(3);
    await vi.waitFor(() => expect(storage.save).toHaveBeenCalledOnce());

    const shown: { files: string[]; links: string[]; text: string; missing: number }[] = [];
    let readsWhenShown = -1;
    const warm = open(storage, (cached) => {
      readsWhenShown = warm.read.mock.calls.length;
      shown.push({ files: Object.keys(cached.notes).sort(), links: cached.notes["A.md"].rawLinks, text: cached.cache["A.md"], missing: cached.missing });
    });
    const result = await warm.result;
    expect(readsWhenShown).toBe(0);
    expect(shown).toEqual([{ files: ["A.md", "B.md", "C.txt"], links: ["B"], text: "[[B]] #one", missing: 0 }]);
    expect(warm.read).not.toHaveBeenCalled();
    expect(result).toMatchObject({ reused: 3, read: 0 });
    expect(result.changed.size).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(storage.save).toHaveBeenCalledOnce();
  });

  it("reports only documents whose bytes changed since the stored index", async () => {
    const storage = memory();
    await open(storage).result;
    disk["B.md"] = "now links [[A]]";
    try {
      let shownText = "";
      const warm = open(storage, (cached) => { shownText = cached.cache["B.md"]; });
      const result = await warm.result;
      expect(shownText).toBe("plain");
      expect([...result.changed]).toEqual([["B.md", "now links [[A]]"]]);
      expect(result.notes["B.md"].rawLinks).toEqual(["A"]);
      expect(result).toMatchObject({ reused: 2, read: 1 });
      await vi.waitFor(() => expect(storage.save).toHaveBeenCalledTimes(2));
    } finally {
      disk["B.md"] = "plain";
    }
  });
});
