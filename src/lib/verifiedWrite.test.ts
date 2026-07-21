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
