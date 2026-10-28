// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { zipSync } from "fflate";

const fs = vi.hoisted(() => ({
  sizes: new Map<string, number>(),
  bytes: new Map<string, Uint8Array>(),
  read: [] as string[],
  written: [] as string[],
}));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  Channel: class {},
  invoke: async (command: string, _body: unknown, options?: { headers?: Record<string, string> }) => {
    if (command === "vault_write_atomic") {
      const hex = options!.headers!["x-mesa-path"];
      fs.written.push(new TextDecoder().decode(new Uint8Array(hex.match(/../g)!.map((pair) => parseInt(pair, 16)))));
    }
    return undefined;
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: async () => [], readTextFile: async () => "", writeFile: async () => {}, remove: async () => {},
  rename: async () => {}, mkdir: async () => {}, exists: async () => false, watch: async () => () => {},
  open: async () => ({ read: async () => 0, close: async () => {} }),
  stat: async (path: string) => ({ size: fs.sizes.get(path) ?? fs.bytes.get(path)?.length ?? 0, mtime: null, isDirectory: false }),
  readFile: async (path: string) => { fs.read.push(path); return fs.bytes.get(path) ?? new Uint8Array(); },
}));
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
const { importDroppedPaths, MAX_DROPPED_FILE_BYTES } = await import("./vault");

beforeEach(() => {
  fs.sizes.clear(); fs.bytes.clear(); fs.read = []; fs.written = [];
});

it("refuses an oversized dropped file before reading it and still imports the others", async () => {
  fs.sizes.set("/drop/huge.mov", MAX_DROPPED_FILE_BYTES + 1);
  fs.bytes.set("/drop/note.md", new TextEncoder().encode("# hi"));
  const result = await importDroppedPaths("/vault", ["/drop/huge.mov", "/drop/note.md"]);
  expect(fs.read).not.toContain("/drop/huge.mov");
  expect(result.failures).toEqual([{ name: "huge.mov", message: expect.stringContaining("512 MB import limit") }]);
  expect(result.created.map((file) => file.relPath)).toEqual(["note.md"]);
});

it("refuses a hidden dropped file name instead of importing an invisible file", async () => {
  fs.bytes.set("/drop/.env", new Uint8Array([1]));
  const result = await importDroppedPaths("/vault", ["/drop/.env"]);
  expect(fs.read).toEqual([]);
  expect(result.failures[0]).toMatchObject({ name: ".env", message: expect.stringContaining("Hidden") });
});

it("skips hidden ZIP entries such as .DS_Store and Mesa write artifacts", async () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  fs.bytes.set("/drop/pack.zip", zipSync({
    "a.md": bytes("a"),
    ".DS_Store": bytes("x"),
    "sub/.b.md.mesa-backup-1-ab.tmp": bytes("y"),
    ".hidden/c.md": bytes("z"),
    "__MACOSX/._a.md": bytes("m"),
    "sub/d.md": bytes("d"),
  }));
  const result = await importDroppedPaths("/vault", ["/drop/pack.zip"]);
  expect(result.failures).toEqual([]);
  expect(result.created.map((file) => file.relPath).sort()).toEqual(["pack/a.md", "pack/sub/d.md"]);
  expect(fs.written.sort()).toEqual(["/vault/pack/a.md", "/vault/pack/sub/d.md"]);
});
