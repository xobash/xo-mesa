// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// One in-memory filesystem behind plugin-fs, plus a recorder for native
// recovery commands. Each test loads vaultRecovery fresh in the mode it needs
// (desktop or browser preview) because IN_TAURI is fixed at module load.
const fsState = vi.hoisted(() => ({
  dirs: new Set<string>(),
  files: new Set<string>(),
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));

function children(dir: string) {
  const prefix = `${dir}/`;
  const names = new Map<string, boolean>();
  for (const path of [...fsState.dirs, ...fsState.files]) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const name = rest.split("/")[0];
    names.set(name, (names.get(name) ?? false) || rest.includes("/") || fsState.dirs.has(prefix + name));
  }
  return [...names].map(([name, isDirectory]) => ({ name, isDirectory, isFile: !isDirectory, isSymlink: false }));
}

vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: async (dir: string) => {
    if (!fsState.dirs.has(dir)) throw new Error(`ENOENT ${dir}`);
    return children(dir);
  },
  exists: async (path: string) => fsState.dirs.has(path) || fsState.files.has(path),
  mkdir: async (path: string) => {
    for (let p = path; p && p !== "/"; p = p.slice(0, p.lastIndexOf("/"))) fsState.dirs.add(p);
  },
  rename: async (from: string, to: string) => {
    if (!fsState.files.has(from) && !fsState.dirs.has(from)) throw new Error(`ENOENT ${from}`);
    for (const set of [fsState.files, fsState.dirs]) {
      for (const path of [...set]) {
        if (path === from || path.startsWith(`${from}/`)) {
          set.delete(path);
          set.add(to + path.slice(from.length));
        }
      }
    }
  },
  stat: async () => ({ mtime: null }),
  readFile: async () => new Uint8Array(),
  writeFile: async () => undefined,
  remove: async () => undefined,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fsState.invoke, convertFileSrc: (p: string) => p }));

type Recovery = typeof import("./vaultRecovery");
type Demo = typeof import("./vaultDemo");

async function load(mode: "desktop" | "browser"): Promise<Recovery & { demo: Demo }> {
  vi.resetModules();
  const w = window as unknown as Record<string, unknown>;
  if (mode === "desktop") w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
  const recovery = await import("./vaultRecovery");
  const demo = await import("./vaultDemo");
  return { ...recovery, demo };
}

function seed(paths: string[]) {
  for (const path of paths) {
    fsState.files.add(path);
    for (let p = path.slice(0, path.lastIndexOf("/")); p && p !== "/"; p = p.slice(0, p.lastIndexOf("/"))) fsState.dirs.add(p);
  }
}

const entry = (trashRelPath: string, originalRelPath = "a.md") => ({ trashRelPath, originalRelPath, name: originalRelPath, isDirectory: false });

beforeEach(() => {
  fsState.dirs = new Set(["/vault"]);
  fsState.files = new Set();
  fsState.invoke.mockReset();
  fsState.invoke.mockResolvedValue(undefined);
});

describe("purgeRecoveryEntry", () => {
  it("asks native to purge a listed recovery item", async () => {
    const { purgeRecoveryEntry } = await load("desktop");
    await purgeRecoveryEntry("/vault", entry(".mesa-trash/123/a.md"));
    await purgeRecoveryEntry("/vault", entry("Notes/.mesa-trash/123-b.md", "Notes/b.md"));
    expect(fsState.invoke.mock.calls).toEqual([
      ["vault_purge_recovery", { root: "/vault", trashRelPath: ".mesa-trash/123/a.md" }],
      ["vault_purge_recovery", { root: "/vault", trashRelPath: "Notes/.mesa-trash/123-b.md" }],
    ]);
  });

  it("refuses any path that is not strictly inside a recovery folder", async () => {
    const { purgeRecoveryEntry } = await load("desktop");
    for (const bad of [
      "Notes/a.md",
      ".mesa-trash",
      "Notes/.mesa-trash",
      ".mesa-trash/../Notes/a.md",
      ".mesa-trash/./a.md",
      ".mesa-trash//a.md",
      ".mesa-trash/123\\a.md",
      ".mesa-trash/C:/a.md",
    ]) {
      await expect(purgeRecoveryEntry("/vault", entry(bad)), bad).rejects.toThrow("Invalid recovery item path.");
    }
    expect(fsState.invoke).not.toHaveBeenCalled();
  });

  it("does nothing permanent for the demo vault", async () => {
    const { purgeRecoveryEntry, demo } = await load("desktop");
    await purgeRecoveryEntry(demo.DEMO_ROOT, entry(".mesa-trash/1/a.md"));
    expect(fsState.invoke).not.toHaveBeenCalled();
  });

  it("refuses permanent removal outside the desktop app", async () => {
    const { purgeRecoveryEntry } = await load("browser");
    await expect(purgeRecoveryEntry("/vault", entry(".mesa-trash/1/a.md"))).rejects.toThrow(/requires the desktop app/);
    expect(fsState.invoke).not.toHaveBeenCalled();
  });
});

describe("desktop removal and listing", () => {
  it("moves files and folders to recovery natively, never deleting", async () => {
    const { removeFile, removeVaultEntry } = await load("desktop");
    await removeFile("/vault/Notes/a.md");
    await removeVaultEntry("/vault", "/Notes/Sub/");
    await removeVaultEntry("/vault", "///");
    expect(fsState.invoke.mock.calls).toEqual([
      ["vault_move_to_recovery", { path: "/vault/Notes/a.md" }],
      ["vault_move_to_recovery", { path: "/vault/Notes/Sub" }],
    ]);
  });

  it("lists recovery natively and returns nothing for the demo vault", async () => {
    const { listRecoveryEntries, demo } = await load("desktop");
    const listed = [entry(".mesa-trash/1/a.md")];
    fsState.invoke.mockResolvedValueOnce(listed);
    await expect(listRecoveryEntries("/vault")).resolves.toBe(listed);
    await expect(listRecoveryEntries(demo.DEMO_ROOT)).resolves.toEqual([]);
    expect(fsState.invoke).toHaveBeenCalledTimes(1);
  });

  it("restores natively to a free name beside an existing original", async () => {
    const { restoreRecoveryEntry } = await load("desktop");
    seed(["/vault/Notes/a.md", "/vault/Notes/a (1).md"]);
    const file = await restoreRecoveryEntry("/vault", entry(".mesa-trash/1/Notes/a.md", "Notes/a.md"));
    expect(file.relPath).toBe("Notes/a (2).md");
    expect(fsState.invoke).toHaveBeenCalledWith("vault_restore_recovery", {
      root: "/vault",
      trashRelPath: ".mesa-trash/1/Notes/a.md",
      targetRelPath: "Notes/a (2).md",
    });
  });

  it("skips crash recovery for the demo vault", async () => {
    const { recoverWriteArtifacts, demo } = await load("desktop");
    await expect(recoverWriteArtifacts(demo.DEMO_ROOT)).resolves.toEqual({ restored: [], removed: [] });
    expect(fsState.invoke).not.toHaveBeenCalled();
  });
});

describe("demo vault removal", () => {
  it("removes a demo file and a demo folder subtree from memory", async () => {
    const { removeFile, removeVaultEntry, demo } = await load("browser");
    demo.DEMO["Zz/one.md"] = "1";
    demo.DEMO["Zz/Deep/two.md"] = "2";
    demo.DEMO["Zzz.md"] = "3";
    demo.DEMO["Solo.md"] = "4";
    await removeFile(`${demo.DEMO_ROOT}/Solo.md`);
    await removeVaultEntry(demo.DEMO_ROOT, "Zz");
    expect(demo.DEMO["Solo.md"]).toBeUndefined();
    expect(demo.DEMO["Zz/one.md"]).toBeUndefined();
    expect(demo.DEMO["Zz/Deep/two.md"]).toBeUndefined();
    // A sibling sharing the prefix is not part of the folder.
    expect(demo.DEMO["Zzz.md"]).toBe("3");
    delete demo.DEMO["Zzz.md"];
    expect(fsState.invoke).not.toHaveBeenCalled();
  });
});

describe("browser fallback recovery store", () => {
  it("moves an entry into a timestamped root recovery folder and restores it without replacing", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const { removeVaultEntry, restoreRecoveryEntry } = await load("browser");
    seed(["/vault/Projects/Plan/a.md", "/vault/Projects/Plan/b.md"]);
    await removeVaultEntry("/vault", "Projects/Plan");
    expect([...fsState.files].sort()).toEqual([
      "/vault/.mesa-trash/1000/Projects/Plan/a.md",
      "/vault/.mesa-trash/1000/Projects/Plan/b.md",
    ]);
    // Someone recreated the folder meanwhile: restore picks a free name.
    seed(["/vault/Projects/Plan/new.md"]);
    const restored = await restoreRecoveryEntry("/vault", { trashRelPath: ".mesa-trash/1000/Projects/Plan", originalRelPath: "Projects/Plan", name: "Plan", isDirectory: true });
    expect(restored.relPath).toBe("Projects/Plan (1)");
    expect(fsState.files.has("/vault/Projects/Plan/new.md")).toBe(true);
    expect(fsState.files.has("/vault/Projects/Plan (1)/a.md")).toBe(true);
    vi.restoreAllMocks();
  });

  it("lists root and folder-local recovery items with their original paths", async () => {
    const { listRecoveryEntries } = await load("browser");
    seed([
      "/vault/.mesa-trash/1000/Projects/Plan/a.md",
      "/vault/.mesa-trash/2000/Top.md",
      "/vault/Notes/.mesa-trash/3000-remote--Synced.md",
      "/vault/Notes/.mesa-trash/4000-Local.md",
      "/vault/Notes/.mesa-trash/odd/nested.md",
      "/vault/.hidden/.mesa-trash/5000-Secret.md",
      "/vault/node_modules/.mesa-trash/6000-Dep.md",
    ]);
    const listed = await listRecoveryEntries("/vault");
    expect(listed).toEqual([
      { trashRelPath: "Notes/.mesa-trash/4000-Local.md", originalRelPath: "Notes/Local.md", name: "Local.md", isDirectory: false },
      { trashRelPath: "Notes/.mesa-trash/odd", originalRelPath: "Notes/odd", name: "odd", isDirectory: true },
      { trashRelPath: "Notes/.mesa-trash/3000-remote--Synced.md", originalRelPath: "Notes/Synced.md", name: "Synced.md", isDirectory: false },
      // A root-trash folder chain lists as the deleted entry at its end, as native does.
      { trashRelPath: ".mesa-trash/1000/Projects/Plan/a.md", originalRelPath: "Projects/Plan/a.md", name: "a.md", isDirectory: false },
      { trashRelPath: ".mesa-trash/2000/Top.md", originalRelPath: "Top.md", name: "Top.md", isDirectory: false },
    ]);
  });

  it("returns nothing for an unreadable vault root", async () => {
    const { listRecoveryEntries } = await load("browser");
    await expect(listRecoveryEntries("/missing")).resolves.toEqual([]);
  });

  // Native `vault_list_recovery` descends single-child stamp folders
  // (`deepest_single_entry`, src-tauri/src/vaultops.rs), so a deleted
  // `Notes/a.md` lists as that file. The browser fallback stops at the first
  // folder under the stamp and lists the parent `Notes` as a deleted folder.
  it("browser fallback lists a deleted nested file as that file, as native does", async () => {
    vi.spyOn(Date, "now").mockReturnValue(7000);
    const { removeVaultEntry, listRecoveryEntries } = await load("browser");
    seed(["/vault/Notes/a.md", "/vault/Notes/keep.md"]);
    await removeVaultEntry("/vault", "Notes/a.md");
    const listed = await listRecoveryEntries("/vault");
    vi.restoreAllMocks();
    expect(listed).toEqual([
      { trashRelPath: ".mesa-trash/7000/Notes/a.md", originalRelPath: "Notes/a.md", name: "a.md", isDirectory: false },
    ]);
  });
});
