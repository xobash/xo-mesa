import { useState } from "react";
import { useAppStore, THEMES } from "../store";
import {
  listRecoveryEntries,
  type RecoveryEntry,
} from "../lib/vault";
import { Modal } from "./Modal";

function Toggle({
  label,
  on,
  onChange,
}: {
  label: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      className={"toggle" + (on ? " on" : "")}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    >
      <span className="toggle-knob" />
    </button>
  );
}

export function SettingsModal() {
  const open = useAppStore((s) => s.settingsOpen);
  const setOpen = useAppStore((s) => s.setSettingsOpen);
  const settings = useAppStore((s) => s.settings);
  const setSetting = useAppStore((s) => s.setSetting);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const vaultPath = useAppStore((s) => s.vaultPath);
  const activePath = useAppStore((s) => s.activePath);
  const listActiveTextRevisions = useAppStore((s) => s.listActiveTextRevisions);
  const restoreTextRevision = useAppStore((s) => s.restoreTextRevision);
  const restoreRecoveryEntry = useAppStore((s) => s.restoreRecoveryEntry);
  const [recoveryEntries, setRecoveryEntries] = useState<RecoveryEntry[] | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState("");
  const [revisionMessage, setRevisionMessage] = useState("");
  const [revisionBusy, setRevisionBusy] = useState(false);
  const revisions = open ? listActiveTextRevisions() : [];

  const refreshRecovery = async () => {
    if (!vaultPath) return;
    setRecoveryBusy(true);
    setRecoveryMessage("");
    try {
      const entries = await listRecoveryEntries(vaultPath);
      setRecoveryEntries(entries);
      setRecoveryMessage(
        entries.length
          ? `${entries.length} item${entries.length === 1 ? "" : "s"} ready to restore.`
          : "Recovery storage is empty."
      );
    } catch (error) {
      setRecoveryMessage(`Could not check recovery storage: ${String(error)}`);
    } finally {
      setRecoveryBusy(false);
    }
  };

  const restoreEntry = async (entry: RecoveryEntry) => {
    if (!vaultPath) return;
    setRecoveryBusy(true);
    setRecoveryMessage("");
    try {
      const restored = await restoreRecoveryEntry(entry);
      setRecoveryEntries((entries) =>
        entries?.filter((e) => e.trashRelPath !== entry.trashRelPath) ?? null
      );
      setRecoveryMessage(`Restored ${restored.relPath}.`);
    } catch (error) {
      setRecoveryMessage(`Restore failed: ${String(error)}`);
    } finally {
      setRecoveryBusy(false);
    }
  };

  const restoreRevision = async (revisionId: string) => {
    setRevisionBusy(true);
    setRevisionMessage("");
    try {
      await restoreTextRevision(revisionId);
      setRevisionMessage("Revision restored.");
    } catch (error) {
      setRevisionMessage(`Restore failed: ${String(error)}`);
    } finally {
      setRevisionBusy(false);
    }
  };

  if (!open) return null;

  return (
    <Modal onClose={() => setOpen(false)} className="settings" title="Settings">
      <header className="modal-head">
        <span>Settings</span>
        <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">
          ×
        </button>
      </header>
      <div className="settings-body">
        <div className="setting-row theme-setting-row">
          <div className="setting-meta">
            <div className="setting-name">Theme</div>
            <div className="setting-desc">
              Choose the colour palette for the entire interface. Changes apply
              immediately across all panels and windows.
            </div>
          </div>
          <div className="seg theme-seg">
            {THEMES.map((t) => (
              <button
                key={t.id}
                className={"seg-btn" + (t.id === theme ? " on" : "")}
                aria-pressed={t.id === theme}
                onClick={() => setTheme(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-meta">
            <div className="setting-name">Tabs</div>
            <div className="setting-desc">
              Keep a browser-style tab strip above the editor. Off keeps the center view
              focused on the current file.
            </div>
          </div>
          <Toggle
            label="Tabs"
            on={settings.enableTabs}
            onChange={(v) => setSetting("enableTabs", v)}
          />
        </div>

        <div className="setting-row">
          <div className="setting-meta">
            <div className="setting-name">Hover preview delay</div>
            <div className="setting-desc">
              How long to rest on a node, file, folder, or tag before its
              preview appears.
            </div>
          </div>
          <div className="seg">
            {([
              ["Short", 200],
              ["Normal", 450],
              ["Long", 900],
            ] as const).map(([label, ms]) => (
              <button
                key={ms}
                className={"seg-btn" + (settings.hoverDelayMs === ms ? " on" : "")}
                aria-pressed={settings.hoverDelayMs === ms}
                onClick={() => setSetting("hoverDelayMs", ms)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-meta">
            <div className="setting-name">Graph canvas smoothing</div>
            <div className="setting-desc">
              Ask the system canvas to favor smoother graph motion when available.
              Changes apply the next time the graph opens.
            </div>
          </div>
          <Toggle
            label="Graph canvas smoothing"
            on={settings.hardwareAccel}
            onChange={(v) => setSetting("hardwareAccel", v)}
          />
        </div>

        <div className="setting-row">
          <div className="setting-meta">
            <div className="setting-name">Animations</div>
            <div className="setting-desc">UI transitions and motion throughout.</div>
          </div>
          <Toggle
            label="Animations"
            on={settings.animations}
            onChange={(v) => setSetting("animations", v)}
          />
        </div>

        <div className="setting-row">
          <div className="setting-meta">
            <div className="setting-name">Auto-hide sidebar</div>
            <div className="setting-desc">
              Tuck the sidebar away and reveal it when you move the pointer to
              the left edge of the window.
            </div>
          </div>
          <Toggle
            label="Auto-hide sidebar"
            on={settings.sidebarAutoHide}
            onChange={(v) => {
              setSetting("sidebarAutoHide", v);
              // Enabling auto-hide implies the sidebar exists (to reveal on hover).
              if (v) setSetting("sidebarOpen", true);
            }}
          />
        </div>

        <div className="setting-row recovery-setting-row">
          <div className="setting-meta">
            <div className="setting-name">Recovery storage</div>
            <div className="setting-desc">
              Restore files Mesa moved aside during delete actions.
            </div>
            {recoveryMessage ? (
              <div className="setting-desc recovery-message">{recoveryMessage}</div>
            ) : null}
            {recoveryEntries?.length ? (
              <div className="recovery-list">
                {recoveryEntries.slice(0, 20).map((entry) => (
                  <div className="recovery-row" key={entry.trashRelPath}>
                    <span title={entry.originalRelPath}>
                      {entry.isDirectory ? "Folder: " : ""}
                      {entry.originalRelPath}
                    </span>
                    <button
                      className="seg-btn"
                      disabled={recoveryBusy}
                      onClick={() => void restoreEntry(entry)}
                    >
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <button
            className="seg-btn"
            disabled={!vaultPath || recoveryBusy}
            onClick={() => void refreshRecovery()}
          >
            {recoveryBusy ? "Checking…" : "Check"}
          </button>
        </div>

        <div className="setting-row recovery-setting-row">
          <div className="setting-meta">
            <div className="setting-name">Text revision history</div>
            <div className="setting-desc">
              Restore an earlier saved version of the current text file.
            </div>
            <div className="setting-desc">
              {activePath ? activePath : "Open a text file to see local revisions."}
            </div>
            {revisionMessage ? (
              <div className="setting-desc recovery-message">{revisionMessage}</div>
            ) : null}
            {revisions.length ? (
              <div className="recovery-list">
                {revisions.slice(0, 10).map((revision) => (
                  <div className="recovery-row" key={revision.id}>
                    <span title={new Date(revision.savedAt).toLocaleString()}>
                      {new Date(revision.savedAt).toLocaleString()}
                    </span>
                    <button
                      className="seg-btn"
                      disabled={revisionBusy}
                      onClick={() => void restoreRevision(revision.id)}
                    >
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </Modal>
  );
}
