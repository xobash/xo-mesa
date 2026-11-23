// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";

const taken = vi.hoisted(() => ({ paths: new Set<string>(), probes: 0, all: false }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => path, Channel: class {}, invoke: async () => undefined }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: async () => [], readTextFile: async () => "", writeFile: async () => {}, remove: async () => {},
  rename: async () => {}, mkdir: async () => {}, watch: async () => () => {}, readFile: async () => new Uint8Array(),
  open: async () => ({ read: async () => 0, close: async () => {} }), stat: async () => ({ size: 0, mtime: null, isDirectory: false }),
  exists: async (path: string) => { taken.probes++; return taken.all || taken.paths.has(path); },
}));

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
const { uniqueRel } = await import("./vault");

beforeEach(() => { taken.paths.clear(); taken.probes = 0; taken.all = false; });

it("keeps a free name and numbers a taken one before its extension", async () => {
  expect(await uniqueRel("/v", "a/note.md")).toBe("a/note.md");
  taken.paths.add("/v/a/note.md"); taken.paths.add("/v/a/note (1).md");
  expect(await uniqueRel("/v", "a/note.md")).toBe("a/note (2).md");
});

it("treats a dot-leading name as having no extension", async () => {
  taken.paths.add("/v/a/.env");
  expect(await uniqueRel("/v", "a/.env")).toBe("a/.env (1)");
});

it("ignores a dot in a folder name", async () => {
  taken.paths.add("/v/a.b/file");
  expect(await uniqueRel("/v", "a.b/file")).toBe("a.b/file (1)");
});

it("gives up after a bounded number of probes", async () => {
  taken.all = true;
  await expect(uniqueRel("/v", "n.md")).rejects.toThrow("No free name");
  expect(taken.probes).toBe(10_001);
});
