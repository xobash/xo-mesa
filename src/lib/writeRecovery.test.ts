import { describe, expect, it } from "vitest";
import {
  isMesaWriteArtifactName,
  planWriteRecovery,
  RECOVERY_MIN_AGE_MS,
  type FoundArtifact,
} from "./writeRecovery";
import {
  buildWriteArtifactPath,
  parseWriteArtifactName,
} from "./verifiedWrite";

const NOW = 1_800_000_000_000;
const STALE = NOW - RECOVERY_MIN_AGE_MS - 1;
const FRESH = NOW - 1_000;

function baseNameOf(path: string): string {
  return path.slice(
    Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1
  );
}

describe("write artifact names", () => {
  it("are dot-prefixed siblings so every scan/watch/sync skip rule hides them", () => {
    const save = buildWriteArtifactPath("/vault/Notes/report.pdf", "save");
    const backup = buildWriteArtifactPath("/vault/Notes/report.pdf", "backup");
    for (const p of [save, backup]) {
      expect(p.startsWith("/vault/Notes/.")).toBe(true);
      expect(p.endsWith(".tmp")).toBe(true);
    }
  });

  it("round-trip: built names parse back to their target basename", () => {
    const save = baseNameOf(buildWriteArtifactPath("/vault/a b/note.md", "save"));
    const backup = baseNameOf(buildWriteArtifactPath("C:\\vault\\note.md", "backup"));
    expect(parseWriteArtifactName(save)).toEqual({
      targetBase: "note.md",
      label: "save",
    });
    expect(parseWriteArtifactName(backup)).toEqual({
      targetBase: "note.md",
      label: "backup",
    });
  });

  it("rejects ordinary files, including dot-prefixed ones", () => {
    expect(parseWriteArtifactName("note.md")).toBeNull();
    expect(parseWriteArtifactName(".gitignore")).toBeNull();
    expect(parseWriteArtifactName(".hidden.tmp")).toBeNull();
    expect(isMesaWriteArtifactName("note.md")).toBe(false);
    expect(isMesaWriteArtifactName(".obsidian")).toBe(false);
  });

  it("recognizes the Rust sync temp naming too", () => {
    expect(isMesaWriteArtifactName(".mesa-sync-tmp-4242-note.md")).toBe(true);
  });
});

describe("planWriteRecovery", () => {
  const artifact = (over: Partial<FoundArtifact>): FoundArtifact => ({
    dir: "/vault",
    name: baseNameOf(buildWriteArtifactPath("/vault/note.md", "save")),
    mtime: STALE,
    ...over,
  });

  it("leaves fresh artifacts alone — another instance may be mid-save", () => {
    expect(planWriteRecovery([artifact({ mtime: FRESH })], NOW)).toEqual([]);
  });

  it("restores a stale backup whose target file is missing", () => {
    const name = baseNameOf(buildWriteArtifactPath("/vault/note.md", "backup"));
    const plan = planWriteRecovery(
      [artifact({ name, targetExists: false })],
      NOW
    );
    expect(plan).toEqual([
      { kind: "restore", dir: "/vault", artifactName: name, targetName: "note.md" },
    ]);
  });

  it("removes a stale backup when the target still exists", () => {
    const name = baseNameOf(buildWriteArtifactPath("/vault/note.md", "backup"));
    const plan = planWriteRecovery([artifact({ name, targetExists: true })], NOW);
    expect(plan).toEqual([{ kind: "remove", dir: "/vault", artifactName: name }]);
  });

  it("always removes stale save temps and sync temps", () => {
    const save = artifact({});
    const sync = artifact({ name: ".mesa-sync-tmp-77-note.md" });
    const plan = planWriteRecovery([save, sync], NOW);
    expect(plan.map((a) => a.kind)).toEqual(["remove", "remove"]);
  });

  it("treats an unreadable mtime as stale instead of keeping debris forever", () => {
    const plan = planWriteRecovery([artifact({ mtime: undefined })], NOW);
    expect(plan).toHaveLength(1);
  });

  it("ignores names that are not Mesa artifacts", () => {
    const plan = planWriteRecovery(
      [artifact({ name: ".DS_Store" }), artifact({ name: "note.md" })],
      NOW
    );
    expect(plan).toEqual([]);
  });
});
