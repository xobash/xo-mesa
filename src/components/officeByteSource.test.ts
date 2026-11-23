import { describe, expect, it, vi } from "vitest";
import { DocumentChangedOnDiskError } from "../lib/documentBytesSave";
import type { OfficeCryptoClient } from "../lib/officeCrypto/client";
import { encryptedSource } from "./officeByteSource";

const b = (...v: number[]) => Uint8Array.from(v);

function fakeClient(): OfficeCryptoClient & { seal: ReturnType<typeof vi.fn>; reopen: ReturnType<typeof vi.fn> } {
  return {
    unlock: vi.fn(),
    reopen: vi.fn(async (enc: Uint8Array) => enc.map((x) => x - 100)),
    seal: vi.fn(async (_template: Uint8Array, plain: Uint8Array) => plain.map((x) => x + 100)),
    dispose: vi.fn(),
  };
}

describe("encrypted byte source", () => {
  const opened = { encrypted: b(101, 102), plain: b(1, 2) };

  it("returns the held package for its own bytes and decrypts newer ones", async () => {
    const client = fakeClient();
    const disk = { bytes: b(101, 102) };
    const source = encryptedSource("/v/a.docx", client, opened, null, { readDisk: async () => disk.bytes, saveDisk: vi.fn() });
    expect(await source.read("/v/a.docx")).toEqual(b(1, 2));
    expect(client.reopen).not.toHaveBeenCalled();
    disk.bytes = b(105);
    expect(await source.read("/v/a.docx")).toEqual(b(5));
  });

  it("writes sealed bytes over the encrypted original and nothing for a no-op", async () => {
    const client = fakeClient();
    const saveDisk = vi.fn(async () => undefined);
    const source = encryptedSource("/v/a.docx", client, opened, null, { readDisk: async () => b(), saveDisk });
    await source.save({ path: "/v/a.docx", bytes: b(1, 2), expected: b(1, 2), kind: "Word document" });
    expect(saveDisk).not.toHaveBeenCalled();
    await source.save({ path: "/v/a.docx", bytes: b(3), expected: b(1, 2), kind: "Word document" });
    expect(saveDisk).toHaveBeenCalledWith(expect.objectContaining({ bytes: b(103), expected: b(101, 102) }));
    // The next save's precondition is the bytes just written.
    await source.save({ path: "/v/a.docx", bytes: b(4), expected: b(3), kind: "Word document" });
    expect(saveDisk).toHaveBeenLastCalledWith(expect.objectContaining({ bytes: b(104), expected: b(103) }));
  });

  it("refuses a save from a stale baseline and any save when read-only", async () => {
    const source = encryptedSource("/v/a.docx", fakeClient(), opened, null, { readDisk: async () => b(), saveDisk: vi.fn() });
    await expect(source.save({ path: "/v/a.docx", bytes: b(3), expected: b(9), kind: "Word document" })).rejects.toBeInstanceOf(DocumentChangedOnDiskError);
    const readOnly = encryptedSource("/v/a.docx", fakeClient(), opened, "Read-only.", { readDisk: async () => b(), saveDisk: vi.fn() });
    await expect(readOnly.save({ path: "/v/a.docx", bytes: b(3), expected: b(1, 2), kind: "Word document" })).rejects.toThrow("Read-only.");
    await expect(readOnly.copyBytes(b(3))).rejects.toThrow("Read-only.");
  });
});
