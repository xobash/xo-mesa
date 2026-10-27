import { expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
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

it("preserves the BOM in saved bytes and the exact expected disk hash", async () => {
  vi.resetModules();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  try {
    const { writeNote, isValidUtf8Text } = await import("./vault");
    const disk = new TextEncoder().encode("\uFEFF# Original\n");
    invoke.mockReset();
    invoke.mockImplementation(async (command: string) => command === "vault_read_bytes" ? disk.slice(0, 3).buffer : undefined);
    await writeNote({ path: "/vault/bom.md", relPath: "bom.md", name: "bom", ext: "md", isMarkdown: true }, "# Edited\n", "# Original\n");
    const [, candidate, options] = invoke.mock.calls.find(call => call[0] === "vault_write_atomic") as unknown as [string, Uint8Array, { headers: Record<string, string> }];
    expect(candidate).toEqual(new TextEncoder().encode("\uFEFF# Edited\n"));
    const expected = JSON.parse(options.headers["x-mesa-expected"]);
    expect(expected.size).toBe(disk.length);
    expect(expected.sha256).toBe(Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", disk)), b => b.toString(16).padStart(2, "0")).join(""));
    const file = { path: "/vault/latin1.txt", relPath: "latin1.txt", name: "latin1", ext: "txt", isMarkdown: false };
    invoke.mockResolvedValue(new Uint8Array([0x63, 0x61, 0x66, 0xe9]).buffer);
    expect(await isValidUtf8Text(file, "caf\uFFFD")).toBe(false);
    invoke.mockResolvedValue(new TextEncoder().encode("caf\uFFFD").buffer);
    expect(await isValidUtf8Text(file, "caf\uFFFD")).toBe(true);
  } finally { vi.unstubAllGlobals(); vi.resetModules(); }
});
