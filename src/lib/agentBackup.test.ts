import { describe, expect, it } from "vitest";
import {
  AGENT_SNAPSHOT_MAX_AGE_MS,
  buildAgentSnapshotPath,
  isAgentSnapshotName,
  latestAgentSnapshot,
  parseAgentSnapshotName,
  planAgentSnapshotPrune,
  type FoundAgentSnapshot,
} from "./agentBackup";
import { buildWriteArtifactPath, parseWriteArtifactName } from "./verifiedWrite";
import { isMesaWriteArtifactName } from "./writeRecovery";

const NOW = 1_800_000_000_000;

function baseNameOf(path: string): string {
  return path.slice(
    Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1
  );
}

describe("agent snapshot names", () => {
  it("are dot-prefixed siblings so every scan/watch/sync skip rule hides them", () => {
    const p = buildAgentSnapshotPath("/vault/Notes/report.pdf", NOW);
    expect(p.startsWith("/vault/Notes/.")).toBe(true);
    expect(p.endsWith(".bak")).toBe(true);
  });

  it("round-trips: a built name parses back to its target basename + timestamp", () => {
    const name = baseNameOf(
      buildAgentSnapshotPath("/vault/a b/report.pdf", NOW, "ab12")
    );
    expect(parseAgentSnapshotName(name)).toEqual({
      targetBase: "report.pdf",
      timestamp: NOW,
    });
    expect(isAgentSnapshotName(name)).toBe(true);
  });

  it("works with backslash vault paths (Windows)", () => {
    const name = baseNameOf(
      buildAgentSnapshotPath("C:\\vault\\report.pdf", NOW, "xy9")
    );
    expect(parseAgentSnapshotName(name)).toEqual({
      targetBase: "report.pdf",
      timestamp: NOW,
    });
  });

  it("rejects ordinary files and Mesa's own write-artifact names", () => {
    expect(parseAgentSnapshotName("report.pdf")).toBeNull();
    expect(parseAgentSnapshotName(".DS_Store")).toBeNull();
    expect(isAgentSnapshotName("note.md")).toBe(false);

    const save = baseNameOf(buildWriteArtifactPath("/vault/note.md", "save"));
    const backup = baseNameOf(
      buildWriteArtifactPath("/vault/note.md", "backup")
    );
    expect(parseAgentSnapshotName(save)).toBeNull();
    expect(parseAgentSnapshotName(backup)).toBeNull();
  });

  it("is never mistaken for Mesa's own write artifacts (or vice versa) — the whole point is that writeRecovery's stale-backup GC must never see these", () => {
    const snapshot = baseNameOf(
      buildAgentSnapshotPath("/vault/note.md", NOW, "ab12")
    );
    expect(isMesaWriteArtifactName(snapshot)).toBe(false);
    expect(parseWriteArtifactName(snapshot)).toBeNull();

    const backup = baseNameOf(buildWriteArtifactPath("/vault/note.md", "backup"));
    expect(isAgentSnapshotName(backup)).toBe(false);
  });
});

describe("planAgentSnapshotPrune", () => {
  const artifact = (
    filePath: string,
    ts: number,
    rand = Math.random().toString(36).slice(2)
  ): FoundAgentSnapshot => ({
    dir: "/vault",
    name: baseNameOf(buildAgentSnapshotPath(filePath, ts, rand)),
  });

  it("keeps everything when under the per-file cap and age limit", () => {
    const artifacts = [
      artifact("/vault/note.md", NOW - 3000, "a"),
      artifact("/vault/note.md", NOW - 2000, "b"),
      artifact("/vault/note.md", NOW - 1000, "c"),
    ];
    expect(planAgentSnapshotPrune(artifacts, NOW)).toEqual([]);
  });

  it("removes everything past the newest `keepPerFile` for that target", () => {
    const artifacts = [
      artifact("/vault/note.md", NOW - 5000, "a"),
      artifact("/vault/note.md", NOW - 4000, "b"),
      artifact("/vault/note.md", NOW - 3000, "c"),
    ];
    const plan = planAgentSnapshotPrune(artifacts, NOW, { keepPerFile: 1 });
    expect(plan).toHaveLength(2);
    // the newest (ts NOW-3000) survives; the two older ones are removed
    const removedNames = plan.map((a) => a.name);
    expect(removedNames).toContain(artifacts[0].name);
    expect(removedNames).toContain(artifacts[1].name);
    expect(removedNames).not.toContain(artifacts[2].name);
  });

  it("drops snapshots older than maxAgeMs even if under the count cap", () => {
    const artifacts = [artifact("/vault/note.md", NOW - AGENT_SNAPSHOT_MAX_AGE_MS - 1)];
    const plan = planAgentSnapshotPrune(artifacts, NOW);
    expect(plan).toEqual([
      { kind: "remove", dir: "/vault", name: artifacts[0].name },
    ]);
  });

  it("keeps each target file's snapshots in its own bucket", () => {
    const artifacts = [
      artifact("/vault/a.pdf", NOW - 1000, "a"),
      artifact("/vault/b.pdf", NOW - 1000, "b"),
    ];
    expect(planAgentSnapshotPrune(artifacts, NOW, { keepPerFile: 1 })).toEqual(
      []
    );
  });

  it("ignores names that are not agent-snapshot artifacts", () => {
    const plan = planAgentSnapshotPrune(
      [
        { dir: "/vault", name: ".DS_Store" },
        { dir: "/vault", name: "note.md" },
      ],
      NOW
    );
    expect(plan).toEqual([]);
  });
});

describe("latestAgentSnapshot", () => {
  it("returns the newest snapshot for the target in the same directory", () => {
    const older = { dir: "/vault", name: baseNameOf(buildAgentSnapshotPath("/vault/note.md", NOW - 2000, "a")) };
    const newer = { dir: "/vault", name: baseNameOf(buildAgentSnapshotPath("/vault/note.md", NOW - 1000, "b")) };
    expect(latestAgentSnapshot([older, newer], "/vault", "note.md")).toEqual(newer);
  });

  it("never crosses directories, even with a matching basename", () => {
    const other = { dir: "/vault/sub", name: baseNameOf(buildAgentSnapshotPath("/vault/sub/note.md", NOW, "a")) };
    expect(latestAgentSnapshot([other], "/vault", "note.md")).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(latestAgentSnapshot([], "/vault", "note.md")).toBeNull();
  });
});
