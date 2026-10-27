import { describe, expect, it } from "vitest";
import { consumeGraphWindowBootstrap, saveGraphWindowBootstrap } from "./graphWindowBootstrap";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

describe("graph window bootstrap", () => {
  it("hands graph metadata to a new window exactly once", () => {
    const storage = memoryStorage();
    const snapshot = {
      vaultPath: "/vault",
      vaultName: "Vault",
      files: [],
      notes: {},
      settings: { graphShowTags: true },
    };
    expect(saveGraphWindowBootstrap("graph-1", snapshot, storage)).toBe(true);
    expect(storage.getItem("mesa:graph-window:graph-1")).not.toContain("/vault");
    expect(consumeGraphWindowBootstrap("graph-1", storage, "/vault")).toEqual(snapshot);
    expect(consumeGraphWindowBootstrap("graph-1", storage, "/vault")).toBeNull();
  });
});
