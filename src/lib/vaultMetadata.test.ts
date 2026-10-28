import { beforeEach, expect, it, vi } from "vitest";
import type { VaultFile } from "../types";

const io = vi.hoisted(() => ({ load: vi.fn(async (files: readonly VaultFile[], _stopped?: () => boolean) => { for (const file of files) file.size = 1; }) }));
vi.mock("./vault", () => ({
  hasVaultMetadata: (files: readonly VaultFile[]) => files.length > 0 && files.every((file) => file.size !== undefined),
  loadVaultMetadata: io.load,
}));
const { hydrateVaultMetadata } = await import("./vaultMetadata");

const file = (relPath: string, size?: number): VaultFile => ({ path: `/v/${relPath}`, relPath, name: relPath, ext: "md", isMarkdown: true, size });
beforeEach(() => { io.load.mockClear(); });

it("publishes one array replacement after loading fallback metadata", async () => {
  const files = [file("a.md"), file("b.md")];
  let state = { vaultPath: "/v" as string | null, files: files as readonly VaultFile[] };
  const set = vi.fn((patch: Partial<typeof state>) => { state = { ...state, ...patch }; });
  await hydrateVaultMetadata("/v", files, () => true, () => state, set);
  expect(set).toHaveBeenCalledOnce();
  expect(state.files).not.toBe(files);
  expect(state.files.map((f) => f.size)).toEqual([1, 1]);
});

it("skips native-complete listings and empty vaults without stat calls", async () => {
  const set = vi.fn();
  await hydrateVaultMetadata("/v", [file("a.md", 4)], () => true, () => ({ vaultPath: "/v", files: [] }), set);
  await hydrateVaultMetadata("/v", [], () => true, () => ({ vaultPath: "/v", files: [] }), set);
  expect(io.load).not.toHaveBeenCalled();
  expect(set).not.toHaveBeenCalled();
});

it.each([
  ["a superseded open", { current: false, root: "/v", same: true }],
  ["a different root", { current: true, root: "/other", same: true }],
  ["a replaced file list", { current: true, root: "/v", same: false }],
])("never publishes after %s", async (_label, { current, root, same }) => {
  const files = [file("a.md")];
  const set = vi.fn();
  await hydrateVaultMetadata("/v", files, () => current, () => ({ vaultPath: root, files: same ? files : [...files] }), set);
  expect(set).not.toHaveBeenCalled();
  // The stop predicate passed to the loader reflects the open generation.
  expect(io.load.mock.calls[0][1]!()).toBe(!current);
});
