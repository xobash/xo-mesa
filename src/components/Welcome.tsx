import { Suspense, lazy, useState } from "react";
import { useAppStore, type VaultUnavailableState } from "../store";
import { IN_TAURI } from "../lib/vault";

// Only ever mounted behind `connectOpen`, so it does no work while closed and
// nothing but the welcome screen's "connect" button can reach it — 8.8 kB of
// pairing/discovery UI that the entry chunk was carrying for every launch.
const LazyConnectVaultModal = lazy(() =>
  import("./ConnectVaultModal").then((m) => ({
    default: m.ConnectVaultModal,
  }))
);

export function Welcome({
  onOpen,
  onRetry,
  unavailableVault,
}: {
  onOpen: () => void;
  onRetry: () => void;
  unavailableVault: VaultUnavailableState | null;
}) {
  // Read transient open progress here, not in App: status and loading change
  // throughout a vault open and import, and App re-renders the whole shell.
  const loading = useAppStore((s) => s.loading);
  const status = useAppStore((s) => s.status);
  const [connectOpen, setConnectOpen] = useState(false);
  const approvalNeeded = unavailableVault?.reason.includes(
    "vault folder has not been selected in Mesa",
  );
  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-mark">✦</div>
        <h1>Mesa</h1>
        <p>
          A local-first vault workspace with a living graph, snap-in views,
          saved webpage rendering, Shift+Tab tools, and a Pi terminal that
          starts with path-only context.
        </p>
        {unavailableVault && (
          <div className="welcome-unavailable" role="alert">
            <strong>
              {approvalNeeded
                ? `${unavailableVault.name} needs folder approval`
                : `${unavailableVault.name} is not connected`}
            </strong>
            <span>
              {approvalNeeded
                ? "Select the folder again once so Mesa can restore its native file access."
                : "Mesa kept this vault selected and did not open it as an empty workspace. Reconnect the drive; Mesa retries automatically while this window is open."}
            </span>
            <code title={unavailableVault.reason}>{unavailableVault.root}</code>
          </div>
        )}
        <div className="welcome-actions">
          {unavailableVault && (
            <button className="btn primary" onClick={onRetry} disabled={loading}>
              {loading
                ? "Retrying…"
                : approvalNeeded
                  ? "Select this vault again"
                  : "Retry now"}
            </button>
          )}
          <button className={"btn " + (unavailableVault ? "welcome-secondary" : "primary")} onClick={onOpen} disabled={loading}>
            {unavailableVault ? "Choose another vault" : loading ? "Opening…" : "Open vault folder"}
          </button>
          {IN_TAURI && (
            <button
              className="btn welcome-secondary"
              onClick={() => setConnectOpen(true)}
              disabled={loading}
            >
              Open a shared vault
            </button>
          )}
        </div>
        {loading && (
          <div className="welcome-progress" role="status" aria-live="polite">
            <span className="welcome-progress-dot" aria-hidden="true" />
            <span>{status || "Getting things ready…"}</span>
          </div>
        )}
        {IN_TAURI && (
          <p className="welcome-hint">
            Pick any folder for a new vault, or pull one from another device
            that's sharing it. Notes are plain <code>.md</code> files.
          </p>
        )}
      </div>
      <Suspense fallback={null}>
        {connectOpen && (
          <LazyConnectVaultModal onClose={() => setConnectOpen(false)} />
        )}
      </Suspense>
    </div>
  );
}
