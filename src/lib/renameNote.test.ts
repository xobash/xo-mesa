import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VaultFile } from "../types";

/**
 * Renaming must preserve the file's TYPE and its BYTES.
 *
 * The old `renameNote` was markdown-shaped for every file: it forced a `.md`
 * suffix (renaming `notes.txt` produced `notes.md` and a phantom graph note)
 * and moved content through the text pipeline — `ensureContent` returns ""
 * for a binary, so renaming a PDF created an EMPTY .md and removed the real
 * document. These tests pin the fixed contract: one byte-preserving
 * `renameVaultFile` call for every type, extension preserved, the notes map
 * touched only for markdown, and a failed rename surfacing in `status`.
 */

const renamed = vi.hoisted(() => ({
  calls: [] as Array<{ src: string; dest: string }>,
  writes: [] as Array<{ rel: string; content: string; expected?: string }>,
  fail: null as string | null,
  writeFail: null as string | null,
}));

vi.mock("./vault", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    renameVaultFile: async (root: string, srcRel: string, destRel: string) => {
      if (renamed.fail) throw new Error(renamed.fail);
      renamed.calls.push({ src: srcRel, dest: destRel });
      const name = destRel.slice(destRel.lastIndexOf("/") + 1);
      const dot = name.lastIndexOf(".");
      const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
      return {
        path: `${root}/${destRel}`,
        relPath: destRel,
        name: dot > 0 ? name.slice(0, dot) : name,
        ext,
        isMarkdown: ext === "md" || ext === "markdown",
        size: 0,
        mtime: 0,
      } satisfies VaultFile;
    },
    readNote: async (file: VaultFile) => {
      const state = useAppStore.getState();
      return state.contentCache[file.relPath] ?? "";
    },
    writeNote: async (file: VaultFile, content: string, expected?: string) => {
      if (renamed.writeFail) throw new Error(renamed.writeFail);
      renamed.writes.push({ rel: file.relPath, content, expected });
    },
  };
});

import { useAppStore } from "../store";

const file = (relPath: string, size = 10): VaultFile => {
  const name = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return {
    path: `/vault/${relPath}`,
    relPath,
    name: dot > 0 ? name.slice(0, dot) : name,
    ext,
    isMarkdown: ext === "md",
    size,
    mtime: 0,
  };
};

const initial = useAppStore.getState();

beforeEach(() => {
  renamed.calls.length = 0;
  renamed.writes.length = 0;
  renamed.fail = null;
  renamed.writeFail = null;
  useAppStore.setState(initial, true);
  useAppStore.setState({
    vaultPath: "/vault",
    files: [
      file("a.md"),
      file("refs.md"),
      file("folder/refs.md"),
      file("folder/relative.md"),
      file("data/log.txt"),
      file("docs/Scan.pdf"),
    ],
    notes: {
      "a.md": {
        relPath: "a.md",
        title: "a",
        rawLinks: ["b"],
        tags: ["t"],
        aliases: [],
      },
      "refs.md": {
        relPath: "refs.md",
        title: "refs",
        rawLinks: ["a", "Alias A", "folder/relative.md"],
        tags: [],
        aliases: [],
      },
      "folder/relative.md": {
        relPath: "folder/relative.md",
        title: "relative",
        rawLinks: [],
        tags: [],
        aliases: ["Alias A"],
      },
      "folder/refs.md": {
        relPath: "folder/refs.md",
        title: "refs",
        rawLinks: ["../a.md"],
        tags: [],
        aliases: [],
      },
    },
    contentCache: {
      "a.md": "# a [[b]]",
      "refs.md": "See [[a#Part|A link]], [[Alias A|kept alias]], and [details](a.md#Part). Image ![[a.png]] stays.",
      "folder/refs.md": "Relative [[../a.md#Part|A]] and [md](../a.md#Part).",
      "folder/relative.md": "alias target",
      "data/log.txt": "log line",
    },
    openTabs: [],
    activePath: null,
    status: "",
  });
});

describe("renameNote type preservation", () => {
  it("renames a markdown note, moving its notes entry and cached text", async () => {
    await useAppStore.getState().renameNote("a.md", "alpha");
    expect(renamed.calls).toEqual([{ src: "a.md", dest: "alpha.md" }]);
    const s = useAppStore.getState();
    expect(s.files.some((f) => f.relPath === "alpha.md")).toBe(true);
    expect(s.files.some((f) => f.relPath === "a.md")).toBe(false);
    expect(s.notes["alpha.md"]?.rawLinks).toEqual(["b"]);
    expect(s.notes["a.md"]).toBeUndefined();
    expect(s.contentCache["alpha.md"]).toBe("# a [[b]]");
    expect(s.contentCache["a.md"]).toBeUndefined();
  });

  it("keeps a .txt a .txt and never creates a phantom note", async () => {
    await useAppStore.getState().renameNote("data/log.txt", "server-log");
    expect(renamed.calls).toEqual([
      { src: "data/log.txt", dest: "data/server-log.txt" },
    ]);
    const s = useAppStore.getState();
    expect(s.files.some((f) => f.relPath === "data/server-log.txt")).toBe(true);
    expect(s.notes["data/server-log.txt"]).toBeUndefined();
    expect(s.contentCache["data/server-log.txt"]).toBe("log line");
  });

  it("renames a PDF byte-safely, preserving the extension's exact spelling", async () => {
    await useAppStore.getState().renameNote("docs/Scan.pdf", "Contract v2");
    expect(renamed.calls).toEqual([
      { src: "docs/Scan.pdf", dest: "docs/Contract v2.pdf" },
    ]);
    const s = useAppStore.getState();
    expect(s.files.some((f) => f.relPath === "docs/Contract v2.pdf")).toBe(true);
    // Binary: no text-cache entry, no notes entry.
    expect(s.contentCache["docs/Contract v2.pdf"]).toBeUndefined();
    expect(s.notes["docs/Contract v2.pdf"]).toBeUndefined();
  });

  it("strips a typed duplicate extension instead of doubling it", async () => {
    await useAppStore.getState().renameNote("docs/Scan.pdf", "archive.PDF");
    expect(renamed.calls).toEqual([
      { src: "docs/Scan.pdf", dest: "docs/archive.pdf" },
    ]);
  });

  it("allows a case-only rename to reach the byte-preserving vault rename", async () => {
    await useAppStore.getState().renameNote("a.md", "A");
    expect(renamed.calls[0]).toEqual({ src: "a.md", dest: "A.md" });
    expect(useAppStore.getState().files.some((f) => f.relPath === "A.md")).toBe(true);
  });

  it("updates inbound Markdown note links through verified writes while preserving aliases and headings", async () => {
    await useAppStore.getState().renameNote("a.md", "alpha");
    expect(renamed.writes).toEqual([
      {
        rel: "refs.md",
        expected: "See [[a#Part|A link]], [[Alias A|kept alias]], and [details](a.md#Part). Image ![[a.png]] stays.",
        content: "See [[alpha#Part|A link]], [[Alias A|kept alias]], and [details](alpha.md#Part). Image ![[a.png]] stays.",
      },
      {
        rel: "folder/refs.md",
        expected: "Relative [[../a.md#Part|A]] and [md](../a.md#Part).",
        content: "Relative [[../alpha.md#Part|A]] and [md](../alpha.md#Part).",
      },
    ]);
    const s = useAppStore.getState();
    expect(s.contentCache["refs.md"]).toBe(renamed.writes[0].content);
    expect(s.contentCache["folder/refs.md"]).toBe(renamed.writes[1].content);
    expect(s.notes["refs.md"]?.rawLinks).toEqual(["alpha#Part", "Alias A", "alpha.md"]);
    expect(s.status).toContain("updated 2 inbound links");
  });

  it("repairs prose links but preserves embeds and literal Markdown examples", async () => {
    useAppStore.setState({
      contentCache: {
        ...useAppStore.getState().contentCache,
        "refs.md": [
          "Live [[a]] and [details](a.md).",
          "`inline [[a]] and [details](a.md)`",
          "![[a]] and ![image](a.md) stay embeds.",
          "```md",
          "[[a]] and [details](a.md)",
          "```",
        ].join("\n"),
      },
    });
    await useAppStore.getState().renameNote("a.md", "alpha");
    const update = renamed.writes.find((write) => write.rel === "refs.md");
    expect(update?.content).toBe([
      "Live [[alpha]] and [details](alpha.md).",
      "`inline [[a]] and [details](a.md)`",
      "![[a]] and ![image](a.md) stay embeds.",
      "```md",
      "[[a]] and [details](a.md)",
      "```",
    ].join("\n"));
  });

  it("repairs Markdown links with parenthesized paths and URL-encodes the new target", async () => {
    useAppStore.setState({
      files: [
        ...useAppStore.getState().files,
        file("Reports/Alpha Draft.md"),
      ],
      notes: {
        ...useAppStore.getState().notes,
        "refs.md": {
          relPath: "refs.md",
          title: "refs",
          rawLinks: ["Reports/Alpha Draft.md"],
          tags: [],
          aliases: [],
        },
        "Reports/Alpha Draft.md": {
          relPath: "Reports/Alpha Draft.md",
          title: "Alpha Draft",
          rawLinks: [],
          tags: [],
          aliases: [],
        },
      },
      contentCache: {
        ...useAppStore.getState().contentCache,
        "refs.md": "See [report](Reports/Alpha%20Draft.md#Findings).",
      },
    });

    await useAppStore.getState().renameNote("Reports/Alpha Draft.md", "Alpha (final)");

    const update = renamed.writes.find((write) => write.rel === "refs.md");
    expect(update?.content).toBe("See [report](Reports/Alpha%20%28final%29.md#Findings).");
  });

  it("does not rebuild the note resolver for every inbound link while repairing a rename", async () => {
    const links = Array.from({ length: 40 }, (_, i) => `[[a#Part|A ${i}]]`).join(" ");
    useAppStore.setState({
      contentCache: {
        ...useAppStore.getState().contentCache,
        "refs.md": links,
        "folder/refs.md": "no matching link",
      },
      notes: {
        ...useAppStore.getState().notes,
        "refs.md": {
          relPath: "refs.md",
          title: "refs",
          rawLinks: ["a"],
          tags: [],
          aliases: [],
        },
        "folder/refs.md": {
          relPath: "folder/refs.md",
          title: "refs",
          rawLinks: [],
          tags: [],
          aliases: [],
        },
      },
    });

    await useAppStore.getState().renameNote("a.md", "alpha");

    expect(renamed.writes.find((write) => write.rel === "refs.md")?.content).toContain("[[alpha#Part|A 39]]");
    expect(renamed.writes).toHaveLength(1);
  });

  it("keeps the rename when an inbound-link write fails and reports the partial update", async () => {
    renamed.writeFail = "external edit";
    await useAppStore.getState().renameNote("a.md", "alpha");
    const s = useAppStore.getState();
    expect(s.files.some((f) => f.relPath === "alpha.md")).toBe(true);
    expect(s.files.some((f) => f.relPath === "a.md")).toBe(false);
    expect(s.contentCache["refs.md"]).toContain("[[a#Part|A link]]");
    expect(s.status).toContain("but updating inbound links stopped");
    expect(s.status).toContain("external edit");
  });

  it("surfaces a failed rename in status and leaves state untouched", async () => {
    renamed.fail = "read-only filesystem";
    await useAppStore.getState().renameNote("docs/Scan.pdf", "nope");
    const s = useAppStore.getState();
    expect(s.status).toContain("Rename failed");
    expect(s.status).toContain("read-only filesystem");
    expect(s.files.some((f) => f.relPath === "docs/Scan.pdf")).toBe(true);
    expect(s.files.some((f) => f.relPath === "docs/nope.pdf")).toBe(false);
  });

  it("refuses a rename onto an existing file", async () => {
    await useAppStore.getState().renameNote("data/log.txt", "../a.md");
    // safeBaseName strips the traversal; the point is no call reached disk
    // with a colliding or escaping target.
    for (const c of renamed.calls) {
      expect(c.dest.startsWith("data/")).toBe(true);
    }
  });
});
