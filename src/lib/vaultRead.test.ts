// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * `readVaultText` reads a batch of vault files in ONE IPC round-trip
 * (`vault_read_text`, src-tauri/src/vaultread.rs) instead of one invoke per
 * file — ~2,400 per vault open on the reference vault, and on Windows each of
 * those is a UI-thread message-pump item plus a forced paint invalidation.
 *
 * The properties pinned here are the ones whose failure would be SILENT: a
 * result zipped back onto the wrong file, or a native failure that loses the
 * batch instead of degrading to the per-file path.
 */

const ROOT = "/vault";

let invokeCalls: { cmd: string; args: unknown }[] = [];
let perFileReads: string[] = [];
/** Set by each test to control what the native command does. */
let nativeBehaviour: (rels: string[]) => ArrayBuffer | Promise<never> = () => {
  throw new Error("not configured");
};

const READ_FAILED = 0xffffffff;

/** Frame bytes exactly as `vaultread.rs` `encode` does. */
function frame(entries: (string | null)[]): ArrayBuffer {
  const bodies = entries.map((e) =>
    e === null ? null : new TextEncoder().encode(e)
  );
  const total = bodies.reduce((n, b) => n + 4 + (b?.length ?? 0), 4);
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  view.setUint32(0, bodies.length, true);
  let at = 4;
  for (const body of bodies) {
    if (body === null) {
      view.setUint32(at, READ_FAILED, true);
      at += 4;
      continue;
    }
    view.setUint32(at, body.length, true);
    at += 4;
    bytes.set(body, at);
    at += body.length;
  }
  return buf;
}

vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: async () => [],
  stat: async () => ({ size: 0, mtime: new Date(0) }),
  readTextFile: async (path: string) => {
    perFileReads.push(path);
    if (path.includes("unreadable")) throw new Error("read failed");
    // Deliberately staggered: a fallback that placed results by completion
    // order instead of by index would pass with uniform latency.
    await new Promise((r) => setTimeout(r, path.includes("slow") ? 5 : 0));
    if (path.includes("empty")) return "";
    return `per-file:${path}`;
  },
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
    return nativeBehaviour((args?.rels as string[]) ?? []);
  },
}));

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
const { MAX_TEXT_CACHE_FILE_BYTES } = await import("./textCachePlan");
const { readVaultText, readVaultTextOptional, readNoteResult, VAULT_TEXT_CHUNK } = await import("./vault");

const files = (...rels: string[]) =>
  rels.map((relPath) => ({
    relPath,
    path: `${ROOT}/${relPath}`,
    name: relPath,
    ext: "md",
    isMarkdown: true,
  })) as never;

const textFiles = (...defs: Array<[string, number | undefined]>) =>
  defs.map(([relPath, size]) => ({
    relPath,
    path: `${ROOT}/${relPath}`,
    name: relPath,
    ext: relPath.split(".").pop() ?? "txt",
    isMarkdown: false,
    size,
  })) as never;

beforeEach(() => {
  invokeCalls = [];
  perFileReads = [];
});

describe("readVaultText", () => {
  it("distinguishes an unreadable file from a real empty file", async () => {
    const unreadable = await readNoteResult(files("unreadable.md")[0]);
    const readable = await readNoteResult(files("empty.md")[0]);
    expect(unreadable).toEqual({ ok: false, text: "" });
    expect(readable).toEqual({ ok: true, text: "" });
  });

  it("reads a whole batch in ONE round-trip", async () => {
    nativeBehaviour = (rels) => frame(rels.map((r) => `body of ${r}`));
    const texts = await readVaultText(ROOT, files("a.md", "b.md", "c.md"));
    expect(texts).toEqual(["body of a.md", "body of b.md", "body of c.md"]);
    expect(invokeCalls).toHaveLength(1);
    expect(invokeCalls[0].cmd).toBe("vault_read_text");
    expect(perFileReads).toEqual([]);
  });

  it("passes vault-relative paths, not absolute ones", async () => {
    // The Rust side joins them under `root` and re-validates traversal; sending
    // absolute paths would make every read fail.
    nativeBehaviour = (rels) => frame(rels.map(() => ""));
    await readVaultText(ROOT, files("deep/inner/note.md"));
    expect(invokeCalls[0].args).toEqual({
      root: ROOT,
      rels: ["deep/inner/note.md"],
      maxTextFileBytes: MAX_TEXT_CACHE_FILE_BYTES,
    });
  });

  it("keeps results aligned with the requested order", async () => {
    nativeBehaviour = (rels) => frame(rels.map((r) => `T:${r}`));
    const texts = await readVaultText(ROOT, files("z.md", "a.md", "m.md"));
    expect(texts).toEqual(["T:z.md", "T:a.md", "T:m.md"]);
  });

  it("maps an unreadable file to the empty string readNote always returned", async () => {
    nativeBehaviour = () => frame(["kept", null, "also kept"]);
    const texts = await readVaultText(ROOT, files("a.md", "bad.md", "c.md"));
    expect(texts).toEqual(["kept", "", "also kept"]);
  });

  it("preserves unreadable slots for cache hydration callers", async () => {
    nativeBehaviour = () => frame(["kept", null, "also kept"]);
    const texts = await readVaultTextOptional(ROOT, files("a.md", "bad.md", "c.md"));
    expect(texts).toEqual(["kept", null, "also kept"]);
  });

  it("falls back to per-file reads when the native command is missing", async () => {
    nativeBehaviour = () => Promise.reject(new Error("command not found"));
    const texts = await readVaultText(ROOT, files("a.md", "b.md"));
    expect(texts).toEqual([`per-file:${ROOT}/a.md`, `per-file:${ROOT}/b.md`]);
    expect(perFileReads).toHaveLength(2);
  });

  it("fallback skips a known oversized non-markdown file before reading it", async () => {
    nativeBehaviour = () => Promise.reject(new Error("command not found"));
    const texts = await readVaultTextOptional(
      ROOT,
      textFiles(
        ["small.log", 10],
        ["huge.log", MAX_TEXT_CACHE_FILE_BYTES + 1]
      )
    );
    expect(texts).toEqual([`per-file:${ROOT}/small.log`, null]);
    expect(perFileReads).toEqual([`${ROOT}/small.log`]);
  });

  it("falls back rather than trusting a frame of the wrong length", async () => {
    // A short frame would otherwise shift every file's text onto the wrong
    // path — silent cache corruption, not a visible failure.
    nativeBehaviour = () => frame(["only one"]);
    const texts = await readVaultText(ROOT, files("a.md", "b.md", "c.md"));
    expect(texts).toEqual([
      `per-file:${ROOT}/a.md`,
      `per-file:${ROOT}/b.md`,
      `per-file:${ROOT}/c.md`,
    ]);
  });

  it("falls back rather than trusting a truncated frame", async () => {
    nativeBehaviour = (rels) => {
      const full = new Uint8Array(frame(rels.map((r) => `body of ${r}`)));
      return full.slice(0, full.length - 3).buffer as ArrayBuffer;
    };
    const texts = await readVaultText(ROOT, files("a.md", "b.md"));
    expect(texts).toEqual([`per-file:${ROOT}/a.md`, `per-file:${ROOT}/b.md`]);
  });

  it("the fallback places results by index, not by completion order", async () => {
    nativeBehaviour = () => Promise.reject(new Error("nope"));
    const texts = await readVaultText(ROOT, files("slow.md", "fast.md"));
    expect(texts).toEqual([
      `per-file:${ROOT}/slow.md`,
      `per-file:${ROOT}/fast.md`,
    ]);
  });

  it("an empty batch costs no round-trip at all", async () => {
    nativeBehaviour = () => frame([]);
    expect(await readVaultText(ROOT, files())).toEqual([]);
    expect(invokeCalls).toEqual([]);
  });

  it("the demo vault never reaches the native command", async () => {
    nativeBehaviour = () => {
      throw new Error("must not be called for the demo vault");
    };
    const texts = await readVaultText("mesa://demo", [
      {
        relPath: "Welcome.md",
        path: "mesa://demo/Welcome.md",
        name: "Welcome",
        ext: "md",
        isMarkdown: true,
      },
    ] as never);
    expect(invokeCalls).toEqual([]);
    expect(texts).toHaveLength(1);
  });

  it("the chunk size is what bounds a batch, and it is a real bound", async () => {
    // Peak memory and the decode burst are governed here and nowhere else —
    // the read parallelism itself is chosen natively.
    expect(VAULT_TEXT_CHUNK).toBeGreaterThan(1);
    expect(VAULT_TEXT_CHUNK).toBeLessThanOrEqual(512);
  });
});
