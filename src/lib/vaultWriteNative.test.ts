import { expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke,
}));

import { nativeVaultWriteAtomic } from "./vault";

it("sends one candidate and a SHA-256 disk expectation to the native transaction", async () => {
  await nativeVaultWriteAtomic("/vault/note.md", new Uint8Array([4, 5]), new Uint8Array([1, 2, 3]));
  expect(invoke).toHaveBeenCalledWith("vault_write_atomic", new Uint8Array([4, 5]), {
    headers: {
      "x-mesa-path": "2f7661756c742f6e6f74652e6d64",
      "x-mesa-expected": JSON.stringify({
        kind: "hash",
        sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
        size: 3,
      }),
    },
  });
});

it("uses a missing-target expectation for new files", async () => {
  invoke.mockClear();
  await nativeVaultWriteAtomic("/vault/new.md", new Uint8Array([9]), null);
  expect(invoke).toHaveBeenCalledWith("vault_write_atomic", new Uint8Array([9]), {
    headers: { "x-mesa-path": "2f7661756c742f6e65772e6d64", "x-mesa-expected": '{"kind":"missing"}' },
  });
});

it("encodes non-ASCII paths as ASCII header values and never nests bytes in a JSON object", async () => {
  invoke.mockClear();
  const big = new Uint8Array(1024);
  await nativeVaultWriteAtomic("/vault/näme.md", big, null);
  const [, body, options] = invoke.mock.calls[0] as unknown as [string, Uint8Array, { headers: Record<string, string> }];
  expect(body).toBe(big);
  for (const value of Object.values(options.headers)) expect(value).toMatch(/^[\x20-\x7e]+$/);
  expect(new TextDecoder().decode(Uint8Array.from(options.headers["x-mesa-path"].match(/../g)!.map((h) => parseInt(h, 16))))).toBe("/vault/näme.md");
});
