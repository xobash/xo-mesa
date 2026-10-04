import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore, THEMES } from "../store";
import {
  listRecoveryEntries,
  type RecoveryEntry,
} from "../lib/vault";
import { Modal } from "./Modal";

const RECOVERY_PAGE_SIZE = 20;
const REVISION_PAGE_SIZE = 10;

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
  const section = useAppStore(s => s.settingsSection);
  const open = useAppStore((s) => s.settingsOpen);
  const setOpen = useAppStore((s) => s.setSettingsOpen);
  const revisionHistoryRequest = useAppStore((s) => s.revisionHistoryRequest);
  const settings = useAppStore((s) => s.settings);
  const setSetting = useAppStore((s) => s.setSetting);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const applyWorkspacePreset = useAppStore((s) => s.applyWorkspacePreset);
  const vaultPath = useAppStore((s) => s.vaultPath);
  const activePath = useAppStore((s) => s.activePath);
  const generation = useAppStore(s => s.getVaultGeneration());
  const context = `${open}\0${vaultPath}\0${generation}\0${activePath}`;
  const contextRef = useRef(context);
  contextRef.current = context;
  const recoveryRequest = useRef(0);
  const listActiveTextRevisions = useAppStore((s) => s.listActiveTextRevisions);
  const restoreTextRevision = useAppStore((s) => s.restoreTextRevision);
  const purgeTextRevision = useAppStore((s) => s.purgeTextRevision);
  const content = useAppStore((s) => s.content);
  const restoreRecoveryEntry = useAppStore((s) => s.restoreRecoveryEntry);
  const [recoveryEntries, setRecoveryEntries] = useState<RecoveryEntry[] | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState("");
  const [recoveryLimit, setRecoveryLimit] = useState(RECOVERY_PAGE_SIZE);
  const [recoveryQuery, setRecoveryQuery] = useState("");
  const [revisionMessage, setRevisionMessage] = useState("");
  const [revisionBusy, setRevisionBusy] = useState(false);
  const [revisionLimit, setRevisionLimit] = useState(REVISION_PAGE_SIZE);
  const [revisionQuery, setRevisionQuery] = useState("");
  const [previewRevisionId, setPreviewRevisionId] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<Awaited<ReturnType<typeof listActiveTextRevisions>>>([]);
  const revisionsRef = useRef<HTMLDivElement>(null);
  const handledRevisionHistoryRequest = useRef(0);
  const visibleRecovery = recoveryEntries?.filter((entry) => entry.originalRelPath.toLowerCase().includes(recoveryQuery.trim().toLowerCase())) ?? [];
  const visibleRevisions = revisions.filter((revision) => `${revision.content} ${new Date(revision.savedAt).toLocaleString()}`.toLowerCase().includes(revisionQuery.trim().toLowerCase()));

  const refreshRecovery = useCallback(async () => {
    if (!vaultPath) return;
    const request = ++recoveryRequest.current;
    const current = () => contextRef.current === context && recoveryRequest.current === request;
    setRecoveryBusy(true);
    setRecoveryMessage("");
    try {
      const entries = await listRecoveryEntries(vaultPath);
      if (!current()) return;
      setRecoveryEntries(entries);
      setRecoveryLimit(RECOVERY_PAGE_SIZE);
      setRecoveryQuery("");
      setRecoveryMessage(
        entries.length
          ? `${entries.length} item${entries.length === 1 ? "" : "s"} ready to restore.`
          : "Recovery storage is empty."
      );
    } catch (error) {
      if (current()) setRecoveryMessage(`Could not check recovery storage: ${String(error)}`);
    } finally {
      if (current()) setRecoveryBusy(false);
    }
  }, [vaultPath, context]);

  // A recovery action from the file menu must arrive at useful information,
  // not an empty Settings panel that asks the user to discover a second step.
  useEffect(() => {
    setRecoveryEntries(null); setRecoveryBusy(false); setRecoveryMessage("");
    if (open && section === "deleted" && vaultPath) void refreshRecovery();
  }, [open, section, vaultPath, generation, activePath, refreshRecovery]);

  // The editor's History action is contextual recovery, not a generic Settings
  // shortcut. Wait for the modal's revision query to render, then move focus
  // and the viewport to the document's own saved versions.
  useEffect(() => {
    if (!open || revisionHistoryRequest === 0 || revisionHistoryRequest === handledRevisionHistoryRequest.current) return;
    handledRevisionHistoryRequest.current = revisionHistoryRequest;
    const frame = requestAnimationFrame(() => {
      revisionsRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
      revisionsRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, revisionHistoryRequest, revisions.length]);

  useEffect(() => {
    let current = true;
    setRevisions([]); setRevisionBusy(false); setRevisionMessage(""); setPreviewRevisionId(null);
    if (!open || section !== "history") { setRevisions([]); return () => { current = false; }; }
    void listActiveTextRevisions().then((entries) => {
      if (current) { setRevisions(entries); setRevisionLimit(REVISION_PAGE_SIZE); }
    }).catch(error => { if (current) setRevisionMessage(`Could not load history: ${String(error)}`); });
    return () => { current = false; };
  }, [open, section, vaultPath, generation, activePath, listActiveTextRevisions]);

  const restoreEntry = async (entry: RecoveryEntry) => {
    if (!vaultPath) return;
    setRecoveryBusy(true);
    setRecoveryMessage("");
    try {
      const restored = await restoreRecoveryEntry(entry);
      if (contextRef.current !== context) return;
      setRecoveryEntries((entries) =>
        entries?.filter((e) => e.trashRelPath !== entry.trashRelPath) ?? null
      );
      setRecoveryMessage(`Restored ${restored.relPath}.`);
    } catch (error) {
      if (contextRef.current === context) setRecoveryMessage(`Restore failed: ${String(error)}`);
    } finally {
      if (contextRef.current === context) setRecoveryBusy(false);
    }
  };

  const restoreRevision = async (revisionId: string) => {
    setRevisionBusy(true);
    setRevisionMessage("");
    try {
      await restoreTextRevision(revisionId);
      if (contextRef.current !== context) return;
      const entries = await listActiveTextRevisions();
      if (contextRef.current !== context) return;
      setRevisions(entries);
      setRevisionMessage("Revision restored.");
    } catch (error) {
      if (contextRef.current === context) setRevisionMessage(`Restore failed: ${String(error)}`);
    } finally {
      if (contextRef.current === context) setRevisionBusy(false);
    }
  };

  const removeRevision = async (revisionId: string) => {
    setRevisionBusy(true);
    setRevisionMessage("");
    try {
      await purgeTextRevision(revisionId);
      if (contextRef.current !== context) return;
      const entries = await listActiveTextRevisions();
      if (contextRef.current !== context) return;
      setRevisions(entries);
      setPreviewRevisionId((selected) => selected === revisionId ? null : selected);
      setRevisionMessage("Revision removed. The vault file was not changed.");
    } catch (error) {
      if (contextRef.current === context) setRevisionMessage(`Could not remove revision: ${String(error)}`);
    } finally {
      if (contextRef.current === context) setRevisionBusy(false);
    }
  };

  const previewRevision = revisions.find((revision) => revision.id === previewRevisionId) ?? null;

  if (!open) return null;

  return (
    <Modal onClose={() => setOpen(false)} className="settings" title={section === "history" ? "Document history" : section === "deleted" ? "Deleted files" : "Settings"}>
      <header className="modal-head">
        <span>{section === "history" ? "Document history" : section === "deleted" ? "Deleted files" : "Settings"}</span>
        <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">
          ×
        </button>
      </header>
      <div className="settings-body">
        {section === "settings" && <>
        <div className="setting-row theme-setting-row">
          <div className="setting-name">Appearance</div>
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
            <div className="setting-name">Workspace layout</div>
            <div className="setting-desc">
              Set up panels for writing, reading, or research. Adjust them anytime.
            </div>
          </div>
          <div className="seg" aria-label="Workspace layout">
            <button className="seg-btn" onClick={() => applyWorkspacePreset("write")}>Write</button>
            <button className="seg-btn" onClick={() => applyWorkspacePreset("read")}>Read</button>
            <button className="seg-btn" onClick={() => applyWorkspacePreset("research")}>Research</button>
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-meta">
            <div className="setting-name">File tabs</div>
            <div className="setting-desc">
              Show open files above the editor.
            </div>
          </div>
          <Toggle
            label="File tabs"
            on={settings.enableTabs}
            onChange={(v) => setSetting("enableTabs", v)}
          />
        </div>

        <div className="setting-row">
          <div className="setting-meta">
            <div className="setting-name">Preview delay</div>
            <div className="setting-desc">
              Wait before showing a preview on hover.
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
            <div className="setting-name">Smooth graph motion</div>
            <div className="setting-desc">
              May improve graph motion. Applies when the graph next opens.
            </div>
          </div>
          <Toggle
            label="Smooth graph motion"
            on={settings.hardwareAccel}
            onChange={(v) => setSetting("hardwareAccel", v)}
          />
        </div>

        <div className="setting-row">
          <div className="setting-meta">
            <div className="setting-name">Interface animations</div>
            <div className="setting-desc">Move and fade interface elements.</div>
          </div>
          <Toggle
            label="Interface animations"
            on={settings.animations}
            onChange={(v) => setSetting("animations", v)}
          />
        </div>

        <div className="setting-row">
          <div className="setting-meta">
            <div className="setting-name">Auto-hide sidebar</div>
            <div className="setting-desc">
              Reveal the sidebar when the pointer reaches the left edge.
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

        <div className="setting-row"><div className="setting-meta"><div className="setting-name">Hide generated files</div><div className="setting-desc">Hide archives and conflict copies in the sidebar. Search still finds them.</div></div><Toggle label="Hide generated files" on={settings.hideGeneratedFiles} onChange={value => setSetting("hideGeneratedFiles", value)} /></div>
        </>}
        {section === "deleted" && <div className="setting-row recovery-setting-row">
          <div className="setting-meta">
            <div className="setting-name">Recovery storage</div>
            <div className="setting-desc">
              Restore local and synced deletions. Files remain in this vault’s hidden .mesa-trash folder until you remove them outside Mesa; there is no automatic expiry. Restoring an occupied name creates a separate copy.
            </div>
            {recoveryMessage ? (
              <div className="setting-desc recovery-message">{recoveryMessage}</div>
            ) : null}
            {recoveryEntries?.length ? (
              <div className="recovery-list">
                <input
                  className="text-input recovery-filter"
                  aria-label="Search recovery storage"
                  placeholder="Search recovery items…"
                  value={recoveryQuery}
                  onChange={(event) => { setRecoveryQuery(event.target.value); setRecoveryLimit(RECOVERY_PAGE_SIZE); }}
                />
                {visibleRecovery.slice(0, recoveryLimit).map((entry) => (
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
                {visibleRecovery.length > recoveryLimit ? (
                  <button
                    className="seg-btn"
                    disabled={recoveryBusy}
                    onClick={() => setRecoveryLimit((limit) => limit + RECOVERY_PAGE_SIZE)}
                  >
                    Show {Math.min(RECOVERY_PAGE_SIZE, visibleRecovery.length - recoveryLimit)} more
                  </button>
                ) : null}
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
        </div>}

        {section === "history" && <div className="setting-row recovery-setting-row" ref={revisionsRef} tabIndex={-1}>
          <div className="setting-meta">
            <div className="setting-name">Text revision history</div>
            <div className="setting-desc">
              Restore an earlier saved version of this text file. History is local to this device, with up to 20 versions per file and a shared 2 million character budget. Older versions are pruned first; the newest version may exceed that budget. History does not sync.
            </div>
            <div className="setting-desc">
              {activePath ? activePath : "Open a text file to see local revisions."}
            </div>
            {revisionMessage ? (
              <div className="setting-desc recovery-message">{revisionMessage}</div>
            ) : null}
            {!revisions.length && <p className="setting-desc">No saved revisions for this document yet.</p>}
            {revisions.length ? (
              <div className="recovery-list">
                <input
                  className="text-input recovery-filter"
                  aria-label="Search revision history"
                  placeholder="Search saved revisions…"
                  value={revisionQuery}
                  onChange={(event) => { setRevisionQuery(event.target.value); setRevisionLimit(REVISION_PAGE_SIZE); }}
                />
                {visibleRevisions.slice(0, revisionLimit).map((revision) => (
                  <div className="recovery-row" key={revision.id}>
                    <span title={`Local revision · ${revision.content.length.toLocaleString()} characters · ${new Date(revision.savedAt).toLocaleString()}`}>
                      Local · {new Date(revision.savedAt).toLocaleString()} · {revision.content.length.toLocaleString()} chars
                    </span>
                    <button
                      className="seg-btn"
                      disabled={revisionBusy}
                      onClick={() => setPreviewRevisionId(revision.id)}
                    >
                      Compare
                    </button>
                    <button
                      className="seg-btn"
                      disabled={revisionBusy}
                      onClick={() => void restoreRevision(revision.id)}
                    >
                      Restore
                    </button>
                    <button
                      className="seg-btn"
                      disabled={revisionBusy}
                      title="Remove this local revision only; the current vault file is unchanged"
                      onClick={() => void removeRevision(revision.id)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                {visibleRevisions.length > revisionLimit ? (
                  <button
                    className="seg-btn"
                    disabled={revisionBusy}
                    onClick={() => setRevisionLimit((limit) => limit + REVISION_PAGE_SIZE)}
                  >
                    Show {Math.min(REVISION_PAGE_SIZE, visibleRevisions.length - revisionLimit)} more
                  </button>
                ) : null}
                {previewRevision ? (
                  <div className="revision-compare" aria-label="Revision comparison">
                    <strong>Open document</strong>
                    <strong>Saved revision</strong>
                    <pre>{content}</pre>
                    <pre>{previewRevision.content}</pre>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>}
      </div>
    </Modal>
  );
}
