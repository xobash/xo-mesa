// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `scanVault` walks the vault over one `readDir` IPC round-trip per directory.
 * These tests pin the two properties that make it fast without changing what it
 * returns: the listing is identical to a depth-first walk (skip rules included),
 * and sibling directories are listed concurrently rather than one at a time.
 */

type Tree = { dirs: Record<string, Tree>; files: string[] };

function dir(files: string[], dirs: Record<string, Tree> = {}): Tree {
  return { dirs, files };
}

// Wide + nested so a sequential walk would serialize many round-trips.
const WIDE = 20;
const tree: Tree = dir(["a.md", "b.txt", ".secret.md"], {
  ".hidden": dir(["ignored.md"]),
  node_modules: dir(["ignored.md"]),
  ".git": dir(["ignored.md"]),
  ...Object.fromEntries(
    Array.from({ length: WIDE }, (_, i) => [
      `d${i}`,
      dir(["note.md"], { sub: dir(["deep.markdown"]) }),
    ])
  ),
});

const ROOT = "/vault";

function lookup(path: string): Tree | null {
  const rel = path.slice(ROOT.length).split("/").filter(Boolean);
  let node: Tree = tree;
  for (const part of rel) {
    const child: Tree | undefined = node.dirs[part];
    if (!child) return null;
    node = child;
  }
  return node;
}

let inFlight = 0;
let maxInFlight = 0;
let readDirCalls = 0;

vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: async (path: string) => {
    readDirCalls++;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // A real readDir is an async IPC hop; yielding here lets concurrent
    // listings overlap the way they do in the shell.
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    const node = lookup(path);
    if (!node) throw new Error(`ENOENT ${path}`);
    return [
      ...node.files.map((name) => ({ name, isFile: true, isDirectory: false })),
      ...Object.keys(node.dirs).map((name) => ({
        name,
        isFile: false,
        isDirectory: true,
      })),
    ];
  },
  stat: async () => ({ size: 10, mtime: new Date(0) }),
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
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p }));

// `IN_TAURI` is captured when vault.ts is evaluated, and a non-Tauri scan short
// -circuits to the demo vault — so mark the shell present before importing.
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
const { scanVault } = await import("./vault");

/** What a plain depth-first walk of the same tree yields, sorted the same way. */
function expectedRelPaths(): string[] {
  const out: string[] = [];
  const visit = (node: Tree, prefix: string) => {
    for (const f of node.files) {
      if (f.startsWith(".")) continue;
      out.push(prefix + f);
    }
    for (const [name, child] of Object.entries(node.dirs)) {
      if (name.startsWith(".") || name === "node_modules") continue;
      visit(child, `${prefix}${name}/`);
    }
  };
  visit(tree, "");
  return out.sort((a, b) => a.localeCompare(b));
}

describe("scanVault", () => {
  beforeEach(() => {
    inFlight = 0;
    maxInFlight = 0;
    readDirCalls = 0;
  });

  it("lists every visible file, sorted by relPath", async () => {
    const files = await scanVault(ROOT);
    expect(files.map((f) => f.relPath)).toEqual(expectedRelPaths());
    expect(files).toHaveLength(2 + WIDE * 2);
  });

  it("skips dot-prefixed names, node_modules and .git", async () => {
    const rels = (await scanVault(ROOT)).map((f) => f.relPath);
    expect(rels).not.toContain(".secret.md");
    expect(rels.some((r) => r.startsWith(".hidden/"))).toBe(false);
    expect(rels.some((r) => r.startsWith("node_modules/"))).toBe(false);
    expect(rels.some((r) => r.startsWith(".git/"))).toBe(false);
  });

  it("populates path, name, ext and isMarkdown", async () => {
    const files = await scanVault(ROOT);
    const deep = files.find((f) => f.relPath === "d0/sub/deep.markdown");
    expect(deep).toMatchObject({
      path: "/vault/d0/sub/deep.markdown",
      name: "deep",
      ext: "markdown",
      isMarkdown: true,
    });
    expect(files.find((f) => f.relPath === "b.txt")).toMatchObject({
      isMarkdown: false,
    });
  });

  it("lists sibling directories concurrently", async () => {
    await scanVault(ROOT);
    // A sequential walk would never have two listings open at once.
    expect(readDirCalls).toBe(1 + WIDE * 2);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("skips unreadable directories without failing the scan", async () => {
    const files = await scanVault("/vault/missing");
    expect(files).toEqual([]);
  });
});
