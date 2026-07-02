import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../store";
import {
  syncServerRunning,
  localSyncAddr,
  peerFromDiscovery,
  startSyncDiscovery,
  stopSyncDiscovery,
  syncIdentity,
  formatFingerprint,
  cancelSync,
  type DiscoveredSyncPeer,
  type DiscoveryPacket,
  type SyncProgress,
} from "../lib/sync";
import {
  buildTroubleshootingPackage,
  formatLogLine,
} from "../lib/syncDiagnostics";
import { encodePairing } from "../lib/pairing";
import { IN_TAURI } from "../lib/vault";
import { Modal } from "./Modal";
import type { SyncPeer } from "../types";

function Toggle({
  on,
  onChange,
  disabled = false,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      className={"toggle" + (on ? " on" : "")}
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onChange(!on);
      }}
    >
      <span className="toggle-knob" />
    </button>
  );
}

function relTime(ms?: number): string {
  if (!ms) return "never";
  const d = Date.now() - ms;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

function PeerRow({ peer }: { peer: SyncPeer }) {
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
              <input
                className="text-input"
                type="password"
                placeholder="optional — overrides the sync key"
                value={peer.token ?? ""}
                onChange={(e) =>
                  updatePeer(peer.id, { token: e.target.value || undefined })
                }
              />
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

function progressLabel(p: SyncProgress | null): string {
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

/**
 * Embedded sync console — appears as soon as a sync starts. Shows the live
 * structured log streamed from the Rust engine plus a progress bar, and can
 * copy a self-contained, secret-scrubbed troubleshooting package (markdown)
 * to paste at an LLM or a bug report.
 */
function SyncConsole() {
  const log = useAppStore((s) => s.syncLog);
  const progress = useAppStore((s) => s.syncProgress);
  const busy = useAppStore((s) => s.syncBusy);
  const report = useAppStore((s) => s.syncReport);
  const lastPeerId = useAppStore((s) => s.syncLastPeerId);
  const listening = useAppStore((s) => s.syncListening);
  const settings = useAppStore((s) => s.settings);
  const fileCount = useAppStore((s) => s.files.length);
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
    const peer = settings.peers.find((p) => p.id === lastPeerId);
    const pkg = buildTroubleshootingPackage({
      appVersion,
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

  return (
    <div className="sync-section sync-console">
      <div className="sync-section-title">
        <span>Sync console</span>
        <span className="sync-console-actions">
          {busy && (
            <button
              className="link-btn danger"
              onClick={() => void cancelSync()}
              title="Stop after the transfers already in flight"
            >
              Cancel
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

export function SyncModal() {
  const open = useAppStore((s) => s.syncOpen);
  const setOpen = useAppStore((s) => s.setSyncOpen);
  const vaultName = useAppStore((s) => s.vaultName);
  const settings = useAppStore((s) => s.settings);
  const setSetting = useAppStore((s) => s.setSetting);
  const listening = useAppStore((s) => s.syncListening);
  const busy = useAppStore((s) => s.syncBusy);
  const status = useAppStore((s) => s.syncStatus);
  const toggleListen = useAppStore((s) => s.toggleListen);
  const syncAll = useAppStore((s) => s.syncAll);
  const addPeer = useAppStore((s) => s.addPeer);
  const peers = settings.peers;

  const [peerInput, setPeerInput] = useState("");
  const [peerName, setPeerName] = useState("");
  const [localIp, setLocalIp] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [myFp, setMyFp] = useState<string | null>(null);
  const [nearby, setNearby] = useState<Record<string, DiscoveredSyncPeer>>({});

  useEffect(() => {
    if (!open) return;
    void syncServerRunning().then((running) => {
      if (running !== useAppStore.getState().syncListening) {
        useAppStore.setState({ syncListening: running });
      }
    });
    void localSyncAddr().then(setLocalIp);
    void syncIdentity().then(setMyFp);
  }, [open]);

  useEffect(() => {
    if (!IN_TAURI) return;
    let alive = true;
    let unlisten: (() => void) | null = null;
    const shouldDiscover =
      settings.syncEnabled && settings.syncDiscovery && (open || listening);

    if (!shouldDiscover) {
      void stopSyncDiscovery().catch(() => {});
      return;
    }

    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<DiscoveryPacket>("sync://discovered", (event) => {
          const peer = peerFromDiscovery(event.payload);
          if (!peer || !alive) return;
          setNearby((current) => ({ ...current, [peer.id]: peer }));
        });
        await startSyncDiscovery(vaultName || "Mesa device", settings.syncPort, listening);
      } catch {
        /* Discovery is best-effort. Sync still works through manual pairing. */
      }
    })();

    return () => {
      alive = false;
      unlisten?.();
      void stopSyncDiscovery().catch(() => {});
    };
  }, [
    open,
    listening,
    settings.syncEnabled,
    settings.syncDiscovery,
    settings.syncPort,
    vaultName,
  ]);

  const myCode = useMemo(
    () => (localIp ? encodePairing(localIp, settings.syncPort) : null),
    [localIp, settings.syncPort]
  );
  const hasKey = settings.syncToken.trim().length > 0;
  const canReceive = settings.syncEnabled && hasKey;

  const sortedPeers = useMemo(
    () =>
      [...peers].sort(
        (a, b) =>
          Number(b.favorite) - Number(a.favorite) ||
          a.name.localeCompare(b.name)
      ),
    [peers]
  );

  const discoveredPeers = useMemo(
    () =>
      Object.values(nearby)
        .filter((p) => Date.now() - p.seenAt < 20_000)
        .filter((p) => !peers.some((saved) => saved.address === p.address))
        .sort((a, b) => Number(b.listening) - Number(a.listening) || a.name.localeCompare(b.name)),
    [nearby, peers]
  );

  if (!open) return null;

  const submitPeer = () => {
    const id = addPeer(peerInput, peerName);
    if (id) {
      setPeerInput("");
      setPeerName("");
    }
  };

  const copyCode = (text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const enabled = settings.syncEnabled;

  return (
    <Modal onClose={() => setOpen(false)} className="settings sync">
      <header className="modal-head">
        <span>Device sync</span>
        <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">
          ×
        </button>
      </header>
      <div className="settings-body">
        {!IN_TAURI && (
          <div className="setting-desc">
            Sync runs only in the desktop app (it needs a local network server).
          </div>
        )}

        {/* Hero: master on/off */}
        <div className="sync-section sync-hero">
          <div className="sync-hero-info">
            <div className="sync-hero-title">Sync</div>
            <div className="setting-desc">
              Send and receive this vault with your own devices over LAN or
              Tailscale. End-to-end encrypted over TLS; your sync key authorizes
              access. Compare the device fingerprints below to be sure you're
              talking to your own device.
            </div>
          </div>
          <Toggle
            on={enabled}
            onChange={(v) => setSetting("syncEnabled", v)}
          />
        </div>

        {enabled && (
          <>
            {/* Sync key (encryption) */}
            <div className="sync-section sync-row">
              <div className="setting-meta">
                <div className="setting-name">Sync key</div>
                <div className="setting-desc">
                  Use the same key on every device. Pairing finds a device; the
                  key unlocks encrypted transfer.
                </div>
              </div>
              <input
                className="text-input sync-key-input"
                type="password"
                placeholder="sync key"
                value={settings.syncToken}
                onChange={(e) => setSetting("syncToken", e.target.value)}
              />
            </div>

            {/* Receive — LocalSend-style hero */}
            <div className="sync-section sync-receive">
              <div className="sync-receive-head">
                <div className="setting-meta">
                  <div className="setting-name">Receive</div>
                  <div className="setting-desc">
                    Be visible to your devices while on. Others pick this device
                    or enter the code.
                  </div>
                </div>
                <Toggle
                  on={listening}
                  disabled={!canReceive}
                  onChange={() => void toggleListen()}
                />
              </div>
              {listening && myCode && (
                <div className="sync-receive-code">
                  <code className="pair-code">{myCode}</code>
                  <button className="btn" onClick={() => copyCode(myCode)}>
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              )}
              {myFp && (
                <div className="sync-fingerprint" title={myFp}>
                  <span className="sync-fingerprint-label">This device's fingerprint</span>
                  <code className="sync-fingerprint-val">{formatFingerprint(myFp)}</code>
                </div>
              )}
              {listening && !myCode && (
                <div className="setting-desc">
                  Couldn't detect a LAN IP automatically. Add a device by
                  Tailscale name or IP in Advanced below.
                </div>
              )}
              {!hasKey && (
                <div className="setting-desc sync-note">
                  Add a sync key to receive files.
                </div>
              )}
            </div>

            {/* Nearby devices */}
            <div className="sync-section">
              <div className="sync-section-title">Nearby devices</div>
              {!settings.syncDiscovery ? (
                <div className="setting-desc">
                  Turn on LAN discovery in Advanced to find nearby devices.
                </div>
              ) : discoveredPeers.length === 0 ? (
                <div className="setting-desc">
                  No nearby Mesa devices found yet. Open Sync on another device
                  on the same network.
                </div>
              ) : (
                <div className="nearby-list">
                  {discoveredPeers.map((peer) => (
                    <div className="nearby-peer" key={peer.id}>
                      <div>
                        <div className="nearby-name">{peer.name}</div>
                        <div className="peer-addr">
                          {peer.address}
                          {peer.listening ? " · listening" : " · menu open"}
                        </div>
                      </div>
                      <button
                        className="btn"
                        onClick={() =>
                          addPeer(peer.address, peer.name, peer.fingerprint)
                        }
                      >
                        Add
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Your devices */}
            <div className="sync-section">
              <div className="sync-section-title">
                <span>Your devices</span>
                {peers.length > 1 && (
                  <button
                    className="link-btn"
                    disabled={busy}
                    onClick={() => void syncAll()}
                  >
                    Sync all
                  </button>
                )}
              </div>
              <div className="peer-list">
                {sortedPeers.length === 0 ? (
                  <div className="setting-desc">
                    No devices yet. Add a nearby device or enter an address in
                    Advanced.
                  </div>
                ) : (
                  sortedPeers.map((p) => <PeerRow key={p.id} peer={p} />)
                )}
              </div>
            </div>

            {/* Embedded console — appears the moment a sync starts */}
            <SyncConsole />

            {/* Advanced — all power-user options in one place */}
            <details className="sync-advanced">
              <summary>Advanced</summary>
              <div className="sync-adv-grid">
                <div className="setting-row">
                  <div className="setting-meta">
                    <div className="setting-name">LAN discovery</div>
                    <div className="setting-desc">
                      Advertise this device's name and address on the local
                      network.
                    </div>
                  </div>
                  <Toggle
                    on={settings.syncDiscovery}
                    onChange={(v) => setSetting("syncDiscovery", v)}
                  />
                </div>
                <div className="setting-row">
                  <div className="setting-meta">
                    <div className="setting-name">Port</div>
                    <div className="setting-desc">
                      Default 8787. Change only if another service uses it.
                    </div>
                  </div>
                  <input
                    className="text-input"
                    type="number"
                    style={{ width: 90 }}
                    value={settings.syncPort}
                    onChange={(e) =>
                      setSetting("syncPort", Number(e.target.value) || 8787)
                    }
                  />
                </div>
                <div className="setting-row">
                  <div className="setting-meta">
                    <div className="setting-name">Auto-sync every</div>
                    <div className="setting-desc">
                      Minutes between automatic syncs of all devices. 0 = manual
                      only.
                    </div>
                  </div>
                  <input
                    className="text-input"
                    type="number"
                    min={0}
                    style={{ width: 90 }}
                    value={settings.syncAutoMinutes}
                    onChange={(e) =>
                      setSetting(
                        "syncAutoMinutes",
                        Math.max(0, Number(e.target.value) || 0)
                      )
                    }
                  />
                </div>
                <div className="sync-adv-manual">
                  <div className="setting-meta">
                    <div className="setting-name">Add a device manually</div>
                    <div className="setting-desc">
                      Pairing code, LAN IP, URL, or Tailscale name.
                    </div>
                  </div>
                  <div className="peer-add">
                    <input
                      className="text-input pair-input"
                      value={peerInput}
                      placeholder="#ABC-1234, LAN IP, or Tailscale name"
                      onChange={(e) => setPeerInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") submitPeer();
                      }}
                    />
                    <input
                      className="text-input pair-name"
                      value={peerName}
                      placeholder="name (optional)"
                      onChange={(e) => setPeerName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") submitPeer();
                      }}
                    />
                    <button className="btn" onClick={submitPeer}>
                      Add
                    </button>
                  </div>
                </div>
                {localIp && (
                  <div className="pair-addr">
                    This device: {localIp}:{settings.syncPort}
                  </div>
                )}
              </div>
            </details>
          </>
        )}

        {!enabled && (
          <div className="setting-desc sync-off-note">
            Turn Sync on to send or receive. Discovery, receiving, and scheduled
            sync all stop while off.
          </div>
        )}
      </div>
      {status && <footer className="settings-foot">{status}</footer>}
    </Modal>
  );
}
