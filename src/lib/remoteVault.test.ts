import { describe, expect, it } from "vitest";
import { isLikelyRemoteVaultPath, vaultTextChunkConcurrency } from "./vault";

describe("remote vault hints", () => {
  it("recognizes UNC and macOS mounted-volume roots", () => {
    expect(isLikelyRemoteVaultPath("//nas/share/Mesa")).toBe(true);
    expect(isLikelyRemoteVaultPath("\\\\nas\\share\\Mesa")).toBe(true);
    expect(isLikelyRemoteVaultPath(["", "Volumes", "Example", "Mesa"].join("/"))).toBe(true);
  });

  it("does not change local-root concurrency", () => {
    expect(isLikelyRemoteVaultPath("/tmp/MesaVault")).toBe(false);
    expect(vaultTextChunkConcurrency("/tmp/MesaVault")).toBe(3);
    expect(vaultTextChunkConcurrency(["", "Volumes", "Example", "Vault"].join("/"))).toBe(1);
  });
});
