// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = "/vault";
const STALE_MS = 120_000;

type Entry = {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
};

let directories = new Map<string, Entry[]>();
let files = new Map<string, Uint8Array>();
let mtimes = new Map<string, number>();
let lockedRemovals = new Set<string>();
let failedRenames = new Set<string>();
let createNewFailures = new Set<string>();
let createNewInterlopers = new Map<string, Uint8Array>();
let fallbackInterlopers = new Map<string, Uint8Array>();
let fallbackCorruptions = new Map<string, Uint8Array>();
let fallbackCreateCalls: string[] = [];
let unreadableDirectories = new Set<string>();
let readDirCalls = 0;
let removeCalls = 0;
let mkdirCalls: string[] = [];
let inFlight = 0;
let peakInFlight = 0;
let cancelAfterReadDirs: number | null = null;
let cancelled = false;

function pathIn(dir: string, name: string): string {
  return `${dir}/${name}`.replace(/\/+/g, "/");
}

function addDirectory(parent: string, name: string): string {
  const path = pathIn(parent, name);
  directories.get(parent)?.push({ name, isFile: false, isDirectory: true });
  directories.set(path, []);
  return path;
}

function addFile(
  dir: string,
  name: string,
  options: { mtime?: number; bytes?: number[] } = {}
): string {
  const path = pathIn(dir, name);
  directories.get(dir)?.push({ name, isFile: true, isDirectory: false });
  files.set(path, new Uint8Array(options.bytes ?? [1, 2, 3]));
  if (options.mtime !== undefined) mtimes.set(path, options.mtime);
  return path;
}

function artifactName(
  target: string,
  label: "save" | "backup" | "rescue",
  id: string,
  timestamp = 100
): string {
  return `.${target}.mesa-${label}-${timestamp}-${id}.tmp`;
}

function recoveryArtifactPaths(
  target: string,
  label: "backup" | "rescue"
): string[] {
  const marker = `/.${target}.mesa-${label}-`;
  return [...files.keys()].filter((path) => path.includes(marker));
}

vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: async (path: string) => {
    readDirCalls++;
    inFlight++;
    peakInFlight = Math.max(peakInFlight, inFlight);
    if (cancelAfterReadDirs !== null && readDirCalls >= cancelAfterReadDirs) {
      cancelled = true;
    }
    try {
      // Model an asynchronous IPC round-trip so sibling listings overlap.
      await Promise.resolve();
      if (unreadableDirectories.has(path)) throw new Error(`EACCES ${path}`);
      const entries = directories.get(path);
      if (!entries) throw new Error(`ENOENT ${path}`);
      return entries.map((entry) => ({ ...entry }));
    } finally {
      inFlight--;
    }
  },
  stat: async (path: string) => {
    const mtime = mtimes.get(path);
    if (mtime === undefined) throw new Error(`ESTAT ${path}`);
    return { size: files.get(path)?.length ?? 0, mtime: new Date(mtime) };
  },
  readTextFile: async () => "",
  readFile: async (path: string) => {
    const bytes = files.get(path);
    if (!bytes) throw new Error(`ENOENT ${path}`);
    return bytes.slice(0);
  },
  writeFile: async (
    path: string,
    bytes: Uint8Array,
    options?: { createNew?: boolean }
  ) => {
    if (options?.createNew) {
      const interloper = createNewInterlopers.get(path);
      if (interloper) {
        createNewInterlopers.delete(path);
        files.set(path, interloper.slice(0));
        throw new Error(`EEXIST ${path}`);
      }
      if (files.has(path)) throw new Error(`EEXIST ${path}`);
      if (createNewFailures.has(path)) throw new Error(`EWRITE ${path}`);
    }
    files.set(path, bytes.slice(0));
  },
  remove: async (path: string) => {
    removeCalls++;
    if (lockedRemovals.has(path)) throw new Error(`ELOCKED ${path}`);
    files.delete(path);
  },
  rename: async (from: string, to: string) => {
    if (failedRenames.has(from)) throw new Error(`ERENAME ${from}`);
    if (directories.has(from)) {
      const fromPrefix = `${from}/`;
      const toPrefix = `${to}/`;
      const movedDirs = [...directories.entries()].filter(
        ([path]) => path === from || path.startsWith(fromPrefix)
      );
      for (const [path, entries] of movedDirs) {
        const nextPath = path === from ? to : toPrefix + path.slice(fromPrefix.length);
        directories.set(nextPath, entries.map((entry) => ({ ...entry })));
      }
      for (const [path] of movedDirs) directories.delete(path);
      for (const [path, bytes] of [...files.entries()]) {
        if (path.startsWith(fromPrefix)) {
          files.set(toPrefix + path.slice(fromPrefix.length), bytes);
          files.delete(path);
        }
      }
      return;
    }
    const bytes = files.get(from);
    if (!bytes) throw new Error(`ENOENT ${from}`);
    files.set(to, bytes);
    files.delete(from);
  },
  mkdir: async (path: string) => {
    mkdirCalls.push(path);
    directories.set(path, directories.get(path) ?? []);
  },
  exists: async (path: string) => files.has(path) || directories.has(path),
  watch: async () => () => {},
  open: async (
    path: string,
    options?: { write?: boolean; createNew?: boolean }
  ) => {
    if (options?.write && options.createNew) {
      fallbackCreateCalls.push(path);
      const interloper = fallbackInterlopers.get(path);
      if (interloper) {
        fallbackInterlopers.delete(path);
        files.set(path, interloper.slice(0));
        throw new Error(`EEXIST ${path}`);
      }
      if (files.has(path)) throw new Error(`EEXIST ${path}`);
      files.set(path, new Uint8Array());
      return {
        read: async () => 0,
        write: async (bytes: Uint8Array) => {
          const corrupted = fallbackCorruptions.get(path);
          files.set(path, (corrupted ?? bytes).slice(0));
          return bytes.byteLength;
        },
        close: async () => {},
      };
    }
    return { read: async () => 0, close: async () => {} };
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => path }));

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
const { listRecoveryEntries, recoverWriteArtifacts, restoreRecoveryEntry } =
  await import("./vault");

describe("manual recovery storage", () => {
  beforeEach(() => {
    directories = new Map([[ROOT, []]]);
    files = new Map();
    mtimes = new Map();
    unreadableDirectories = new Set();
    readDirCalls = 0;
    removeCalls = 0;
    mkdirCalls = [];
  });

  it("lists root and folder-local recovered files with their original paths", async () => {
    const rootTrash = addDirectory(ROOT, ".mesa-trash");
    const rootBatch = addDirectory(rootTrash, "123");
    const docs = addDirectory(ROOT, "docs");
    const docsTrash = addDirectory(docs, ".mesa-trash");
    addFile(rootBatch, "Deleted.md");
    addFile(docsTrash, "124-Scan.pdf");

    await expect(listRecoveryEntries(ROOT)).resolves.toEqual([
      {
        name: "Deleted.md",
        originalRelPath: "Deleted.md",
        trashRelPath: ".mesa-trash/123/Deleted.md",
        isDirectory: false,
      },
      {
        name: "Scan.pdf",
        originalRelPath: "docs/Scan.pdf",
        trashRelPath: "docs/.mesa-trash/124-Scan.pdf",
        isDirectory: false,
      },
    ]);
  });

  it("lists a deleted folder as one restore entry instead of every nested file", async () => {
    const rootTrash = addDirectory(ROOT, ".mesa-trash");
    const rootBatch = addDirectory(rootTrash, "123");
    const docs = addDirectory(rootBatch, "Docs");
    const nested = addDirectory(docs, "Nested");
    addFile(docs, "Plan.md");
    addFile(nested, "Idea.md");

    await expect(listRecoveryEntries(ROOT)).resolves.toEqual([
      {
        name: "Docs",
        originalRelPath: "Docs",
        trashRelPath: ".mesa-trash/123/Docs",
        isDirectory: true,
      },
    ]);
  });

  it("restores to a unique destination without permanently deleting the stored copy", async () => {
    const rootTrash = addDirectory(ROOT, ".mesa-trash");
    const rootBatch = addDirectory(rootTrash, "123");
    addFile(rootBatch, "Note.md", { bytes: [9] });
    addFile(ROOT, "Note.md", { bytes: [1] });

    const restored = await restoreRecoveryEntry(ROOT, {
      name: "Note.md",
      originalRelPath: "Note.md",
      trashRelPath: ".mesa-trash/123/Note.md",
      isDirectory: false,
    });

    expect(restored.relPath).toBe("Note (1).md");
    expect([...files.keys()].sort()).toEqual(["/vault/Note (1).md", "/vault/Note.md"]);
    expect(removeCalls).toBe(0);
  });

  it("recreates a missing original parent before restoring from a renamed folder", async () => {
    const rootTrash = addDirectory(ROOT, ".mesa-trash");
    const rootBatch = addDirectory(rootTrash, "123");
    const docsTrash = addDirectory(rootBatch, "Docs");
    addFile(docsTrash, "Plan.md", { bytes: [7] });

    const restored = await restoreRecoveryEntry(ROOT, {
      name: "Plan.md",
      originalRelPath: "Docs/Plan.md",
      trashRelPath: ".mesa-trash/123/Docs/Plan.md",
      isDirectory: false,
    });

    expect(restored.relPath).toBe("Docs/Plan.md");
    expect(mkdirCalls).toContain("/vault/Docs");
    expect(files.get("/vault/Docs/Plan.md")).toEqual(new Uint8Array([7]));
  });

  it("restores a deleted folder and its nested contents as one entry", async () => {
    const rootTrash = addDirectory(ROOT, ".mesa-trash");
    const rootBatch = addDirectory(rootTrash, "123");
    const docs = addDirectory(rootBatch, "Docs");
    const nested = addDirectory(docs, "Nested");
    addFile(docs, "Plan.md", { bytes: [4] });
    addFile(nested, "Idea.md", { bytes: [5] });

    const restored = await restoreRecoveryEntry(ROOT, {
      name: "Docs",
      originalRelPath: "Docs",
      trashRelPath: ".mesa-trash/123/Docs",
      isDirectory: true,
    });

    expect(restored.relPath).toBe("Docs");
    expect(directories.has("/vault/Docs/Nested")).toBe(true);
    expect(files.get("/vault/Docs/Plan.md")).toEqual(new Uint8Array([4]));
    expect(files.get("/vault/Docs/Nested/Idea.md")).toEqual(new Uint8Array([5]));
    expect(directories.has("/vault/.mesa-trash/123/Docs")).toBe(false);
  });
});

describe("recoverWriteArtifacts traversal", () => {
  beforeEach(() => {
    directories = new Map([[ROOT, []]]);
    files = new Map();
    mtimes = new Map();
    lockedRemovals = new Set();
    failedRenames = new Set();
    createNewFailures = new Set();
    createNewInterlopers = new Map();
    fallbackInterlopers = new Map();
    fallbackCorruptions = new Map();
    fallbackCreateCalls = [];
    unreadableDirectories = new Set();
    readDirCalls = 0;
    removeCalls = 0;
    mkdirCalls = [];
    inFlight = 0;
    peakInFlight = 0;
    cancelAfterReadDirs = null;
    cancelled = false;
  });

  it("finds the identical visible artifact set with at most 16 directory listings", async () => {
    const now = Date.now();
    const expected: string[] = [];
    for (let i = 0; i < 20; i++) {
      const dir = addDirectory(ROOT, `d${i}`);
      expected.push(
        addFile(dir, artifactName(`note${i}.md`, "save", `r${i}`), {
          mtime: now - STALE_MS,
        })
      );
    }
    const hidden = addDirectory(ROOT, ".hidden");
    const hiddenArtifact = addFile(
      hidden,
      artifactName("hidden.md", "save", "hidden"),
      { mtime: now - STALE_MS }
    );
    const modules = addDirectory(ROOT, "node_modules");
    const moduleArtifact = addFile(
      modules,
      artifactName("module.md", "save", "module"),
      { mtime: now - STALE_MS }
    );

    const result = await recoverWriteArtifacts(ROOT);

    expect(result).toEqual({ restored: [], removed: expected });
    expect(readDirCalls).toBe(21);
    expect(peakInFlight).toBeGreaterThan(1);
    expect(peakInFlight).toBeLessThanOrEqual(16);
    expect(files.has(hiddenArtifact)).toBe(true);
    expect(files.has(moduleArtifact)).toBe(true);
  });

  it("preserves fresh, missing-target, rescue, and locked-artifact rules", async () => {
    const now = Date.now();
    const staleSave = addFile(ROOT, artifactName("stale.md", "save", "stale"), {
      mtime: now - STALE_MS,
    });
    const freshSave = addFile(ROOT, artifactName("fresh.md", "save", "fresh"), {
      mtime: now - 1_000,
    });
    const missingBackup = addFile(
      ROOT,
      artifactName("missing.md", "backup", "missing"),
      { mtime: now - STALE_MS, bytes: [7, 8, 9] }
    );
    const existingTarget = addFile(ROOT, "existing.md", { bytes: [4] });
    const existingBackup = addFile(
      ROOT,
      artifactName("existing.md", "backup", "existing"),
      { mtime: now - STALE_MS }
    );
    const rescueTarget = addFile(ROOT, "rescue.md", { bytes: [5] });
    const keptRescue = addFile(
      ROOT,
      artifactName("rescue.md", "rescue", "kept"),
      { mtime: now - STALE_MS, bytes: [6] }
    );
    const missingRescue = addFile(
      ROOT,
      artifactName("restore.md", "rescue", "restore"),
      { mtime: now - STALE_MS, bytes: [10, 11] }
    );
    const locked = addFile(ROOT, artifactName("locked.md", "save", "locked"), {
      mtime: now - STALE_MS,
    });
    lockedRemovals.add(locked);
    const syncTemp = addFile(ROOT, ".mesa-sync-tmp-77-note.md", {
      mtime: now - STALE_MS,
    });
    const broken = addDirectory(ROOT, "broken");
    unreadableDirectories.add(broken);

    const result = await recoverWriteArtifacts(ROOT);

    expect(result).toEqual({
      restored: [pathIn(ROOT, "missing.md"), pathIn(ROOT, "restore.md")],
      removed: [staleSave, existingBackup, syncTemp],
    });
    expect(files.get(pathIn(ROOT, "missing.md"))).toEqual(
      new Uint8Array([7, 8, 9])
    );
    expect(files.get(pathIn(ROOT, "restore.md"))).toEqual(
      new Uint8Array([10, 11])
    );
    expect(files.has(missingBackup)).toBe(false);
    expect(files.has(missingRescue)).toBe(false);
    expect(files.has(freshSave)).toBe(true);
    expect(files.has(keptRescue)).toBe(true);
    expect(files.has(locked)).toBe(true);
    expect(files.get(existingTarget)).toEqual(new Uint8Array([4]));
    expect(files.get(rescueTarget)).toEqual(new Uint8Array([5]));
  });

  it("restores only the newest backup and preserves older backup copies", async () => {
    const now = Date.now();
    const older = addFile(
      ROOT,
      artifactName("many.md", "backup", "z9", 100),
      { mtime: now - STALE_MS, bytes: [1] }
    );
    const sameTimeLowerId = addFile(
      ROOT,
      artifactName("many.md", "backup", "a1", 300),
      { mtime: now - STALE_MS, bytes: [2] }
    );
    const selected = addFile(
      ROOT,
      artifactName("many.md", "backup", "b2", 300),
      { mtime: now - STALE_MS, bytes: [3] }
    );

    const result = await recoverWriteArtifacts(ROOT);

    expect(result).toEqual({
      restored: [pathIn(ROOT, "many.md")],
      removed: [],
    });
    expect(files.get(pathIn(ROOT, "many.md"))).toEqual(new Uint8Array([3]));
    expect(files.has(selected)).toBe(false);
    expect(files.has(older)).toBe(true);
    expect(files.has(sameTimeLowerId)).toBe(true);
    expect(recoveryArtifactPaths("many.md", "rescue")).toEqual([]);
  });

  it("restores a rescue before a newer backup and preserves the backup", async () => {
    const now = Date.now();
    const backup = addFile(
      ROOT,
      artifactName("priority.md", "backup", "z9", 900),
      { mtime: now - STALE_MS, bytes: [9] }
    );
    const rescue = addFile(
      ROOT,
      artifactName("priority.md", "rescue", "a1", 100),
      { mtime: now - STALE_MS, bytes: [4] }
    );

    const result = await recoverWriteArtifacts(ROOT);

    expect(result.restored).toEqual([pathIn(ROOT, "priority.md")]);
    expect(files.get(pathIn(ROOT, "priority.md"))).toEqual(
      new Uint8Array([4])
    );
    expect(files.has(rescue)).toBe(false);
    expect(files.has(backup)).toBe(true);
  });

  it("does not overwrite a target created after discovery", async () => {
    const now = Date.now();
    const backup = addFile(
      ROOT,
      artifactName("raced.md", "backup", "race"),
      { mtime: now - STALE_MS, bytes: [7, 8, 9] }
    );
    const target = pathIn(ROOT, "raced.md");
    createNewInterlopers.set(target, new Uint8Array([4, 5, 6]));

    const result = await recoverWriteArtifacts(ROOT);

    expect(result).toEqual({ restored: [], removed: [] });
    expect(files.get(target)).toEqual(new Uint8Array([4, 5, 6]));
    expect(files.has(backup)).toBe(true);
    expect(fallbackCreateCalls).not.toContain(target);
    const rescues = recoveryArtifactPaths("raced.md", "rescue");
    expect(rescues).toHaveLength(1);
    expect(files.get(rescues[0])).toEqual(new Uint8Array([7, 8, 9]));
  });

  it("keeps recoverable bytes when the create-new fallback is corrupted", async () => {
    const now = Date.now();
    const backup = addFile(
      ROOT,
      artifactName("corrupt.md", "backup", "fallback"),
      { mtime: now - STALE_MS, bytes: [8, 9] }
    );
    const target = pathIn(ROOT, "corrupt.md");
    createNewFailures.add(target);
    fallbackCorruptions.set(target, new Uint8Array([0, 0]));

    const result = await recoverWriteArtifacts(ROOT);

    expect(result).toEqual({ restored: [], removed: [] });
    expect(fallbackCreateCalls).toContain(target);
    expect(files.get(target)).toEqual(new Uint8Array([0, 0]));
    expect(files.has(backup)).toBe(true);
    const rescues = recoveryArtifactPaths("corrupt.md", "rescue");
    expect(rescues).toHaveLength(1);
    expect(files.get(rescues[0])).toEqual(new Uint8Array([8, 9]));
  });

  it("does not overwrite a target created during the create-new fallback", async () => {
    const now = Date.now();
    const backup = addFile(
      ROOT,
      artifactName("fallback-race.md", "backup", "race"),
      { mtime: now - STALE_MS, bytes: [2, 3] }
    );
    const target = pathIn(ROOT, "fallback-race.md");
    createNewFailures.add(target);
    fallbackInterlopers.set(target, new Uint8Array([6, 7]));

    const result = await recoverWriteArtifacts(ROOT);

    expect(result).toEqual({ restored: [], removed: [] });
    expect(fallbackCreateCalls).toContain(target);
    expect(files.get(target)).toEqual(new Uint8Array([6, 7]));
    expect(files.has(backup)).toBe(true);
    const rescues = recoveryArtifactPaths("fallback-race.md", "rescue");
    expect(rescues).toHaveLength(1);
    expect(files.get(rescues[0])).toEqual(new Uint8Array([2, 3]));
  });

  it("stops scheduling listings and applies no partial recovery plan", async () => {
    const now = Date.now();
    const artifacts: string[] = [];
    for (let i = 0; i < 24; i++) {
      const dir = addDirectory(ROOT, `d${i}`);
      artifacts.push(
        addFile(dir, artifactName(`note${i}.md`, "save", `c${i}`), {
          mtime: now - STALE_MS,
        })
      );
    }
    cancelAfterReadDirs = 3;

    const result = await recoverWriteArtifacts(ROOT, () => cancelled);

    expect(result).toEqual({ restored: [], removed: [] });
    expect(readDirCalls).toBe(3);
    expect(removeCalls).toBe(0);
    expect(artifacts.every((path) => files.has(path))).toBe(true);
  });
});

// The artifact list now normally arrives from `vault_scan`, which already walks
// every directory for the listing. Recovery's own walk cost one `read_dir` IPC
// round-trip PER DIRECTORY on every vault open — 153 on the reference vault,
// 96% of the whole pre-paint round-trip budget — and found nothing whenever the
// previous session shut down cleanly. These pin that the pre-discovered path
// reaches identical decisions while issuing no listings, and that the walk
// survives as the fallback.
describe("recoverWriteArtifacts with a pre-discovered artifact list", () => {
  beforeEach(() => {
    directories = new Map([[ROOT, []]]);
    files = new Map();
    mtimes = new Map();
    lockedRemovals = new Set();
    failedRenames = new Set();
    createNewFailures = new Set();
    createNewInterlopers = new Map();
    fallbackInterlopers = new Map();
    fallbackCorruptions = new Map();
    fallbackCreateCalls = [];
    unreadableDirectories = new Set();
    readDirCalls = 0;
    removeCalls = 0;
    inFlight = 0;
    peakInFlight = 0;
    cancelAfterReadDirs = null;
    cancelled = false;
  });

  it("issues no directory listings at all", async () => {
    const now = Date.now();
    const stale = addFile(ROOT, artifactName("stale.md", "save", "s1"), {
      mtime: now - STALE_MS,
    });

    const result = await recoverWriteArtifacts(ROOT, undefined, [
      { dir: ROOT, name: artifactName("stale.md", "save", "s1") },
    ]);

    expect(readDirCalls).toBe(0);
    expect(result).toEqual({ restored: [], removed: [stale] });
    expect(files.has(stale)).toBe(false);
  });

  it("reaches the same decisions the walk would, including a restore", async () => {
    const now = Date.now();
    const nested = addDirectory(ROOT, "notes");
    // Target missing → the backup holds the only copy and must be restored.
    const backup = addFile(nested, artifactName("gone.md", "backup", "b1"), {
      mtime: now - STALE_MS,
      bytes: [7, 8, 9],
    });
    // Target present → a stale backup is redundant and is removed.
    addFile(nested, "kept.md", { mtime: now - STALE_MS });
    const redundant = addFile(nested, artifactName("kept.md", "backup", "b2"), {
      mtime: now - STALE_MS,
    });
    // Too young to touch: another Mesa may be mid-save right now.
    const fresh = addFile(nested, artifactName("busy.md", "save", "b3"), {
      mtime: now,
    });

    const discovered = [
      { dir: nested, name: artifactName("gone.md", "backup", "b1") },
      { dir: nested, name: artifactName("kept.md", "backup", "b2") },
      { dir: nested, name: artifactName("busy.md", "save", "b3") },
    ];
    const result = await recoverWriteArtifacts(ROOT, undefined, discovered);

    expect(readDirCalls).toBe(0);
    expect(result.restored).toEqual([`${nested}/gone.md`]);
    expect(files.get(`${nested}/gone.md`)).toEqual(new Uint8Array([7, 8, 9]));
    expect(files.has(backup)).toBe(false);
    expect(result.removed).toContain(redundant);
    expect(files.has(fresh)).toBe(true);
  });

  it("walks itself when the scan could not answer", async () => {
    const now = Date.now();
    const stale = addFile(ROOT, artifactName("stale.md", "save", "s2"), {
      mtime: now - STALE_MS,
    });

    // `null` is what `scanVault` reports for the demo vault and for a shell
    // without the native command.
    const result = await recoverWriteArtifacts(ROOT, undefined, null);

    expect(readDirCalls).toBe(1);
    expect(result).toEqual({ restored: [], removed: [stale] });
  });

  it("does nothing when the scan found no artifacts — the normal open", async () => {
    addFile(ROOT, "note.md", { mtime: Date.now() - STALE_MS });

    const result = await recoverWriteArtifacts(ROOT, undefined, []);

    // The whole point: a clean vault open now spends ZERO round-trips here.
    expect(readDirCalls).toBe(0);
    expect(removeCalls).toBe(0);
    expect(result).toEqual({ restored: [], removed: [] });
  });
});
