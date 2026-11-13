import { invoke } from "@tauri-apps/api/core";
import { refreshDiscoveredPeers } from "../lib/discoveryPeers";
import { syncDiscovery } from "../lib/serialResource";
import { SyncConflictReview } from "./SyncConflictReview";
import { useEffect, useMemo, useState } from "react";
import { MAX_AUTO_SYNC_MINUTES, normalizeAutoSyncMinutes } from "../lib/syncAutoSchedule";
import { useAppStore } from "../store";
import {
  syncServerRunning,
  localSyncAddr,
  peerFromDiscovery,
  syncIdentity,
  formatFingerprint,
  IS_WINDOWS,
  DISCOVERY_QUIET_MS,
  windowsFirewallHint,
  type DiscoveredSyncPeer,
} from "../lib/syncUi";
import { encodePairing, isValidSyncPort } from "../lib/pairing";
import { generateSyncKey, validSyncKey } from "../lib/syncKey";
import { SYNC_KEYS_DAMAGED } from "../lib/syncSecrets";
import { IN_TAURI } from "../lib/vault";
import { Modal } from "./Modal";
import { SecretInput, Toggle, PeerRow } from "./SyncPeerRow";
import { SyncConsole } from "./SyncConsole";

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
  const [peerError, setPeerError] = useState("");
  const [localIp, setLocalIp] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [myFp, setMyFp] = useState<string | null>(null);
  const [nearby, setNearby] = useState<Record<string, DiscoveredSyncPeer>>({});
  const [discoveryQuiet, setDiscoveryQuiet] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const settingsIssue = useAppStore((s) => s.settingsIssue);
  const resetSyncKeys = useAppStore((s) => s.resetSyncKeys);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetTyped, setResetTyped] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const keysDamaged = [settingsIssue, status].some((text) => typeof text === "string" && text.includes(SYNC_KEYS_DAMAGED));

  useEffect(() => {
    if (!open) return;
    void useAppStore.getState().loadSyncSecrets().catch(() => undefined);
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
    const shouldDiscover = settings.syncEnabled && settings.syncDiscovery && open;
    if (!shouldDiscover) return;
    let alive = true;
    // The quiet window starts only once the socket is bound.
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const release = syncDiscovery(
      { name: settings.syncDeviceName.trim() || vaultName || "Mesa device", port: settings.syncPort, listening },
      (packet) => {
        const peer = peerFromDiscovery(packet);
        if (!peer || !alive) return;
        setNearby((current) => refreshDiscoveredPeers(current, peer));
      },
      (started) => {
        if (!alive) return;
        if (!started.ok) { setDiscoveryError(String(started.error)); return; }
        setDiscoveryError(null);
        quiet ??= setTimeout(() => setDiscoveryQuiet(true), DISCOVERY_QUIET_MS);
      },
    );
    return () => { alive = false; clearTimeout(quiet); setDiscoveryQuiet(false); setDiscoveryError(null); release(); };
  }, [
    open,
    listening,
    settings.syncEnabled,
    settings.syncDiscovery,
    settings.syncPort,
    settings.syncDeviceName,
    vaultName,
  ]);

  useEffect(() => {
    if (!open) return;
    setNearby(current => refreshDiscoveredPeers(current));
    const timer = setInterval(() => setNearby(current => refreshDiscoveredPeers(current)), 5000);
    return () => clearInterval(timer);
  }, [open]);

  const myCode = useMemo(
    () => { const address = settings.syncBindAddress === "0.0.0.0" ? localIp : settings.syncBindAddress; return address ? encodePairing(address, settings.syncPort) : null; },
    [localIp, settings.syncPort, settings.syncBindAddress]
  );
  const hasKey = validSyncKey(settings.syncToken);
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

  // Discovery consent lasts only while the dialog is open. App unmounts the
  // lazy modal on close, so revoke in cleanup rather than on `open === false`.
  useEffect(() => {
    if (!open) return;
    return () => {
      const state = useAppStore.getState();
      if (state.settings.syncDiscovery) state.setSetting("syncDiscovery", false);
    };
  }, [open]);

  if (!open) return null;

  const submitPeer = () => {
    const id = addPeer(peerInput, peerName);
    if (id) {
      setPeerInput("");
      setPeerName("");
      setPeerError("");
    } else {
      setPeerError(
        "Enter a valid pairing code, IP address, hostname, or http(s) URL."
      );
    }
  };

  const copyCode = (text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const enabled = settings.syncEnabled;

  return (
    <Modal onClose={() => setOpen(false)} className="settings sync" title="Device sync">
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
            label="Sync"
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
                  Use the same key on every device. Generate a 256-bit key for
                  secure transfer. Use a generated 64-character lowercase hex key on each device.
                </div>
              </div>
              <SecretInput value={settings.syncToken} label="Sync key" onCommit={value => setSetting("syncToken", value)} />
              <button type="button" className="link-btn" onClick={() => {
                if (!IN_TAURI) { setSetting("syncToken", generateSyncKey()); return; }
                void invoke<string>("sync_secrets_generate").then(key => setSetting("syncToken", key)).catch(error => useAppStore.setState({ syncStatus: String(error) }));
              }}>Generate key</button>
              {IN_TAURI && keysDamaged && <div className="setting-desc sync-note" role="alert">
                Saved sync keys are damaged or incomplete, so sync is off until
                you reset them. Reset removes every saved key, including keys
                for your devices, and makes a new sync key. Every device must
                then pair again with the new key.
              </div>}
              {IN_TAURI && keysDamaged && <button type="button" className="link-btn" onClick={() => { setResetTyped(""); setResetOpen(true); }}>Reset sync keys…</button>}
              {IN_TAURI && settings.syncToken.startsWith("credential:") && <button type="button" className="link-btn" onClick={() => {
                void invoke("sync_secrets_show", { reference: settings.syncToken }).catch(error => useAppStore.setState({ syncStatus: String(error) }));
              }}>Show key in native dialog</button>}
            </div>

            {/* Receive — LocalSend-style hero */}
            <div className="sync-section sync-receive">
              <div className="sync-receive-head">
                <div className="setting-meta">
                  <div className="setting-name">Receive</div>
                  <div className="setting-desc">
                    Accept authenticated connections on the selected address.
                    Nearby discovery is a separate, temporary choice.
                  </div>
                </div>
                <Toggle
                  label="Receive"
                  on={listening}
                  disabled={!canReceive}
                  onChange={() => void toggleListen()}
                />
              </div>
              <label className="setting-desc">Listen address
                <input className="text-input" aria-label="Sync listen address"
                  value={settings.syncBindAddress}
                  onChange={e => setSetting("syncBindAddress", e.target.value)} />
                Use this device’s LAN or Tailscale IP. Loopback is the default; 0.0.0.0 explicitly allows all IPv4 interfaces.
              </label>
              <div className="sync-device-name">
                <span className="sync-fingerprint-label">
                  Appears to other devices as
                </span>
                <input
                  className="text-input sync-device-name-input"
                  value={settings.syncDeviceName}
                  spellCheck={false}
                  aria-label="This device's name"
                  onChange={(e) => setSetting("syncDeviceName", e.target.value)}
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
                  Turn on LAN discovery in Advanced for this open dialog. It broadcasts this device’s name and certificate fingerprint on the local network and stops when the dialog closes.
                </div>
              ) : discoveryError ? (
                <div className="setting-desc sync-note" role="alert">
                  LAN discovery could not start on this device: {discoveryError}.
                  Another app may be using UDP port 47887. Add devices by
                  address in Advanced instead.
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

            {windowsFirewallHint({ windows: IS_WINDOWS, discoveryQuiet, nearbyCount: discoveredPeers.length, peers }) && (
              <div className="setting-desc sync-note" role="note">
                No device answered? Windows Firewall can block Mesa. If
                Windows asked about Mesa, allow it on private networks. If this
                network is set to Public, set it to Private in Settings &gt;
                Network &amp; internet, or allow Mesa in “Allow an app through
                firewall”. Check the other device too if it runs Windows.
              </div>
            )}

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
            <SyncConflictReview />
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
                    label="LAN discovery"
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
                    min={1}
                    max={65535}
                    step={1}
                    aria-label="Sync port"
                    style={{ width: 90 }}
                    value={settings.syncPort}
                    onChange={(e) => {
                      const port = e.currentTarget.valueAsNumber;
                      if (isValidSyncPort(port)) setSetting("syncPort", port);
                    }}
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
                    max={MAX_AUTO_SYNC_MINUTES}
                    aria-label="Auto-sync interval in minutes"
                    style={{ width: 90 }}
                    value={settings.syncAutoMinutes}
                    onChange={(e) =>
                      setSetting(
                        "syncAutoMinutes",
                        normalizeAutoSyncMinutes(Number(e.target.value))
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
                      aria-label="Device address or pairing code"
                      aria-invalid={peerError ? true : undefined}
                      aria-describedby={peerError ? "sync-peer-error" : undefined}
                      placeholder="#ABC-1234, LAN IP, or Tailscale name"
                      onChange={(e) => {
                        setPeerInput(e.target.value);
                        if (peerError) setPeerError("");
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") submitPeer();
                      }}
                    />
                    <input
                      className="text-input pair-name"
                      value={peerName}
                      aria-label="Device name"
                      placeholder="name (optional)"
                      onChange={(e) => setPeerName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") submitPeer();
                      }}
                    />
                    <button
                      className="btn"
                      disabled={!peerInput.trim()}
                      onClick={submitPeer}
                    >
                      Add
                    </button>
                  </div>
                  {peerError && (
                    <div
                      id="sync-peer-error"
                      className="setting-error"
                      role="alert"
                    >
                      {peerError}
                    </div>
                  )}
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
      {resetOpen && <Modal title="Reset sync keys" onClose={() => setResetOpen(false)}>
        <div className="modal-head">Reset all saved sync keys?</div>
        <div className="modal-body">
          <p>This removes this device's sync key and every saved device key, then makes a new sync key. Your notes are not changed. Every device must pair again with the new key.</p>
          <label>Type RESET to confirm
            <input className="text-input" aria-label="Type RESET to confirm" value={resetTyped} onChange={e => setResetTyped(e.target.value)} />
          </label>
          <button className="btn" disabled={resetTyped !== "RESET" || resetBusy} onClick={() => {
            setResetBusy(true);
            void resetSyncKeys()
              .then(() => { setResetOpen(false); useAppStore.setState({ syncStatus: "Sync keys reset. Pair every device again with the new key." }); })
              .catch(error => useAppStore.setState({ syncStatus: `Sync keys were not reset: ${String(error)}` }))
              .finally(() => setResetBusy(false));
          }}>Reset sync keys</button>
          <button className="btn ghost" onClick={() => setResetOpen(false)}>Cancel</button>
        </div>
      </Modal>}
    </Modal>
  );
}
