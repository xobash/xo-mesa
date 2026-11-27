// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VaultFile } from "../types";

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (type: string, data: number[]) => [...be32(data.length), ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
const png = (w: number, h: number, extra: number[] = []) =>
  Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk("IHDR", [...be32(w), ...be32(h), 8, 6, 0, 0, 0]), ...extra, ...chunk("IDAT", [0])]);

const io = vi.hoisted(() => ({
  read: vi.fn(),
  save: vi.fn(async (_job: unknown) => undefined),
  confirm: vi.fn(async (_message: string, _options?: unknown) => true),
  write: vi.fn(async (_root: string, rel: string) => ({ relPath: rel })),
  register: vi.fn(async () => undefined),
  encoded: new Uint8Array(),
}));
vi.mock("../store", () => ({ getStore: () => ({ vaultPath: "/v", files: [{ relPath: "pics/cat.png" }, { relPath: "pics/cat copy.png" }], registerVaultFile: io.register }) }));
vi.mock("../lib/confirmAction", () => ({ confirmAction: io.confirm }));
vi.mock("../lib/vault", () => ({ writeVaultBinaryFile: io.write }));
vi.mock("../lib/documentBytesSave", () => ({ readDocumentBytes: io.read, saveDocumentBytes: io.save, DocumentChangedOnDiskError: class extends Error {} }));
vi.mock("./imageCanvas", () => ({
  decodeImage: async () => ({ naturalWidth: 4, naturalHeight: 2 }),
  drawImagePlan: () => undefined,
  encodeCanvas: async () => io.encoded,
}));
import { ImageEditor } from "./ImageEditor";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const file: VaultFile = { path: "/v/pics/cat.png", relPath: "pics/cat.png", name: "cat", ext: "png", isMarkdown: false };
const original = png(4, 2);
const host = document.createElement("div");
let root: ReturnType<typeof createRoot>;
const dirty = vi.fn();
const onDone = vi.fn();
const button = (label: string) => Array.from(host.querySelectorAll("button")).find((b) => b.textContent === label)!;
const click = (label: string) => act(async () => { button(label).click(); });

beforeEach(async () => {
  io.read.mockResolvedValue(original);
  io.encoded = png(2, 4);
  io.confirm.mockResolvedValue(true);
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<ImageEditor file={file} onDirtyChange={dirty} onDone={onDone} />));
  await vi.waitFor(() => expect(host.textContent).toContain("4 × 2 px"));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllMocks(); });

it("rotates, reports unsaved edits and undoes back to clean", async () => {
  await click("Rotate right");
  expect(host.textContent).toContain("2 × 4 px");
  expect(dirty).toHaveBeenLastCalledWith(true);
  await click("Undo");
  expect(host.textContent).toContain("4 × 2 px");
  expect(dirty).toHaveBeenLastCalledWith(false);
});

it("saves over the original only after the re-encode warning, against the opened bytes", async () => {
  await click("Rotate right");
  io.confirm.mockResolvedValueOnce(false);
  await click("Save");
  expect(io.confirm.mock.calls[0][0]).toContain("metadata");
  expect(io.save).not.toHaveBeenCalled();
  await click("Save");
  expect(io.save).toHaveBeenCalledOnce();
  expect(io.save.mock.calls[0][0]).toMatchObject({ path: "/v/pics/cat.png", bytes: io.encoded, expected: original });
});

it("saves a copy under a new name without touching the original", async () => {
  await click("Flip horizontal");
  await click("Save as copy");
  expect(io.write).toHaveBeenCalledWith("/v", "pics/cat copy 1.png", io.encoded, { expectedMissing: true });
  expect(io.register).toHaveBeenCalledWith("pics/cat copy 1.png");
  expect(io.save).not.toHaveBeenCalled();
  expect(dirty).toHaveBeenLastCalledWith(false);
});

it("asks before Done discards edits", async () => {
  await click("Rotate left");
  io.confirm.mockResolvedValueOnce(false);
  await click("Done");
  expect(onDone).not.toHaveBeenCalled();
  await click("Done");
  expect(onDone).toHaveBeenCalledOnce();
});

it("refuses an animated PNG with the reason and offers no edit tools", async () => {
  await act(async () => root.unmount());
  io.read.mockResolvedValue(png(4, 2, chunk("acTL", [0, 0, 0, 2, 0, 0, 0, 0])));
  root = createRoot(host);
  await act(async () => root.render(<ImageEditor file={{ ...file, path: "/v/pics/anim.png" }} onDirtyChange={dirty} onDone={onDone} />));
  await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain("animated"));
  expect(button("Rotate right")).toBeUndefined();
});

it("locks the edit buttons while a save writes, so the saved image cannot drop a newer edit", async () => {
  let release!: () => void;
  io.save.mockImplementationOnce(() => new Promise<undefined>((resolve) => { release = () => resolve(undefined); }));
  await click("Rotate right");
  await click("Save");
  await vi.waitFor(() => expect(io.save).toHaveBeenCalled());
  expect(button("Rotate left").disabled).toBe(true);
  expect(button("Flip horizontal").disabled).toBe(true);
  expect(button("Undo").disabled).toBe(true);
  await act(async () => { release(); });
  await vi.waitFor(() => expect(button("Rotate left").disabled).toBe(false));
});

it("keeps the editor and its edits when a later reload cannot read the file", async () => {
  await click("Rotate right");
  io.read.mockRejectedValueOnce(new Error("busy"));
  await act(async () => root.render(<ImageEditor file={{ ...file, mtime: 99 }} onDirtyChange={dirty} onDone={onDone} />));
  await vi.waitFor(() => expect(io.read).toHaveBeenCalledTimes(2));
  await act(async () => undefined);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain("2 × 4 px");
  expect(host.textContent).toContain("Could not reload");
  expect(button("Undo")).toBeDefined();
});
