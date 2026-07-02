import type { SyncLogEntry, SyncReport } from "./sync";
import { formatFingerprint } from "./sync";

/**
 * Sync troubleshooting package — a single copy-pasteable markdown blob built
 * from the sync console's structured log plus the last sync report. Written
 * for exactly one audience: an LLM (or a human) debugging a sync failure,
 * so it front-loads environment, settings, counts, and per-file errors.
 *
 * SECRETS: the sync key (and any per-device keys) must NEVER appear in the
 * package. Every string that passes through here is scrubbed with
 * `redactSecrets` — belt and braces on top of the Rust engine never logging
 * the token in the first place.
 */

export interface DiagnosticsInput {
  /** App version (Tauri `getVersion()`), "dev" when unavailable. */
  appVersion: string;
  /** `navigator.userAgent` — identifies OS + webview. */
  userAgent: string;
  /** Vault stats from the store (never the vault path — file names in the
   *  log are vault-relative, which is enough for debugging). */
  vaultFileCount: number;
  /** Peer being synced (or attempted). */
  peer?: {
    name: string;
    address: string;
    fingerprint?: string;
    lastStatus?: string;
    lastError?: string;
  };
  settings: {
    syncPort: number;
    syncAutoMinutes: number;
    syncDiscovery: boolean;
    /** Whether a global sync key is set (the key itself is never included). */
    hasSyncKey: boolean;
  };
  listening: boolean;
  report?: SyncReport | null;
  log: SyncLogEntry[];
  /** Every secret to scrub from free-form text (sync keys). */
  secrets: string[];
  /** Injectable clock for tests. */
  now?: Date;
}

/** Replace every occurrence of each secret (≥ 4 chars) with `[redacted]`. */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    const secret = s.trim();
    if (secret.length < 4) continue; // too short to identify; avoids shredding text
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

/** "14:03:22.117" — console + package timestamp (local time). */
export function formatLogTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(
    d.getMilliseconds(),
    3
  )}`;
}

/** One console/package line: "14:03:22.117 ERROR pull a.md failed: …". */
export function formatLogLine(entry: SyncLogEntry): string {
  const level = entry.level.toUpperCase().padEnd(5);
  return `${formatLogTime(entry.ts)} ${level} ${entry.msg}`;
}

function bytesHuman(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

/**
 * Build the full troubleshooting package (markdown). Safe to paste anywhere:
 * all free-form text is secret-scrubbed and the vault's absolute path is
 * never included.
 */
export function buildTroubleshootingPackage(input: DiagnosticsInput): string {
  const now = input.now ?? new Date();
  const lines: string[] = [];
  const push = (s: string) => lines.push(redactSecrets(s, input.secrets));

  push("# Mesa sync troubleshooting package");
  push("");
  push(`- Generated: ${now.toISOString()}`);
  push(`- Mesa version: ${input.appVersion}`);
  push(`- Environment: ${input.userAgent}`);
  push(`- Vault: ${input.vaultFileCount} files (path withheld)`);
  push(
    `- Settings: port ${input.settings.syncPort}, auto-sync ${
      input.settings.syncAutoMinutes > 0
        ? `every ${input.settings.syncAutoMinutes}m`
        : "off"
    }, discovery ${input.settings.syncDiscovery ? "on" : "off"}, sync key ${
      input.settings.hasSyncKey ? "set (redacted)" : "NOT SET"
    }, receiving ${input.listening ? "on" : "off"}`
  );
  push("");

  if (input.peer) {
    push("## Peer");
    push("");
    push(`- Name: ${input.peer.name}`);
    push(`- Address: ${input.peer.address}`);
    push(
      `- Pinned fingerprint: ${
        input.peer.fingerprint
          ? formatFingerprint(input.peer.fingerprint)
          : "none (trust-on-first-use)"
      }`
    );
    if (input.peer.lastStatus) push(`- Last status: ${input.peer.lastStatus}`);
    if (input.peer.lastError) push(`- Last error: ${input.peer.lastError}`);
    push("");
  }

  const r = input.report;
  if (r) {
    push("## Last sync report");
    push("");
    push(
      `- Result: ↓${r.pulled} pulled (${bytesHuman(r.bytesPulled)}), ↑${
        r.pushed
      } pushed (${bytesHuman(r.bytesPushed)}), ${r.conflicts} conflict cop${
        r.conflicts === 1 ? "y" : "ies"
      }, ${r.upToDate} already up-to-date`
    );
    push(
      `- Vault sizes: ${r.totalLocal} files local, ${r.totalRemote} remote`
    );
    push(
      `- Duration: ${r.durationMs}ms${r.cancelled ? " (cancelled by user)" : ""}`
    );
    push(`- Peer certificate: ${formatFingerprint(r.fingerprint) || "unknown"}`);
    if (r.failed.length > 0) {
      push(`- FAILED FILES (${r.failed.length}):`);
      for (const f of r.failed.slice(0, 100)) {
        push(`  - [${f.op}] ${f.rel} — ${f.error}`);
      }
      if (r.failed.length > 100) {
        push(`  - …and ${r.failed.length - 100} more (see log)`);
      }
    } else {
      push("- Failed files: none");
    }
    push("");
  } else {
    push("## Last sync report");
    push("");
    push(
      "- No report — the sync did not complete (see the log below for how far it got)."
    );
    push("");
  }

  push("## Sync log");
  push("");
  push("```");
  if (input.log.length === 0) {
    push("(empty — the sync engine emitted no events; the invoke itself likely failed)");
  }
  for (const entry of input.log) {
    push(formatLogLine(entry));
  }
  push("```");
  push("");
  push(
    "_Notes for the reader: hashes are FNV-1a/64; transport is TLS with " +
      "SHA-256 certificate pinning (trust-on-first-use); transfers are " +
      "verified against the manifest hash before an atomic write; a failed " +
      "file never aborts the rest of the sync. Sync keys are redacted._"
  );

  return lines.join("\n");
}
