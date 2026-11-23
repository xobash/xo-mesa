import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./vaultFs", () => ({ isDemo: (path: string) => path.startsWith("/demo/") }));
vi.mock("./vaultDemo", () => ({ demoRead: () => "demo bytes here" }));
import { RANGE_READ_MAX_BYTES } from "./byteSource";
import { isOnlineOnlyReadError, readVaultBytes, readVaultRange } from "./vaultByteRead";

const file = (path: string) => ({ path, relPath: path.split("/").pop()!, name: "f", ext: "bin", isMarkdown: false });

function response(size: bigint, mtimeNs: bigint, body: number[]): ArrayBuffer {
  const out = new Uint8Array(16 + body.length);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, size, true);
  view.setBigUint64(8, mtimeNs, true);
  out.set(body, 16);
  return out.buffer;
}

describe("native range read", () => {
  beforeEach(() => invoke.mockReset());

  it("asks for one bounded slice past 4 GiB and decodes size and modification time", async () => {
    invoke.mockResolvedValueOnce(response(7_000_000_000n, 1_700_000_000_123_456_789n, [1, 2, 3]));
    const got = await readVaultRange(file("/vault/big.iso"), 5_000_000_000, 3);
    expect(invoke).toHaveBeenCalledWith("vault_read_range", { path: "/vault/big.iso", offset: 5_000_000_000, len: 3 });
    expect(got.size).toBe(7_000_000_000);
    expect(Array.from(got.bytes)).toEqual([1, 2, 3]);
    // One nanosecond apart: a millisecond stamp would miss this change.
    invoke.mockResolvedValueOnce(response(7_000_000_000n, 1_700_000_000_123_456_790n, []));
    const later = await readVaultRange(file("/vault/big.iso"), 0, 0);
    expect(later.stamp).not.toBe(got.stamp);
  });

  it("refuses a slice over 1 MiB or a bad offset before asking", async () => {
    await expect(readVaultRange(file("/vault/a.bin"), 0, RANGE_READ_MAX_BYTES + 1)).rejects.toThrow(/1\.0 MiB/);
    await expect(readVaultRange(file("/vault/a.bin"), -1, 4)).rejects.toThrow(/range/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("shows an online-only refusal as a download-first message, not a damaged file", async () => {
    invoke.mockRejectedValueOnce("online-only: This file is stored only in the cloud. Download it to this device, then open it again.");
    const error = await readVaultRange(file("/vault/cloud.pdf"), 0, 16).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("This file is stored only in the cloud. Download it to this device, then open it again.");
    expect(isOnlineOnlyReadError("online-only: x")).toBe(true);
    expect(isOnlineOnlyReadError(new Error("online-only: x"))).toBe(true);
    expect(isOnlineOnlyReadError("path is not a visible vault file")).toBe(false);
    invoke.mockRejectedValueOnce("file changed while reading");
    await expect(readVaultRange(file("/vault/a.bin"), 0, 4)).rejects.toThrow("file changed while reading");
  });

  it("reads bytes once through the native command and words an online-only refusal plainly", async () => {
    invoke.mockResolvedValueOnce(new Uint8Array([7, 8]).buffer);
    expect(Array.from(await readVaultBytes("/vault/a.css", 64, true))).toEqual([7, 8]);
    expect(invoke).toHaveBeenCalledWith("vault_read_bytes", { path: "/vault/a.css", maxBytes: 64, requireComplete: true });
    invoke.mockRejectedValueOnce("online-only: Download it to this device first.");
    await expect(readVaultBytes("/vault/cloud.html", 64, true)).rejects.toThrow(/^Download it to this device first\.$/);
  });

  it("slices the in-memory demo file outside the native app", async () => {
    const got = await readVaultRange(file("/demo/a.bin"), 5, 5);
    expect(new TextDecoder().decode(got.bytes)).toBe("bytes");
    expect(got.size).toBe(15);
    expect(invoke).not.toHaveBeenCalled();
  });
});
