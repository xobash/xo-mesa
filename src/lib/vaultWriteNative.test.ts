import { expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke,
}));

import { nativeVaultWriteAtomic } from "./vault";

it("sends one candidate and a SHA-256 disk expectation to the native transaction", async () => {
  await nativeVaultWriteAtomic("/vault/note.md", new Uint8Array([4, 5]), new Uint8Array([1, 2, 3]));
  expect(invoke).toHaveBeenCalledWith("vault_write_atomic", {
    path: "/vault/note.md",
    data: new Uint8Array([4, 5]),
    expected: {
      kind: "hash",
      sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
      size: 3,
    },
  });
});

it("uses a missing-target expectation for new files", async () => {
  invoke.mockClear();
  await nativeVaultWriteAtomic("/vault/new.md", new Uint8Array([9]), null);
  expect(invoke).toHaveBeenCalledWith("vault_write_atomic", {
    path: "/vault/new.md", data: new Uint8Array([9]), expected: { kind: "missing" },
  });
});
