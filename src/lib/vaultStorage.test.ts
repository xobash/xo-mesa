// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => {
  vi.resetModules(); localStorage.clear();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  invoke.mockImplementation(async (_command: string, args: { root: string }) => "vault:" + (args.root === "/synthetic/one" ? "a" : "b").repeat(64));
});
afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear();
});
describe("opaque vault storage", () => {
  it("migrates all legacy draft/history roots while preserving authored recovery bytes", async () => {
    const original = JSON.stringify({ version: 1, content: "unsaved", baseline: "disk", dirty: true });
    const oldKey = `mesa:overlay-draft:${JSON.stringify(["/synthetic/one", "draft.md"])}`;
    localStorage.setItem(oldKey, original);
    localStorage.setItem("mesa:textRevisionHistory:v1", JSON.stringify([{ id: "old", root: "/synthetic/two", relPath: "note.md", content: "prior text", savedAt: 1 }]));
    const { initializeVaultStorage, vaultStorageId } = await import("./vaultStorage");
    expect(() => vaultStorageId("/synthetic/one")).toThrow(/not initialized/);
    await initializeVaultStorage("/synthetic/one");
    const key = `mesa:overlay-draft:${JSON.stringify([vaultStorageId("/synthetic/one"), "draft.md"])}`;
    expect(localStorage.getItem(oldKey)).toBeNull();
    expect(localStorage.getItem(key)).toBe(original);
    expect(localStorage.getItem("mesa:textRevisionHistory:v1")).not.toContain("synthetic");
    const { listTextRevisions } = await import("./textRevisionHistory");
    expect(listTextRevisions("/synthetic/two", "note.md")[0].content).toBe("prior text");
  });
  it("retains the legacy draft if quota blocks migration", async () => {
    const oldKey = `mesa:overlay-draft:${JSON.stringify(["/synthetic/one", "draft.md"])}`;
    localStorage.setItem(oldKey, "authored bytes");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    const { initializeVaultStorage } = await import("./vaultStorage");
    await expect(initializeVaultStorage("/synthetic/one")).rejects.toThrow("quota");
    expect(localStorage.getItem(oldKey)).toBe("authored bytes");
  });
  it("keeps conflicting legacy recovery copies under an opaque key", async () => {
    localStorage.setItem(`mesa:overlay-draft:${JSON.stringify(["/synthetic/one", "draft.md"])}`, "older authored bytes");
    const key = `mesa:overlay-draft:${JSON.stringify(["vault:" + "a".repeat(64), "draft.md"])}`;
    localStorage.setItem(key, "newer authored bytes");
    await (await import("./vaultStorage")).initializeVaultStorage("/synthetic/one");
    expect(localStorage.getItem(key)).toBe("newer authored bytes");
    expect(localStorage.getItem(key.replace("mesa:overlay-draft:", "mesa:overlay-draft-recovery:"))).toBe("older authored bytes");
  });
});

it("migrates closed-vault metadata at native startup without opening a directory", async () => {
  const key = `mesa:overlay-draft:${JSON.stringify(["/synthetic/one", "draft.md"])}`;
  localStorage.setItem(key, "authored bytes");
  await (await import("./vaultStorage")).initializeVaultStorage();
  expect(localStorage.getItem(key)).toBeNull();
  expect(invoke).toHaveBeenCalledWith("vault_storage_id", { root: "/synthetic/one" });
});

it.each([[4, true], [5, false]] as const)("drops obsolete index version %s without expiring the current cache", async (version, removed) => {
  const deleteDatabase = vi.fn(() => {
    const request = { onsuccess: null as (() => void) | null, onerror: null, onblocked: null, error: null };
    queueMicrotask(() => request.onsuccess?.()); return request;
  });
  vi.stubGlobal("indexedDB", { deleteDatabase, open: () => {
    const request = { result: { version, close: vi.fn() }, onsuccess: null as (() => void) | null, onerror: null, onblocked: null, error: null };
    queueMicrotask(() => request.onsuccess?.()); return request;
  } });
  await (await import("./vaultStorage")).discardLegacyIndexStorage();
  expect(deleteDatabase).toHaveBeenCalledTimes(removed ? 1 : 0);
});
