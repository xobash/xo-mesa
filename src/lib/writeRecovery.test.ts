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

function artifactName(
  target: string,
  label: "save" | "backup" | "rescue",
  timestamp: number,
  id: string
): string {
  return `.${target}.mesa-${label}-${timestamp}-${id}.tmp`;
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

  it("recognises the rescue label a failed rollback leaves behind", () => {
    const rescue = baseNameOf(
      buildWriteArtifactPath("/vault/Notes/report.pdf", "rescue")
    );
    expect(isMesaWriteArtifactName(rescue)).toBe(true);
    expect(parseWriteArtifactName(rescue)).toEqual({
      targetBase: "report.pdf",
      label: "rescue",
    });
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

  it("selects the newest backup and preserves every nonselected backup", () => {
    const oldest = artifactName("note.md", "backup", 100, "z9");
    const sameTimeLowerId = artifactName("note.md", "backup", 300, "a1");
    const selected = artifactName("note.md", "backup", 300, "b2");
    const plan = planWriteRecovery(
      [
        artifact({ name: selected, targetExists: false }),
        artifact({ name: oldest, targetExists: false }),
        artifact({ name: sameTimeLowerId, targetExists: false }),
      ],
      NOW
    );

    expect(plan).toEqual([
      {
        kind: "restore",
        dir: "/vault",
        artifactName: selected,
        targetName: "note.md",
      },
    ]);
  });

  it("gives rescue copies priority over newer backups", () => {
    const newerBackup = artifactName("note.md", "backup", 900, "z9");
    const olderRescue = artifactName("note.md", "rescue", 100, "a1");
    const selectedRescue = artifactName("note.md", "rescue", 100, "b2");
    const plan = planWriteRecovery(
      [
        artifact({ name: newerBackup, targetExists: false }),
        artifact({ name: olderRescue, targetExists: false }),
        artifact({ name: selectedRescue, targetExists: false }),
      ],
      NOW
    );

    expect(plan).toEqual([
      {
        kind: "restore",
        dir: "/vault",
        artifactName: selectedRescue,
        targetName: "note.md",
      },
    ]);
  });

  it("groups copies by both directory and target", () => {
    const first = artifactName("note.md", "backup", 100, "a1");
    const second = artifactName("note.md", "backup", 200, "b2");
    const plan = planWriteRecovery(
      [
        artifact({ dir: "/vault/a", name: first, targetExists: false }),
        artifact({ dir: "/vault/b", name: second, targetExists: false }),
      ],
      NOW
    );

    expect(plan).toEqual([
      {
        kind: "restore",
        dir: "/vault/a",
        artifactName: first,
        targetName: "note.md",
      },
      {
        kind: "restore",
        dir: "/vault/b",
        artifactName: second,
        targetName: "note.md",
      },
    ]);
  });

  it("preserves a group when one original-holding artifact is fresh", () => {
    const stale = artifactName("note.md", "backup", 100, "a1");
    const fresh = artifactName("note.md", "rescue", 200, "b2");
    const plan = planWriteRecovery(
      [
        artifact({ name: stale, targetExists: false }),
        artifact({ name: fresh, mtime: FRESH, targetExists: false }),
      ],
      NOW
    );

    expect(plan).toEqual([]);
  });

  it("preserves all copies when target discovery is inconsistent", () => {
    const first = artifactName("note.md", "backup", 100, "a1");
    const second = artifactName("note.md", "rescue", 200, "b2");
    const plan = planWriteRecovery(
      [
        artifact({ name: first, targetExists: false }),
        artifact({ name: second, targetExists: true }),
      ],
      NOW
    );

    expect(plan).toEqual([]);
  });

  it("removes a stale backup when the target still exists", () => {
    const name = baseNameOf(buildWriteArtifactPath("/vault/note.md", "backup"));
    const plan = planWriteRecovery([artifact({ name, targetExists: true })], NOW);
    expect(plan).toEqual([{ kind: "remove", dir: "/vault", artifactName: name }]);
  });

  it("restores a stale rescue copy whose target file is missing", () => {
    const name = baseNameOf(buildWriteArtifactPath("/vault/note.md", "rescue"));
    const plan = planWriteRecovery(
      [artifact({ name, targetExists: false })],
      NOW
    );
    expect(plan).toEqual([
      { kind: "restore", dir: "/vault", artifactName: name, targetName: "note.md" },
    ]);
  });

  it("never removes a rescue copy, even when the target exists", () => {
    // Unlike a backup, a rescue sits next to a target holding bytes Mesa could
    // not verify — it may be the user's only good copy.
    const name = baseNameOf(buildWriteArtifactPath("/vault/note.md", "rescue"));
    expect(planWriteRecovery([artifact({ name, targetExists: true })], NOW)).toEqual([]);
    expect(planWriteRecovery([artifact({ name })], NOW)).toEqual([]);
  });

  it("always removes stale save temps and sync temps", () => {
    const save = artifact({});
    const sync = artifact({ name: ".mesa-sync-tmp-77-note.md" });
    const plan = planWriteRecovery([save, sync], NOW);
    expect(plan.map((a) => a.kind)).toEqual(["remove", "remove"]);
  });

  it("preserves an artifact whose age could not be read", () => {
    const plan = planWriteRecovery([artifact({ mtime: undefined })], NOW);
    expect(plan).toEqual([]);
  });

  it("preserves an original-holding group whose age could not be read", () => {
    const backup = artifactName("note.md", "backup", 100, "unknown");
    const plan = planWriteRecovery(
      [artifact({ name: backup, mtime: undefined, targetExists: true })],
      NOW
    );
    expect(plan).toEqual([]);
  });

  it("ignores names that are not Mesa artifacts", () => {
    const plan = planWriteRecovery(
      [artifact({ name: ".DS_Store" }), artifact({ name: "note.md" })],
      NOW
    );
    expect(plan).toEqual([]);
  });
});
