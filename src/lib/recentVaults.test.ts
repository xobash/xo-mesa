import { describe, expect, it } from "vitest";
import { forgetRecentVault, rememberRecentVault } from "./recentVaults";

describe("recent vault helpers", () => {
  it("moves the opened vault to the front and caps the list", () => {
    expect(
      rememberRecentVault(
        ["/Vaults/B", "/Vaults/A", "/Vaults/C"],
        "/Vaults/A",
        3,
        "__DEMO__"
      )
    ).toEqual(["/Vaults/A", "/Vaults/B", "/Vaults/C"]);
  });

  it("does not remember the demo sentinel", () => {
    expect(rememberRecentVault(["/Vaults/A"], "__DEMO__", 8, "__DEMO__")).toEqual([
      "/Vaults/A",
    ]);
  });

  it("forgets only the requested vault path", () => {
    expect(
      forgetRecentVault(
        ["/Vaults/A", "/Vaults/B", "/Vaults/C"],
        "/Vaults/B"
      )
    ).toEqual(["/Vaults/A", "/Vaults/C"]);
  });

  it("forgets a Windows vault regardless of slash direction or trailing slash", () => {
    // Entry stored with backslashes; removal requested with forward slashes.
    expect(
      forgetRecentVault(["C:\\Users\\Xo\\Vault", "/Vaults/A"], "C:/Users/Xo/Vault")
    ).toEqual(["/Vaults/A"]);
    // Trailing slash difference must still match.
    expect(
      forgetRecentVault(["/Vaults/A/", "/Vaults/B"], "/Vaults/A")
    ).toEqual(["/Vaults/B"]);
  });

  it("dedupes divergent spellings of the same folder when remembering", () => {
    expect(
      rememberRecentVault(["C:\\Users\\Xo\\Vault"], "C:/Users/Xo/Vault", 8, "__DEMO__")
    ).toEqual(["C:/Users/Xo/Vault"]);
  });

  it("treats drive-letter case differences as the same Windows folder", () => {
    expect(
      rememberRecentVault(["c:\\Users\\Xo\\Vault"], "C:/Users/Xo/Vault", 8, "__DEMO__")
    ).toEqual(["C:/Users/Xo/Vault"]);
    expect(
      forgetRecentVault(["c:/Users/Xo/Vault", "/Vaults/A"], "C:\\Users\\Xo\\Vault")
    ).toEqual(["/Vaults/A"]);
  });
});
