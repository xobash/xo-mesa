import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store";
import { type SyncProgress } from "../lib/syncUi";
import { buildTroubleshootingPackage, formatLogLine } from "../lib/syncDiagnostics";
import { IN_TAURI } from "../lib/vault";

export function progressLabel(p: SyncProgress | null): string {
  if (!p) return "Contacting device…";
  switch (p.phase) {
    case "manifest":
      return "Fetching remote manifest…";
    case "scan":
      return "Scanning local vault…";
    case "transfer":
      return p.total > 0
        ? `Transferring ${p.done}/${p.total}${p.rel ? ` — ${p.rel}` : ""}`
        : "Nothing to transfer";
    case "done":
      return "Finishing…";
    default:
      return "Working…";
  }
}

export function phaseLabel(phase: ReturnType<typeof useAppStore.getState>["syncPhase"]): string {
  switch (phase) {
    case "preparing": return "Preparing";
    case "waiting": return "Waiting";
    case "transferring": return "Transferring";
    case "retrying": return "Retrying";
    case "offline": return "Offline";
    case "incomplete": return "Incomplete";
    case "complete": return "Complete";
    case "cancelled": return "Cancelled";
    case "disabled": return "Disabled";
    case "error": return "Error";
    default: return "Idle";
  }
}

/**
 * Embedded sync console — appears as soon as a sync starts. Shows the live
 * structured log streamed from the Rust engine plus a progress bar, and can
 * copy a self-contained, secret-scrubbed troubleshooting package (markdown)
 * to paste at an LLM or a bug report.
 */
export function SyncConsole() {
  const log = useAppStore((s) => s.syncLog);
  const progress = useAppStore((s) => s.syncProgress);
  const phase = useAppStore((s) => s.syncPhase);
  const busy = useAppStore((s) => s.syncBusy);
  const report = useAppStore((s) => s.syncReport);
  const lastPeerId = useAppStore((s) => s.syncLastPeerId);
  const syncNow = useAppStore((s) => s.syncNow);
  const listening = useAppStore((s) => s.syncListening);
  const settings = useAppStore((s) => s.settings);
  const fileCount = useAppStore((s) => s.files.length);
  const vaultPath = useAppStore((s) => s.vaultPath);
  const clearSyncLog = useAppStore((s) => s.clearSyncLog);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [copied, setCopied] = useState<"" | "package" | "log">("");

  // Follow the tail as new lines stream in.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length]);

  if (!busy && log.length === 0) return null;

  const copyText = (text: string, kind: "package" | "log") => {
    void navigator.clipboard?.writeText(text);
    setCopied(kind);
    setTimeout(() => setCopied(""), 1400);
  };

  const copyLog = () => {
    copyText(log.map(formatLogLine).join("\n"), "log");
  };

  const copyPackage = async () => {
    let appVersion = "dev";
    if (IN_TAURI) {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        appVersion = await getVersion();
      } catch {
        /* keep "dev" */
      }
    }
    let home: string | undefined;
    if (IN_TAURI) {
      try { home = await (await import("@tauri-apps/api/path")).homeDir(); } catch { /* Generic home-path scrubbing remains available. */ }
    }
    const peer = settings.peers.find((p) => p.id === lastPeerId);
    const pkg = buildTroubleshootingPackage({
      appVersion,
      paths: { vaultRoot: vaultPath ?? undefined, home },
      userAgent: navigator.userAgent,
      vaultFileCount: fileCount,
      peer: peer
        ? {
            name: peer.name,
            address: peer.address,
            fingerprint: peer.fingerprint,
            lastStatus: peer.lastStatus,
            lastError: peer.lastError,
          }
        : undefined,
      settings: {
        syncPort: settings.syncPort,
        syncAutoMinutes: settings.syncAutoMinutes,
        syncDiscovery: settings.syncDiscovery,
        hasSyncKey: settings.syncToken.trim().length > 0,
      },
      listening,
      phase,
      report,
      log,
      secrets: [
        settings.syncToken,
        ...settings.peers.map((p) => p.token || ""),
      ],
    });
    copyText(pkg, "package");
  };

  const pct =
    progress && progress.phase === "transfer" && progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : null;
  const failedFiles = report?.failed.filter((file) => file.error !== "cancelled") ?? [];
  const retryableFailedFiles = failedFiles.filter((file) =>
    file.op === "pull" || file.op === "push" || file.op === "conflict"
  );

  return (
    <div className="sync-section sync-console">
      <div className="sync-section-title">
        <span>Sync console</span>
        <span className="sync-console-actions">
          {busy && (
            <button
              className="link-btn danger"
              onClick={() => void useAppStore.getState().cancelCurrentSync()}
              title="Stop the current sync. Completed files are preserved."
            >
              Cancel
            </button>
          )}
          {!busy && lastPeerId && failedFiles.length > 0 && (
            <button
              className="link-btn"
              onClick={() => void syncNow(lastPeerId)}
              title={
                retryableFailedFiles.length > 0
                  ? "Retry failed transfers on the last device. Manifests and journals are checked again first."
                  : "Retry the last device. Already completed files are skipped by the manifest diff."
              }
            >
              {retryableFailedFiles.length > 0 ? "Retry failed files" : "Retry sync"}
            </button>
          )}
          <button
            className="link-btn"
            onClick={() => void copyPackage()}
            title="Copy a secret-scrubbed markdown report of this sync — made to paste at an LLM"
          >
            {copied === "package" ? "Copied" : "Copy troubleshooting package"}
          </button>
          <button className="link-btn" onClick={copyLog}>
            {copied === "log" ? "Copied" : "Copy log"}
          </button>
          {!busy && (
            <button className="link-btn" onClick={clearSyncLog}>
              Clear
            </button>
          )}
        </span>
      </div>
      <div className={`sync-phase sync-phase-${phase}`}>{phaseLabel(phase)}</div>
      {busy && (
        <div className="sync-progress">
          <div className="sync-progress-label">{progressLabel(progress)}</div>
          <div className="sync-progress-track">
            <div
              className={
                "sync-progress-fill" + (pct === null ? " indeterminate" : "")
              }
              style={pct === null ? undefined : { width: `${pct}%` }}
            />
          </div>
        </div>
      )}
      {!busy && failedFiles.length > 0 && (
        <div className="sync-failed-summary" role="status">
          <strong>
            {failedFiles.length} failed {failedFiles.length === 1 ? "file" : "files"}
          </strong>
          {failedFiles.slice(0, 5).map((file) => (
            <div className="sync-failed-file" key={`${file.op}:${file.rel}`}>
              <span>{file.rel}</span>
              <span>{file.op} · {file.error}</span>
            </div>
          ))}
          {failedFiles.length > 5 && (
            <div className="sync-failed-more">
              {failedFiles.length - 5} more in the troubleshooting package
            </div>
          )}
        </div>
      )}
      <div className="sync-console-body" ref={bodyRef}>
        {log.map((entry, i) => (
          <div key={i} className={"sync-log-line " + entry.level}>
            {formatLogLine(entry)}
          </div>
        ))}
        {log.length === 0 && (
          <div className="sync-log-line">waiting for the sync engine…</div>
        )}
      </div>
    </div>
  );
}
