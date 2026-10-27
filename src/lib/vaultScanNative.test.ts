// @vitest-environment jsdom
/**
 * The NATIVE half of `scanVault` (`vault_scan`, src-tauri/src/vaultscan.rs).
 *
 * `src/lib/vaultScan.test.ts` covers the `readDir` fallback; this file covers
 * the one-round-trip command, and specifically the crash-recovery artifacts it
 * now returns alongside the listing. `recoverWriteArtifacts` used to find those
 * with its own walk — one `read_dir` IPC round-trip PER DIRECTORY, 153 on the
 * reference vault, ahead of the scan and of the first paint, to find nothing at
 * all whenever the previous session shut down cleanly. On Windows each of those
 * round-trips is a UI-thread message plus a forced `RedrawWindow`.
 *
 * The properties pinned here are the ones whose failure would be SILENT: an
 * artifact reported at the wrong absolute path (recovery would then act on a
 * file that is not there), or a listing that quietly loses its artifacts and
 * leaves a user's only surviving copy of a file undiscovered.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const ROOT = "/vault";

let invokeCalls: { cmd: string; args: unknown }[] = [];
let readDirCalls = 0;
/** Set per test to control what `vault_scan` returns. */
let scanResult: unknown = { entries: [], artifacts: [] };

vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: async () => {
    readDirCalls++;
    return [];
  },
  stat: async () => ({ size: 0, mtime: new Date(0) }),
  readTextFile: async () => "",
  readFile: async () => new Uint8Array(),
  writeFile: async () => {},
  remove: async () => {},
  rename: async () => {},
  mkdir: async () => {},
  exists: async () => false,
  watch: async () => () => {},
  open: async () => ({ read: async () => 0, close: async () => {} }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => p,
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    invokeCalls.push({ cmd, args });
    if (typeof scanResult === "function") return (scanResult as () => never)();
    return scanResult;
  },
}));

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
const { scanVault } = await import("./vault");

const entry = (rel: string) => ({ rel, size: 1, mtime: 1_700_000_000_000 });

beforeEach(() => {
  invokeCalls = [];
  readDirCalls = 0;
  scanResult = { entries: [], artifacts: [] };
});

describe("scanVault native path", () => {
  it("lists the vault in ONE round-trip, with no directory listings", async () => {
    scanResult = {
      entries: [entry("b.md"), entry("notes/a.md")],
      artifacts: [],
    };

    const files = await scanVault(ROOT);

    expect(invokeCalls.map((c) => c.cmd)).toEqual(["vault_scan"]);
    expect(readDirCalls).toBe(0);
    expect(files.map((f) => f.relPath)).toEqual(["b.md", "notes/a.md"]);
    // Derived here, never sent over the bridge.
    expect(files[1]).toMatchObject({
      path: `${ROOT}/notes/a.md`,
      name: "a",
      ext: "md",
      isMarkdown: true,
      size: 1,
    });
  });

  it("reports artifacts at absolute paths, with the root's dir empty", async () => {
    scanResult = {
      entries: [entry("note.md")],
      artifacts: [
        { dir: "", name: ".note.md.mesa-backup-1-a.tmp" },
        { dir: "notes/deep", name: ".other.md.mesa-save-2-b.tmp" },
      ],
    };
    let seen: unknown = "never called";

    await scanVault(ROOT, { onArtifacts: (a) => (seen = a) });

    // `joinPath(root, "")` would produce a trailing slash and recovery would
    // then stat, read and remove a path that does not exist.
    expect(seen).toEqual([
      { dir: ROOT, name: ".note.md.mesa-backup-1-a.tmp" },
      { dir: `${ROOT}/notes/deep`, name: ".other.md.mesa-save-2-b.tmp" },
    ]);
  });

  it("re-filters the Rust superset through the frontend matcher", async () => {
    // `looks_like_write_artifact` in vaultscan.rs is deliberately permissive:
    // being wrong in this direction is harmless only because of this filter.
    scanResult = {
      entries: [],
      artifacts: [
        { dir: "", name: ".real.md.mesa-backup-1-a.tmp" },
        { dir: "", name: ".not-an-artifact.mesa-backup-.tmp" },
        { dir: "", name: ".mesa-sync-tmp-9-x" },
      ],
    };
    let seen: { dir: string; name: string }[] | null = null;

    await scanVault(ROOT, { onArtifacts: (a) => (seen = a) });

    expect((seen as unknown as { name: string }[]).map((a) => a.name)).toEqual([
      ".real.md.mesa-backup-1-a.tmp",
      ".mesa-sync-tmp-9-x",
    ]);
  });

  it("reports null — not an empty list — when it cannot answer", async () => {
    // An empty list means "walked, found none" and would SKIP recovery's own
    // sweep. A missing or failed command must degrade to that sweep instead.
    scanResult = () => {
      throw new Error("command not found");
    };
    let seen: unknown = "never called";

    await scanVault(ROOT, { onArtifacts: (a) => (seen = a) });

    expect(seen).toBeNull();
    expect(readDirCalls).toBeGreaterThan(0);
  });

  it("accepts a bare array from a shell on the previous command shape", async () => {
    scanResult = [entry("a.md")];
    let seen: unknown = "never called";

    const files = await scanVault(ROOT, { onArtifacts: (a) => (seen = a) });

    expect(files.map((f) => f.relPath)).toEqual(["a.md"]);
    // No artifact information available, so recovery must still walk.
    expect(seen).toBeNull();
  });

  it("does not publish artifacts for a superseded open", async () => {
    scanResult = {
      entries: [entry("a.md")],
      artifacts: [{ dir: "", name: ".a.md.mesa-backup-1-a.tmp" }],
    };
    let seen: unknown = "never called";

    const files = await scanVault(ROOT, {
      stopped: () => true,
      onArtifacts: (a) => (seen = a),
    });

    // Acting on a superseded vault's artifacts would mutate the wrong vault.
    expect(files).toEqual([]);
    expect(seen).toBe("never called");
  });
});
