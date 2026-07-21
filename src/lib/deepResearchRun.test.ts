import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteMeta, VaultFile } from "../types";
import { buildApplyPlan, type ProposedOp } from "./deepResearch";
import { applyChangeSet, resolveApplyPlan } from "./deepResearchRun";

// --- Mocks -------------------------------------------------------------------
// deepResearchRun imports Tauri IPC + vault fs helpers. We replace the vault
// helpers with an in-memory fs so the transactional apply/rollback runs for
// real (no mocks of the logic under test — only of the fs boundary).
const memfs = new Map<string, string>();

function absFor(rel: string): string {
  return `/vault/${rel}`;
}

vi.mock("./vault", async () => {
  const actual = await vi.importActual<typeof import("./vault")>("./vault");
  return {
    ...actual,
    IN_TAURI: false,
    writeNote: async (file: VaultFile, content: string, expectedCurrentContent?: string) => {
      if (expectedCurrentContent !== undefined && memfs.get(file.path) !== expectedCurrentContent) {
        throw new Error("current bytes changed before verified write");
      }
      memfs.set(file.path, content);
    },
    createNote: async (root: string, relPath: string, content = "", expectedMissing = false) => {
      const path = `${root}/${relPath}`;
      if (expectedMissing && memfs.has(path)) throw new Error("expected missing state");
      memfs.set(path, content);
      const name = relPath.split("/").pop()!;
      return {
        path: `${root}/${relPath}`,
        relPath,
        name: name.replace(/\.md$/i, ""),
        ext: "md",
        isMarkdown: true,
      } as VaultFile;
    },
    removeVaultEntry: async (root: string, relPath: string) => {
      memfs.delete(`${root}/${relPath}`);
    },
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("no tauri in test");
  }),
}));

function md(relPath: string): VaultFile {
  const name = relPath.split("/").pop()!.replace(/\.md$/i, "");
  return { path: absFor(relPath), relPath, name, ext: "md", isMarkdown: true };
}
function note(relPath: string): NoteMeta {
  return { relPath, title: md(relPath).name, rawLinks: [], tags: [], aliases: [] };
}

beforeEach(() => {
  memfs.clear();
});

// --- resolveApplyPlan (version-check wrapper) --------------------------------
describe("resolveApplyPlan", () => {
  it("passes through the pure planner's ok/failure", () => {
    const ops: ProposedOp[] = [
      { kind: "create", relPath: "Research/r.md", title: "R", content: "# R" },
    ];
    const ok = resolveApplyPlan({ ops, existingContent: {}, files: [], notes: {} });
    expect(ok.ok).toBe(true);

    const bad = resolveApplyPlan({
      ops: [{ kind: "create", relPath: "../x.md", title: "X", content: "# X" }],
      existingContent: {}, files: [], notes: {},
    });
    expect(bad.ok).toBe(false);
  });
});

// --- applyChangeSet: success path ---------------------------------------------
describe("applyChangeSet", () => {
  it("applies creates and updates, returning the written relPaths", async () => {
    memfs.set(absFor("a.md"), "# A\noriginal");
    const files = [md("a.md")];
    const notes = { "a.md": note("a.md") };
    const ops: ProposedOp[] = [
      { kind: "create", relPath: "Research/r.md", title: "R", content: "# R report" },
      { kind: "update", relPath: "a.md", title: "A", content: "# A\noriginal\n\n## Research\n- [[Research/r.md]]", expectedBytes: "# A\noriginal" },
    ];
    const plan = buildApplyPlan({ ops, existingContent: { "a.md": "# A\noriginal" }, files, notes });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const out = await applyChangeSet({ root: "/vault", plan });
    expect(out.ok).toBe(true);
    expect(out.appliedRelPaths).toEqual(["Research/r.md", "a.md"]);
    expect(memfs.get("/vault/Research/r.md")).toBe("# R report");
    expect(memfs.get(absFor("a.md"))).toContain("[[Research/r.md]]");
  });

  it("rolls back created files and restored updates when a later step fails", async () => {
    memfs.set(absFor("a.md"), "# A\noriginal");
    const files = [md("a.md")];
    const notes = { "a.md": note("a.md"), "b.md": note("b.md") };
    // b.md is in notes/files? no — make the second update target MISSING so it fails.
    const ops: ProposedOp[] = [
      { kind: "create", relPath: "Research/r.md", title: "R", content: "# R" },
      { kind: "update", relPath: "a.md", title: "A", content: "# A changed", expectedBytes: "# A\noriginal" },
      { kind: "create", relPath: "Research/sub/deep.md", title: "D", content: "# D" },
    ];
    const plan = buildApplyPlan({ ops, existingContent: { "a.md": "# A\noriginal" }, files, notes });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    // Sabotage: make createNote fail for the nested path by pre-removing write access —
    // simplest deterministic failure: update a.md to something whose write throws.
    // Instead, force a failure by making the plan's last create target an unsafe dir.
    // (We simulate by making writeNote throw via a poisoned path.)
    const origWrite = memfs.set.bind(memfs);
    memfs.set = ((k: string, v: string) => {
      if (k.includes("sub/deep")) throw new Error("disk full");
      return origWrite(k, v);
    }) as typeof memfs.set;

    const out = await applyChangeSet({ root: "/vault", plan });
    memfs.set = origWrite;

    expect(out.ok).toBe(false);
    expect(out.rolledBack).toBe(true);
    expect(out.failedRelPath).toBe("Research/sub/deep.md");
    // The created report and the updated note are rolled back.
    expect(memfs.has("/vault/Research/r.md")).toBe(false);
    expect(memfs.get(absFor("a.md"))).toBe("# A\noriginal");
  });

  it("refuses to apply when an update's bytes went stale before apply (defense in depth)", async () => {
    memfs.set(absFor("a.md"), "# A\noriginal");
    const files = [md("a.md")];
    const notes = { "a.md": note("a.md") };
    const ops: ProposedOp[] = [
      { kind: "update", relPath: "a.md", title: "A", content: "# A changed", expectedBytes: "# A\noriginal" },
    ];
    // Vault now holds DIFFERENT bytes than expectedBytes.
    const plan = buildApplyPlan({ ops, existingContent: { "a.md": "# A\nrewritten by another tool" }, files, notes });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toMatch(/changed on disk/i);
    // And nothing was written.
    expect(memfs.get(absFor("a.md"))).toBe("# A\noriginal");
  });

  it("rechecks update bytes from disk inside apply even when the proposal cache looked current", async () => {
    memfs.set(absFor("a.md"), "# A\nchanged after review");
    const files = [md("a.md")];
    const notes = { "a.md": note("a.md") };
    const ops: ProposedOp[] = [
      { kind: "update", relPath: "a.md", title: "A", content: "# A changed", expectedBytes: "# A\noriginal" },
    ];
    const plan = buildApplyPlan({ ops, existingContent: { "a.md": "# A\noriginal" }, files, notes });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const out = await applyChangeSet({ root: "/vault", plan });
    expect(out.ok).toBe(false);
    expect(memfs.get(absFor("a.md"))).toBe("# A\nchanged after review");
  });

  it("rechecks create targets from disk so a late collision is preserved", async () => {
    const ops: ProposedOp[] = [
      { kind: "create", relPath: "Research/r.md", title: "R", content: "# Proposed" },
    ];
    const plan = buildApplyPlan({ ops, existingContent: {}, files: [], notes: {} });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    memfs.set("/vault/Research/r.md", "# Created elsewhere");
    const out = await applyChangeSet({ root: "/vault", plan });
    expect(out.ok).toBe(false);
    expect(memfs.get("/vault/Research/r.md")).toBe("# Created elsewhere");
  });

  it("leaves no partial artifacts when the FIRST op fails", async () => {
    const files: VaultFile[] = [];
    const notes: Record<string, NoteMeta> = {};
    const ops: ProposedOp[] = [
      { kind: "create", relPath: "Research/r.md", title: "R", content: "# R" },
      { kind: "create", relPath: "Research/s.md", title: "S", content: "# S" },
    ];
    const plan = buildApplyPlan({ ops, existingContent: {}, files, notes });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const origCreate = memfs.set.bind(memfs);
    let calls = 0;
    memfs.set = ((k: string, v: string) => {
      calls++;
      if (calls === 1) throw new Error("permission denied");
      return origCreate(k, v);
    }) as typeof memfs.set;

    const out = await applyChangeSet({ root: "/vault", plan });
    memfs.set = origCreate;

    expect(out.ok).toBe(false);
    expect(memfs.has("/vault/Research/r.md")).toBe(false);
    expect(memfs.has("/vault/Research/s.md")).toBe(false);
  });
});
