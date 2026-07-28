import { describe, expect, it } from "vitest";
import { persistVerifiedBytes, type VerifiedWriteFs } from "./verifiedWrite";

function makeFs(initial?: Uint8Array): {
  fs: VerifiedWriteFs;
  files: Map<string, Uint8Array>;
} {
  const files = new Map<string, Uint8Array>();
  if (initial) {
    files.set("/vault/test.bin", initial.slice(0));
  }
  const fs: VerifiedWriteFs = {
    async readFile(path) {
      const found = files.get(path);
      if (!found) throw new Error(`Missing file: ${path}`);
      return found.slice(0);
    },
    async writeFile(path, data) {
      files.set(path, data.slice(0));
    },
    async remove(path) {
      files.delete(path);
    },
    async exists(path) {
      return files.has(path);
    },
  };
  return { fs, files };
}

describe("persistVerifiedBytes", () => {
  it("writes the target bytes and removes temp artifacts", async () => {
    const original = new Uint8Array([1, 2, 3]);
    const next = new Uint8Array([4, 5, 6]);
    const { fs, files } = makeFs(original);

    await persistVerifiedBytes("/vault/test.bin", next, fs, { kind: "file" });

    expect(files.get("/vault/test.bin")).toEqual(next);
    expect([...files.keys()]).toEqual(["/vault/test.bin"]);
  });

  it("checks expected current bytes before touching backup, temp, or target", async () => {
    const original = new Uint8Array([1, 2, 3]);
    const { fs, files } = makeFs(original);
    await expect(
      persistVerifiedBytes("/vault/test.bin", new Uint8Array([9]), fs, {
        expectedCurrentBytes: new Uint8Array([1, 2, 4]),
      })
    ).rejects.toThrow(/changed before the verified write/i);
    expect(files.get("/vault/test.bin")).toEqual(original);
    expect([...files.keys()]).toEqual(["/vault/test.bin"]);
  });

  it("can require a missing target so a late create collision is never overwritten", async () => {
    const original = new Uint8Array([1, 2, 3]);
    const { fs, files } = makeFs(original);
    await expect(
      persistVerifiedBytes("/vault/test.bin", new Uint8Array([9]), fs, {
        expectedCurrentBytes: null,
      })
    ).rejects.toThrow(/expected missing state/i);
    expect(files.get("/vault/test.bin")).toEqual(original);
    expect([...files.keys()]).toEqual(["/vault/test.bin"]);
  });

  it("rechecks expected bytes before commit and preserves a concurrent external rewrite", async () => {
    const original = new Uint8Array([1, 2, 3]);
    const external = new Uint8Array([7, 7, 7]);
    const next = new Uint8Array([9, 9, 9]);
    const { fs, files } = makeFs(original);
    const racingFs: VerifiedWriteFs = {
      ...fs,
      async writeFile(path, data) {
        await fs.writeFile(path, data);
        if (path.includes(".mesa-save-")) {
          files.set("/vault/test.bin", external.slice(0));
        }
      },
    };

    await expect(
      persistVerifiedBytes("/vault/test.bin", next, racingFs, {
        expectedCurrentBytes: original,
      })
    ).rejects.toThrow(/changed before the verified write/i);

    expect(files.get("/vault/test.bin")).toEqual(external);
    expect([...files.keys()]).toEqual(["/vault/test.bin"]);
  });

  it("preserves a concurrent create detected before commit", async () => {
    const external = new Uint8Array([7, 7, 7]);
    const next = new Uint8Array([9, 9, 9]);
    const { fs, files } = makeFs();
    const racingFs: VerifiedWriteFs = {
      ...fs,
      async writeFile(path, data) {
        await fs.writeFile(path, data);
        if (path.includes(".mesa-save-")) {
          files.set("/vault/test.bin", external.slice(0));
        }
      },
    };

    await expect(
      persistVerifiedBytes("/vault/test.bin", next, racingFs, {
        expectedCurrentBytes: null,
      })
    ).rejects.toThrow(/expected missing state/i);

    expect(files.get("/vault/test.bin")).toEqual(external);
    expect([...files.keys()]).toEqual(["/vault/test.bin"]);
  });

  it("preserves an external rewrite when atomic rename fails into fallback", async () => {
    const original = new Uint8Array([1, 2, 3]);
    const external = new Uint8Array([7, 7, 7]);
    const next = new Uint8Array([9, 9, 9]);
    const { fs, files } = makeFs(original);
    const racingFs: VerifiedWriteFs = {
      ...fs,
      async rename() {
        files.set("/vault/test.bin", external.slice(0));
        throw new Error("rename failed");
      },
    };

    await expect(
      persistVerifiedBytes("/vault/test.bin", next, racingFs, {
        expectedCurrentBytes: original,
      })
    ).rejects.toThrow(/changed before the verified write/i);

    expect(files.get("/vault/test.bin")).toEqual(external);
    expect([...files.keys()]).toEqual(["/vault/test.bin"]);
  });

  it("restores the original bytes when the final write reads back truncated", async () => {
    const original = new Uint8Array([1, 2, 3]);
    const next = new Uint8Array([4, 5, 6, 7]);
    const { files } = makeFs(original);
    let targetWrites = 0;
    const fs: VerifiedWriteFs = {
      async readFile(path) {
        const found = files.get(path);
        if (!found) throw new Error(`Missing file: ${path}`);
        return found.slice(0);
      },
      async writeFile(path, data) {
        if (path === "/vault/test.bin") {
          targetWrites++;
          if (targetWrites === 1) {
            files.set(path, data.slice(0, 2));
            return;
          }
        }
        files.set(path, data.slice(0));
      },
      async remove(path) {
        files.delete(path);
      },
      async exists(path) {
        return files.has(path);
      },
    };

    await expect(
      persistVerifiedBytes("/vault/test.bin", next, fs, { kind: "file" })
    ).rejects.toThrow("Final file write verification failed.");
    expect(files.get("/vault/test.bin")).toEqual(original);
    expect([...files.keys()]).toEqual(["/vault/test.bin"]);
  });

  it("removes a newly-created target when verification fails", async () => {
    const next = new Uint8Array([9, 8, 7]);
    const { files } = makeFs();
    const fs: VerifiedWriteFs = {
      async readFile(path) {
        const found = files.get(path);
        if (!found) throw new Error(`Missing file: ${path}`);
        return found.slice(0);
      },
      async writeFile(path, data) {
        if (path === "/vault/test.bin") {
          files.set(path, new Uint8Array());
          return;
        }
        files.set(path, data.slice(0));
      },
      async remove(path) {
        files.delete(path);
      },
      async exists(path) {
        return files.has(path);
      },
    };

    await expect(
      persistVerifiedBytes("/vault/test.bin", next, fs, { kind: "file" })
    ).rejects.toThrow("Final file write verification failed.");
    expect(files.has("/vault/test.bin")).toBe(false);
    expect([...files.keys()]).toEqual([]);
  });

  it("keeps a rescue copy of the original when the rollback itself fails", async () => {
    // A full disk is the realistic case: the same condition that makes the
    // committed target read back wrong also makes the rollback write fail.
    const original = new Uint8Array([1, 2, 3]);
    const next = new Uint8Array([4, 5, 6, 7]);
    const { files } = makeFs(original);
    const fs: VerifiedWriteFs = {
      async readFile(path) {
        const found = files.get(path);
        if (!found) throw new Error(`Missing file: ${path}`);
        return found.slice(0);
      },
      async writeFile(path, data) {
        // Every write to the target lands empty; sibling artifacts are fine.
        if (path === "/vault/test.bin") {
          files.set(path, new Uint8Array());
          return;
        }
        files.set(path, data.slice(0));
      },
      async remove(path) {
        files.delete(path);
      },
      async exists(path) {
        return files.has(path);
      },
    };

    await expect(
      persistVerifiedBytes("/vault/test.bin", next, fs, { kind: "file" })
    ).rejects.toThrow(/original file was preserved at/i);

    // The user's original bytes must still exist somewhere on disk.
    const survivors = [...files.entries()].filter(
      ([, v]) => v.length === original.length && v.every((b, i) => b === original[i])
    );
    expect(survivors).toHaveLength(1);
    const [rescuePath] = survivors[0];
    expect(rescuePath.startsWith("/vault/.test.bin.mesa-rescue-")).toBe(true);
  });

  it("promotes the backup by rename rather than copying it when rescuing", async () => {
    // On a full disk a second copy of a large file would fail too, so the
    // rescue must reuse the bytes already on disk.
    const original = new Uint8Array([1, 2, 3]);
    const next = new Uint8Array([4, 5, 6, 7]);
    const { files } = makeFs(original);
    const written: string[] = [];
    const fs: VerifiedWriteFs = {
      async readFile(path) {
        const found = files.get(path);
        if (!found) throw new Error(`Missing file: ${path}`);
        return found.slice(0);
      },
      async writeFile(path, data) {
        written.push(path);
        if (path === "/vault/test.bin") {
          files.set(path, new Uint8Array());
          return;
        }
        files.set(path, data.slice(0));
      },
      async remove(path) {
        files.delete(path);
      },
      async exists(path) {
        return files.has(path);
      },
      async rename(oldPath, newPath) {
        const data = files.get(oldPath);
        if (!data) throw new Error(`Missing file: ${oldPath}`);
        if (newPath === "/vault/test.bin") {
          // The commit itself is what fails in this scenario.
          files.set(newPath, new Uint8Array());
          files.delete(oldPath);
          return;
        }
        files.set(newPath, data);
        files.delete(oldPath);
      },
    };

    await expect(
      persistVerifiedBytes("/vault/test.bin", next, fs, { kind: "PDF" })
    ).rejects.toThrow(/original PDF was preserved at .*\.mesa-rescue-/);

    const paths = [...files.keys()].filter((p) => p !== "/vault/test.bin");
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain(".mesa-rescue-");
    expect(files.get(paths[0])).toEqual(original);
    // The rescue reused the backup's bytes instead of writing them again.
    expect(written.filter((p) => p.includes(".mesa-rescue-"))).toEqual([]);
  });

  it("keeps the backup itself when even the rescue copy cannot be written", async () => {
    const original = new Uint8Array([1, 2, 3]);
    const next = new Uint8Array([4, 5, 6, 7]);
    const { files } = makeFs(original);
    const fs: VerifiedWriteFs = {
      async readFile(path) {
        const found = files.get(path);
        if (!found) throw new Error(`Missing file: ${path}`);
        return found.slice(0);
      },
      async writeFile(path, data) {
        // Only the backup and temp writes succeed; target and rescue fail.
        if (path === "/vault/test.bin") {
          files.set(path, new Uint8Array());
          return;
        }
        if (path.includes(".mesa-rescue-")) throw new Error("ENOSPC");
        files.set(path, data.slice(0));
      },
      async remove(path) {
        files.delete(path);
      },
      async exists(path) {
        return files.has(path);
      },
    };

    await expect(
      persistVerifiedBytes("/vault/test.bin", next, fs, { kind: "file" })
    ).rejects.toThrow(/original file was preserved at .*\.mesa-backup-/);

    const paths = [...files.keys()].filter((p) => p !== "/vault/test.bin");
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain(".mesa-backup-");
    expect(files.get(paths[0])).toEqual(original);
  });

  it("still cleans up the backup when the rollback succeeds", async () => {
    const original = new Uint8Array([1, 2, 3]);
    const next = new Uint8Array([4, 5, 6, 7]);
    const { files } = makeFs(original);
    let targetWrites = 0;
    const fs: VerifiedWriteFs = {
      async readFile(path) {
        const found = files.get(path);
        if (!found) throw new Error(`Missing file: ${path}`);
        return found.slice(0);
      },
      async writeFile(path, data) {
        if (path === "/vault/test.bin" && ++targetWrites === 1) {
          files.set(path, data.slice(0, 2));
          return;
        }
        files.set(path, data.slice(0));
      },
      async remove(path) {
        files.delete(path);
      },
      async exists(path) {
        return files.has(path);
      },
    };

    await expect(
      persistVerifiedBytes("/vault/test.bin", next, fs, { kind: "file" })
    ).rejects.toThrow("Final file write verification failed.");
    expect(files.get("/vault/test.bin")).toEqual(original);
    // A recovered write leaves no rescue debris behind.
    expect([...files.keys()]).toEqual(["/vault/test.bin"]);
  });

  it("keeps in-flight artifacts dot-prefixed so vault scans never see them", async () => {
    const { fs } = makeFs(new Uint8Array([1]));
    const touched: string[] = [];
    const spyFs: VerifiedWriteFs = {
      ...fs,
      async writeFile(path, data) {
        touched.push(path);
        await fs.writeFile(path, data);
      },
    };
    await persistVerifiedBytes("/vault/test.bin", new Uint8Array([2]), spyFs);
    const artifacts = touched.filter((p) => p !== "/vault/test.bin");
    expect(artifacts.length).toBeGreaterThan(0);
    for (const p of artifacts) {
      expect(p.startsWith("/vault/.test.bin.mesa-")).toBe(true);
      expect(p.endsWith(".tmp")).toBe(true);
    }
  });

  it("commits via atomic rename when the fs supports it (no in-place target rewrite)", async () => {
    const original = new Uint8Array([1, 2, 3]);
    const next = new Uint8Array([4, 5, 6]);
    const { fs, files } = makeFs(original);
    const targetWrites: string[] = [];
    const renames: Array<[string, string]> = [];
    const renameFs: VerifiedWriteFs = {
      ...fs,
      async writeFile(path, data) {
        if (path === "/vault/test.bin") targetWrites.push(path);
        await fs.writeFile(path, data);
      },
      async rename(oldPath, newPath) {
        const data = files.get(oldPath);
        if (!data) throw new Error(`Missing file: ${oldPath}`);
        files.set(newPath, data);
        files.delete(oldPath);
        renames.push([oldPath, newPath]);
      },
    };

    await persistVerifiedBytes("/vault/test.bin", next, renameFs);

    expect(files.get("/vault/test.bin")).toEqual(next);
    expect([...files.keys()]).toEqual(["/vault/test.bin"]);
    expect(targetWrites).toEqual([]); // the target was never truncate+rewritten
    expect(renames).toHaveLength(1);
    expect(renames[0][1]).toBe("/vault/test.bin");
  });

  it("falls back to a verified rewrite when rename fails", async () => {
    const original = new Uint8Array([1, 2, 3]);
    const next = new Uint8Array([4, 5, 6]);
    const { fs, files } = makeFs(original);
    const renameFs: VerifiedWriteFs = {
      ...fs,
      async rename() {
        throw new Error("EXDEV");
      },
    };

    await persistVerifiedBytes("/vault/test.bin", next, renameFs);

    expect(files.get("/vault/test.bin")).toEqual(next);
    expect([...files.keys()]).toEqual(["/vault/test.bin"]);
  });

  it("restores the backup when the renamed-in bytes read back wrong", async () => {
    const original = new Uint8Array([1, 2, 3]);
    const next = new Uint8Array([4, 5, 6]);
    const { fs, files } = makeFs(original);
    const renameFs: VerifiedWriteFs = {
      ...fs,
      async rename(oldPath, newPath) {
        // Simulate a filesystem that corrupts the file during the move.
        files.set(newPath, new Uint8Array([9, 9]));
        files.delete(oldPath);
      },
    };

    await expect(
      persistVerifiedBytes("/vault/test.bin", next, renameFs)
    ).rejects.toThrow("Final file write verification failed.");
    expect(files.get("/vault/test.bin")).toEqual(original);
    expect([...files.keys()]).toEqual(["/vault/test.bin"]);
  });
});
