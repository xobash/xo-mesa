import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VaultFile } from "../types";
import vaultSource from "./vault.ts?raw";

/**
 * A vault mutation that fails must SAY so.
 *
 * Every action here is something the user explicitly asked for — New note,
 * New folder, Duplicate, Delete (behind a "this cannot be undone" confirm),
 * or a drag-and-drop import. Each does its filesystem work BEFORE touching the
 * store, so a rejection correctly leaves the vault and the UI unchanged — but
 * it used to leave the user with no explanation at all, because every call
 * site invokes these as `void action()` and nothing rendered the rejection.
 * The click simply looked ignored.
 *
 * This is not an exotic path, and least of all on Windows, where a document
 * open in another application, a OneDrive-synced folder, or an antivirus scan
 * holds a lock that makes remove/copy/create throw where the same call
 * succeeds on macOS.
 *
 * `renameNote` and both save paths already reported failures through `status`
 * (rendered by StatusBar in the danger color, role="alert"). These pin the
 * same rule for the rest, and pin that a failure never half-applies to state.
 */

const fsCalls = vi.hoisted(() => ({
  fail: null as string | null,
  created: [] as string[],
  removed: [] as string[],
  copied: [] as string[],
  folders: [] as string[],
  partialImportFailure: null as string | null,
}));

const asFile = (relPath: string, root = "/vault"): VaultFile => {
  const name = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return {
    path: `${root}/${relPath}`,
    relPath,
    name: dot > 0 ? name.slice(0, dot) : name,
    ext,
    isMarkdown: ext === "md" || ext === "markdown",
    size: 0,
    mtime: 0,
  };
};

vi.mock("./vault", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createNote: async (root: string, rel: string) => {
      if (fsCalls.fail) throw new Error(fsCalls.fail);
      fsCalls.created.push(rel);
      return asFile(rel, root);
    },
    createFolder: async (_root: string, rel: string) => {
      if (fsCalls.fail) throw new Error(fsCalls.fail);
      fsCalls.folders.push(rel);
    },
    copyVaultFile: async (root: string, _src: string, dest: string) => {
      if (fsCalls.fail) throw new Error(fsCalls.fail);
      fsCalls.copied.push(dest);
      return asFile(dest, root);
    },
    removeFile: async (path: string) => {
      if (fsCalls.fail) throw new Error(fsCalls.fail);
      fsCalls.removed.push(path);
    },
    removeVaultEntry: async (_root: string, rel: string) => {
      if (fsCalls.fail) throw new Error(fsCalls.fail);
      fsCalls.removed.push(rel);
    },
    importDroppedPaths: async () => {
      if (fsCalls.fail) throw new Error(fsCalls.fail);
      return {
        created: [asFile("dropped.md")],
        failures: fsCalls.partialImportFailure
          ? [{ name: "blocked.pdf", message: fsCalls.partialImportFailure }]
          : [],
      };
    },
    readNote: async () => "",
    selectFile: undefined,
  };
});

import { useAppStore } from "../store";

const initial = useAppStore.getState();

beforeEach(() => {
  fsCalls.fail = null;
  fsCalls.created.length = 0;
  fsCalls.removed.length = 0;
  fsCalls.copied.length = 0;
  fsCalls.folders.length = 0;
  fsCalls.partialImportFailure = null;
  useAppStore.setState(initial, true);
  useAppStore.setState({
    vaultPath: "/vault",
    files: [asFile("a.md"), asFile("docs/Scan.pdf")],
    notes: {},
    contentCache: {},
    openTabs: [],
    activePath: null,
    status: "",
  });
});

/** Windows shape: the file is held open by another process. */
const LOCKED = "The process cannot access the file because it is being used by another process. (os error 32)";

describe("a failed vault mutation is reported, not swallowed", () => {
  it("lets native remove errors reach the store", () => {
    const start = vaultSource.indexOf("export async function removeFile(");
    const end = vaultSource.indexOf("export async function removeVaultEntry(", start);
    const removeFile = vaultSource.slice(start, end);
    expect(removeFile).toContain(".mesa-trash");
    expect(removeFile).toContain("await rename(absPath");
    expect(removeFile).not.toContain("catch");
  });

  it("reports a failed New note instead of resolving silently", async () => {
    fsCalls.fail = LOCKED;
    await useAppStore.getState().newNote();
    const s = useAppStore.getState();
    expect(s.status).toContain("New note failed");
    expect(s.status).toContain("os error 32");
    // Nothing was invented in the sidebar for a note that does not exist.
    expect(s.files.some((f) => /Untitled/.test(f.relPath))).toBe(false);
  });

  it("reports a failed linked-note create instead of dropping the click", async () => {
    fsCalls.fail = "EACCES: permission denied";
    await useAppStore.getState().openTarget("Missing note");

    expect(useAppStore.getState().status).toContain("Create linked note failed");
    expect(fsCalls.created).toEqual([]);
  });

  it("reports a failed daily-note create from the command palette", async () => {
    fsCalls.fail = "EACCES: permission denied";
    await useAppStore.getState().openDailyNote("2026-08-05");

    expect(useAppStore.getState().status).toContain("Open daily note failed");
    expect(fsCalls.created).toEqual([]);
  });

  it("reports a failed New note inside a folder", async () => {
    fsCalls.fail = "EACCES: permission denied";
    await useAppStore.getState().createChildNote("docs");
    const s = useAppStore.getState();
    expect(s.status).toContain("New note failed");
    expect(s.status).toContain("permission denied");
    expect(s.files.some((f) => /Untitled/.test(f.relPath))).toBe(false);
  });

  it("reports a failed New folder and does not add a phantom empty folder", async () => {
    fsCalls.fail = "EROFS: read-only file system";
    await useAppStore.getState().createChildFolder("docs");
    const s = useAppStore.getState();
    expect(s.status).toContain("New folder failed");
    expect(s.emptyFolders).toEqual([]);
  });

  it("reports a failed Duplicate and leaves the file list unchanged", async () => {
    fsCalls.fail = "ENOSPC: no space left on device";
    const before = useAppStore.getState().files.length;
    await useAppStore.getState().duplicateEntry("docs/Scan.pdf");
    const s = useAppStore.getState();
    expect(s.status).toContain("Duplicate failed");
    expect(s.status).toContain("ENOSPC");
    expect(s.files.length).toBe(before);
  });

  it("reports a failed Delete and KEEPS the file, after the user confirmed", async () => {
    fsCalls.fail = LOCKED;
    await useAppStore.getState().deleteEntry("docs/Scan.pdf");
    const s = useAppStore.getState();
    expect(s.status).toContain("Delete failed");
    expect(s.status).toContain("os error 32");
    // The file really is still on disk, so it must still be in the sidebar —
    // and the status must not claim it was deleted.
    expect(s.files.some((f) => f.relPath === "docs/Scan.pdf")).toBe(true);
    expect(s.status).not.toContain("Deleted");
  });

  it("reports a failed Import instead of pinning 'Importing…' forever", async () => {
    fsCalls.fail = "EIO: i/o error";
    await useAppStore.getState().importDropped(["/tmp/x.md"]);
    const s = useAppStore.getState();
    expect(s.status).toContain("Import failed");
    // The transient progress message must not be what the user is left with:
    // it claims work is still in flight when nothing is.
    expect(s.status).not.toContain("Importing");
  });

  it("reports partial import failures without hiding created files", async () => {
    fsCalls.partialImportFailure = "EACCES: permission denied";
    await useAppStore.getState().importDropped(["/tmp/dropped.md", "/tmp/blocked.pdf"]);
    const s = useAppStore.getState();

    expect(s.files.some((file) => file.relPath === "dropped.md")).toBe(true);
    expect(s.status).toContain("Imported 1 file");
    expect(s.status).toContain("1 failed");
    expect(s.status).toContain("blocked.pdf");
  });

  it("returns structured per-source failures from the native import layer", () => {
    const start = vaultSource.indexOf("export async function importDroppedPaths(");
    const end = vaultSource.indexOf("async function placeFile(", start);
    const body = vaultSource.slice(start, end);
    expect(body).toContain("failures.push({ name: base, message: String(error) })");
    expect(body).toContain("return { created, failures }");
  });
});

describe("the success paths are unchanged", () => {
  it("still creates a note and reports no failure", async () => {
    await useAppStore.getState().newNote();
    expect(fsCalls.created).toEqual(["Untitled.md"]);
    expect(useAppStore.getState().status).not.toContain("failed");
  });

  it("still removes a file from the workspace after moving it to recovery storage", async () => {
    await useAppStore.getState().deleteEntry("docs/Scan.pdf");
    const s = useAppStore.getState();
    expect(fsCalls.removed).toEqual(["/vault/docs/Scan.pdf"]);
    expect(s.files.some((f) => f.relPath === "docs/Scan.pdf")).toBe(false);
    expect(s.status).toContain("Moved file docs/Scan.pdf to Mesa recovery storage");
  });

  it("still duplicates a file", async () => {
    await useAppStore.getState().duplicateEntry("docs/Scan.pdf");
    expect(fsCalls.copied).toEqual(["docs/Scan copy.pdf"]);
    expect(useAppStore.getState().status).not.toContain("failed");
  });

  it("still creates a folder", async () => {
    await useAppStore.getState().createChildFolder("docs");
    expect(fsCalls.folders).toEqual(["docs/New folder"]);
    expect(useAppStore.getState().emptyFolders).toEqual(["docs/New folder"]);
  });
});
