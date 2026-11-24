import { useEffect, useState, useSyncExternalStore } from "react";
import { useAppStore } from "../store";
import { flushBeforeClose } from "../lib/closeGuard";
import { canCheckNow, canDownload, checkedAgo, updateStatusLine, type UpdateStatus } from "../lib/updates";
import { flushAllEdits, hasPendingEdits } from "../controllers/editGuard";
import {
  cancelUpdateDownload,
  checkForUpdates,
  downloadUpdate,
  getUpdateStatus,
  restartForUpdate,
  subscribeUpdateStatus,
} from "../controllers/updates";
import { SettingToggle } from "./SettingsControls";

function StatusIcon({ state }: { state: UpdateStatus["state"] }) {
  if (state === "upToDate" || state === "ready") {
    return (
      <svg className="update-icon update-icon-ok" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (state === "checking" || state === "downloading") {
    return (
      <svg className="update-icon update-icon-busy" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  if (state === "error") {
    return (
      <svg className="update-icon update-icon-error" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 4.5v4.5M8 11.5v.01" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  return null;
}

/** "Checked 2 min ago", refreshed each minute while shown. */
function useCheckedAgo(checkedAt: number | null, shown: boolean): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!shown) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [shown, checkedAt]);
  return shown ? checkedAgo(checkedAt, now) : "";
}

/**
 * Settings › Updates: live status, Check now, Download and install, Restart
 * to update and the Automatic updates switch. Self-contained, so it drops into
 * the Updates group (which shows the installed version).
 */
export function UpdatesSection() {
  const status = useSyncExternalStore(subscribeUpdateStatus, getUpdateStatus);
  const autoUpdate = useAppStore((s) => s.settings.autoUpdate);
  const setSetting = useAppStore((s) => s.setSetting);
  const [restarting, setRestarting] = useState(false);
  const [restartMessage, setRestartMessage] = useState("");
  const percent = status.state === "downloading" ? status.percent : null;
  const checked = useCheckedAgo(status.checkedAt, status.state === "upToDate");

  const restart = async () => {
    setRestarting(true);
    setRestartMessage("");
    const message = await restartForUpdate({ flush: () => flushBeforeClose(flushAllEdits), pending: hasPendingEdits });
    setRestartMessage(message);
    setRestarting(false);
  };

  const setAutomatic = (value: boolean) => {
    setSetting("autoUpdate", value);
    // Off means check only: stop a download that is already running.
    if (!value) void cancelUpdateDownload();
  };

  return (
    <>
      <div className="setting-row update-setting-row">
        <div className="setting-meta">
          <div className="setting-name">Updates</div>
          <div className="update-status" data-state={status.state} role="status">
            <StatusIcon state={status.state} />
            <span>{updateStatusLine(status)}</span>
          </div>
          {checked && <div className="setting-desc update-checked">{checked}</div>}
          {status.state === "downloading" && (
            <div className="update-progress-row">
              <div
                className={"update-progress" + (percent === null ? " indeterminate" : "")}
                role="progressbar"
                aria-label="Update download"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent ?? undefined}
              >
                <span style={percent === null ? undefined : { width: `${percent}%` }} />
              </div>
              {percent !== null && <span className="update-percent" aria-hidden="true">{percent}%</span>}
            </div>
          )}
          {restartMessage && <div className="setting-desc update-message" role="alert">{restartMessage}</div>}
        </div>
        <div className="update-actions">
          {status.state === "ready" && (
            <button className="seg-btn on" disabled={restarting} onClick={() => void restart()}>
              Restart to update
            </button>
          )}
          {canDownload(status) && (
            <button className="seg-btn on" onClick={() => void downloadUpdate()}>
              Download and install
            </button>
          )}
          <button className="seg-btn" disabled={!canCheckNow(status)} onClick={() => void checkForUpdates(autoUpdate)}>
            Check now
          </button>
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-meta">
          <div className="setting-name">Automatic updates</div>
          <div className="setting-desc">
            Check when Mesa starts and download new versions in the background. They install when you quit Mesa. Off: Mesa checks only when you ask.
          </div>
        </div>
        <SettingToggle label="Automatic updates" on={autoUpdate} onChange={setAutomatic} />
      </div>
    </>
  );
}
