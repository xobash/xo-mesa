import { describe, it, expect } from "vitest";
import {
  buildTroubleshootingPackage,
  formatLogLine,
  formatLogTime,
  redactSecrets,
  type DiagnosticsInput,
} from "./syncDiagnostics";
import type { SyncReport } from "./sync";

const REPORT: SyncReport = {
  fingerprint: "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
  pulled: 12,
  pushed: 3,
  conflicts: 1,
  upToDate: 284,
  failed: [
    { rel: "notes/broken.md", op: "pull", error: "device responded 500" },
    { rel: "big.pdf", op: "push", error: "Timed out reaching that device." },
  ],
  bytesPulled: 1024 * 1024 * 2,
  bytesPushed: 2048,
  totalLocal: 300,
  totalRemote: 297,
  durationMs: 4321,
  cancelled: false,
};

function input(overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    appVersion: "0.1.0",
    userAgent: "Mozilla/5.0 (Macintosh) MesaTest",
    vaultFileCount: 300,
    peer: {
      name: "Studio iMac",
      address: "192.168.4.113:8787",
      fingerprint: "aabbccddeeff0011",
      lastStatus: "error",
      lastError: "2 files failed — see the sync console",
    },
    settings: {
      syncPort: 8787,
      syncAutoMinutes: 15,
      syncDiscovery: true,
      hasSyncKey: true,
    },
    listening: true,
    report: REPORT,
    log: [
      { ts: 1750000000000, level: "info", msg: "sync started — peer https://192.168.4.113:8787" },
      { ts: 1750000000100, level: "warn", msg: "local scan skipped locked.md: permission denied" },
      { ts: 1750000004321, level: "error", msg: "pull notes/broken.md failed: device responded 500" },
    ],
    secrets: ["hunter2-super-secret"],
    now: new Date("2026-07-01T12:00:00Z"),
    ...overrides,
  };
}

describe("redactSecrets", () => {
  it("scrubs every occurrence of every secret", () => {
    const out = redactSecrets(
      "key=hunter2-secret again: hunter2-secret",
      ["hunter2-secret"]
    );
    expect(out).toBe("key=[redacted] again: [redacted]");
  });

  it("ignores empty and too-short secrets instead of shredding text", () => {
    expect(redactSecrets("nothing to see", ["", "  ", "ab"])).toBe(
      "nothing to see"
    );
  });
});

describe("formatLogTime / formatLogLine", () => {
  it("formats a fixed-width local time with milliseconds", () => {
    expect(formatLogTime(1750000000117)).toMatch(/^\d{2}:\d{2}:\d{2}\.117$/);
  });

  it("renders level-aligned console lines", () => {
    const line = formatLogLine({ ts: 1750000000117, level: "warn", msg: "x" });
    expect(line).toMatch(/^\d{2}:\d{2}:\d{2}\.117 WARN {2}x$/);
  });
});

describe("buildTroubleshootingPackage", () => {
  it("contains environment, peer, report, failures, and the log", () => {
    const pkg = buildTroubleshootingPackage(input());
    expect(pkg).toContain("# Mesa sync troubleshooting package");
    expect(pkg).toContain("Mesa version: 0.1.0");
    expect(pkg).toContain("Vault: 300 files (path withheld)");
    expect(pkg).toContain("Studio iMac");
    expect(pkg).toContain("192.168.4.113:8787");
    expect(pkg).toContain("↓12 pulled (2.0 MiB)");
    expect(pkg).toContain("↑3 pushed (2.0 KiB)");
    expect(pkg).toContain("284 already up-to-date");
    expect(pkg).toContain("FAILED FILES (2):");
    expect(pkg).toContain("[pull] notes/broken.md — device responded 500");
    expect(pkg).toContain("pull notes/broken.md failed: device responded 500");
    expect(pkg).toContain("Duration: 4321ms");
  });

  it("NEVER leaks the sync key, even when the log echoes it", () => {
    const pkg = buildTroubleshootingPackage(
      input({
        log: [
          {
            ts: 1,
            level: "error",
            msg: "auth failed with key hunter2-super-secret",
          },
        ],
        peer: {
          name: "evil",
          address: "10.0.0.1:8787",
          lastError: "bad key hunter2-super-secret",
        },
      })
    );
    expect(pkg).not.toContain("hunter2-super-secret");
    expect(pkg).toContain("[redacted]");
  });

  it("explains an empty log (invoke failed before the engine started)", () => {
    const pkg = buildTroubleshootingPackage(input({ log: [], report: null }));
    expect(pkg).toContain("No report");
    expect(pkg).toContain("the sync engine emitted no events");
  });

  it("truncates a pathological failure list at 100 entries", () => {
    const failed = Array.from({ length: 150 }, (_, i) => ({
      rel: `f${i}.md`,
      op: "pull" as const,
      error: "x",
    }));
    const pkg = buildTroubleshootingPackage(
      input({ report: { ...REPORT, failed } })
    );
    expect(pkg).toContain("…and 50 more (see log)");
  });

  it("shows trust-on-first-use when no fingerprint is pinned yet", () => {
    const pkg = buildTroubleshootingPackage(
      input({
        peer: { name: "new device", address: "10.0.0.2:8787" },
      })
    );
    expect(pkg).toContain("none (trust-on-first-use)");
  });
});
