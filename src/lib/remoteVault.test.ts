import { describe, expect, it } from "vitest";
import { isLikelyRemoteVaultPath } from "./vault";

describe("remote vault hints", () => {
  it("recognizes UNC and macOS mounted-volume roots", () => {
    expect(isLikelyRemoteVaultPath("//nas/share/Mesa")).toBe(true);
    expect(isLikelyRemoteVaultPath("\\\\nas\\share\\Mesa")).toBe(true);
    expect(isLikelyRemoteVaultPath(["", "Volumes", "Example", "Mesa"].join("/"))).toBe(true);
  });

  it("treats an ordinary local root as local", () => {
    expect(isLikelyRemoteVaultPath("/tmp/MesaVault")).toBe(false);
  });
});
