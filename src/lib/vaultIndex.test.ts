import { describe, expect, it } from "vitest";
import { retainedSnapshotMetadata } from "./vaultIndex";

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
