import { expect, it, vi } from "vitest";
import { DocumentChangedOnDiskError, saveDocumentBytes } from "./documentBytesSave";
import type { VerifiedWriteFs } from "./verifiedWrite";

const fs = (atomicWrite: VerifiedWriteFs["atomicWrite"]): VerifiedWriteFs => ({
  readFile: vi.fn(), writeFile: vi.fn(), remove: vi.fn(), exists: vi.fn(), atomicWrite,
});

it("passes the opened bytes as the precondition and validates before writing", async () => {
  const write = vi.fn(async () => undefined);
  const validate = vi.fn();
  const expected = new Uint8Array([1]);
  await saveDocumentBytes({ path: "/v/a.rtf", bytes: new Uint8Array([2]), expected, kind: "RTF file", validate }, fs(write), true);
  expect(validate).toHaveBeenCalledOnce();
  expect(write).toHaveBeenCalledWith("/v/a.rtf", new Uint8Array([2]), expected);
});

it("turns the native changed-on-disk refusal into a plain message that keeps edits", async () => {
  const write = vi.fn(async () => { throw new Error("Current file bytes changed before the verified write."); });
  const job = { path: "/v/a.png", bytes: new Uint8Array([2]), kind: "image" };
  await expect(saveDocumentBytes({ ...job, expected: new Uint8Array([1]) }, fs(write), true)).rejects.toThrow(DocumentChangedOnDiskError);
  await expect(saveDocumentBytes({ ...job, expected: null }, fs(write), true)).rejects.toThrow(/nothing was overwritten/);
});

it("never writes from the browser demo or after a failed validation", async () => {
  const write = vi.fn(async () => undefined);
  await expect(saveDocumentBytes({ path: "/v/a", bytes: new Uint8Array(), expected: null, kind: "image" }, fs(write), false)).rejects.toThrow(/browser demo/);
  await expect(saveDocumentBytes({ path: "/v/a", bytes: new Uint8Array(), expected: null, kind: "image", validate: () => { throw new Error("bad"); } }, fs(write), true)).rejects.toThrow();
  expect(write).not.toHaveBeenCalled();
});
