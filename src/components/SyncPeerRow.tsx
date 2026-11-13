import { useState } from "react";
import { useAppStore } from "../store";
import { formatFingerprint } from "../lib/syncUi";
import { validSyncKey } from "../lib/syncKey";
import type { SyncPeer } from "../types";

export function SecretInput({ value, onCommit, label }: { value: string; onCommit: (value: string) => void; label: string }) {
  const [draft, setDraft] = useState("");
  const [issue, setIssue] = useState("");
  return <div>
    <input className="text-input sync-key-input" type="password" aria-label={label}
      autoComplete="off" spellCheck={false}
      placeholder={value ? "Key saved securely — enter to replace" : "Paste a generated sync key"}
      value={draft} onChange={e => setDraft(e.target.value)}
      onBlur={() => {
        if (!draft) return;
        if (!validSyncKey(draft) || draft.startsWith("credential:")) { setIssue("Enter a generated 64-character lowercase hex key."); return; }
        onCommit(draft); setDraft(""); setIssue("");
      }} />
    {issue && <span role="alert">{issue}</span>}
  </div>;
}

export function Toggle({
  label,
  on,
  onChange,
  disabled = false,
}: {
  label: string;
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      className={"toggle" + (on ? " on" : "")}
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onChange(!on);
      }}
    >
      <span className="toggle-knob" />
    </button>
  );
}

export function relTime(ms?: number): string {
  if (!ms) return "never";
  const d = Date.now() - ms;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

export function PeerRow({ peer }: { peer: SyncPeer }) {
  const busy = useAppStore((s) => s.syncBusy);
  const syncEnabled = useAppStore((s) => s.settings.syncEnabled);
  const syncNow = useAppStore((s) => s.syncNow);
  const updatePeer = useAppStore((s) => s.updatePeer);
  const removePeer = useAppStore((s) => s.removePeer);
  const [open, setOpen] = useState(false);
  const [showSecret, setShowSecret] = useState(false);

  const healthLabel =
    peer.lastStatus === "ok"
      ? "healthy"
      : peer.lastStatus === "error"
      ? "error"
      : "unknown";

  return (
    <div className={"peer-card" + (peer.favorite ? " fav" : "")}>
      <div className="peer-card-main">
        <button
          className={"star" + (peer.favorite ? " on" : "")}
          title={peer.favorite ? "Unfavorite" : "Favorite"}
          aria-label="Toggle favorite"
          onClick={() => updatePeer(peer.id, { favorite: !peer.favorite })}
        >
          {peer.favorite ? "★" : "☆"}
        </button>
        <div className="peer-card-info">
          <input
            className="peer-name-input"
            value={peer.name}
            spellCheck={false}
            onChange={(e) => updatePeer(peer.id, { name: e.target.value })}
            aria-label="Device name"
          />
          <div className="peer-card-sub">
            <span
              className={"peer-health " + (peer.lastStatus ?? "unknown")}
              title={
                peer.lastStatus === "error"
                  ? peer.lastError ?? "Last sync failed"
                  : `Last checked: ${relTime(peer.lastChecked)}`
              }
            >
              {healthLabel}
            </span>
            <span className="peer-addr">{peer.address}</span>
          </div>
        </div>
        <div className="peer-card-actions">
          <button
            className="btn"
            disabled={busy || !syncEnabled}
            onClick={() => void syncNow(peer.id)}
          >
            {busy ? "…" : "Sync"}
          </button>
          <button
            className="icon-btn peer-more"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? "Hide details" : "Show details"}
            aria-expanded={open}
          >
            ⋯
          </button>
        </div>
      </div>
      {open && (
        <div className="peer-card-detail">
          <div className="peer-detail-row">
            <span className="peer-detail-label">Last sync</span>
            <span className="peer-detail-val">{relTime(peer.lastSync)}</span>
          </div>
          <div className="peer-detail-row">
            <span className="peer-detail-label">Checked</span>
            <span className="peer-detail-val">{relTime(peer.lastChecked)}</span>
          </div>
          <div className="peer-detail-row">
            <span className="peer-detail-label">Fingerprint</span>
            <span
              className="peer-detail-val peer-detail-fp"
              title={
                peer.fingerprint
                  ? `${peer.fingerprint}\nCompare this with the device's own fingerprint to confirm it's yours.`
                  : "Pinned automatically on the first successful sync."
              }
            >
              {peer.fingerprint ? formatFingerprint(peer.fingerprint) : "not yet trusted"}
            </span>
          </div>
          <div className="peer-card-secret">
            <button
              className="link-btn"
              onClick={() => setShowSecret((v) => !v)}
            >
              {showSecret ? "Hide per-device key" : "Per-device sync key"}
            </button>
            {showSecret && (
              <div><SecretInput value={peer.token ?? ""} label="Per-device sync key" onCommit={value => updatePeer(peer.id, { token: value })} /><button className="link-btn" onClick={() => updatePeer(peer.id, { token: undefined })}>Use shared key</button></div>
            )}
          </div>
          <button
            className="link-btn danger"
            onClick={() => removePeer(peer.id)}
          >
            Remove device
          </button>
        </div>
      )}
    </div>
  );
}
