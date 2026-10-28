import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../store";
import {
  fetchRemoteVaultInfo,
  peerFromDiscovery,
  type DiscoveredSyncPeer,
  type RemoteVaultInfo,
} from "../lib/syncUi";
import { parsePeerInput } from "../lib/pairing";
import { refreshDiscoveredPeers } from "../lib/discoveryPeers";
import { syncDiscovery } from "../lib/serialResource";
import { IN_TAURI } from "../lib/vault";
import { Modal } from "./Modal";

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Welcome-screen flow for opening a vault another device is sharing.
 *
 * Steps: pick a nearby device (or type an address/pairing code) and enter the
 * sync key → we probe it to confirm the key + reach → the user picks a local
 * folder and we clone into it. Nearby search shares SyncModal's discovery
 * owner and starts only after the user asks for it in this open dialog.
 */
export function ConnectVaultModal({ onClose }: { onClose: () => void }) {
  const receiveSharedVault = useAppStore((s) => s.receiveSharedVault);
  const savedKey = useAppStore((s) => s.settings.syncToken);
  const savedPort = useAppStore((s) => s.settings.syncPort);
  const vaultName = useAppStore((s) => s.vaultName);

  const [nearby, setNearby] = useState<Record<string, DiscoveredSyncPeer>>({});
  const [selected, setSelected] = useState<string>(""); // address
  const [manual, setManual] = useState("");
  const [key, setKey] = useState(savedKey ?? "");
  const [phase, setPhase] = useState<"pick" | "checking" | "ready" | "cloning">("pick");
  const [info, setInfo] = useState<RemoteVaultInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);

  // Saved keys load on demand; keep anything the user already typed.
  useEffect(() => {
    void useAppStore.getState().loadSyncSecrets().then(() => {
      const saved = useAppStore.getState().settings.syncToken;
      setKey(current => current || saved);
    }).catch(() => undefined);
  }, []);

  // Discovery consent lasts only while this dialog is open.
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    if (!IN_TAURI || !searching) return;
    let alive = true;
    // Announce as a browser (not listening) so discovery is mutual.
    const release = syncDiscovery({ name: vaultName || "Mesa device", port: savedPort, listening: false }, (packet) => {
      const peer = peerFromDiscovery(packet);
      if (!peer || !alive || !peer.listening) return; // only devices sharing
      setNearby((cur) => refreshDiscoveredPeers(cur, peer));
    });
    const timer = setInterval(() => setNearby((cur) => refreshDiscoveredPeers(cur)), 5000);
    return () => { alive = false; clearInterval(timer); release(); };
  }, [searching, vaultName, savedPort]);

  const discovered = useMemo(
    () =>
      Object.values(nearby)
        .filter((p) => Date.now() - p.seenAt < 20_000)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [nearby]
  );

  const chosenAddress = useMemo(() => {
    if (manual.trim()) return parsePeerInput(manual, savedPort);
    return selected || null;
  }, [manual, selected, savedPort]);

  const chosenName = useMemo(() => {
    if (!selected) return undefined;
    return discovered.find((p) => p.address === selected)?.name;
  }, [selected, discovered]);

  const canConnect = !!chosenAddress && key.trim().length > 0 && phase === "pick";

  const connect = async () => {
    if (!chosenAddress) return;
    setError(null);
    setPhase("checking");
    try {
      const vaultInfo = await fetchRemoteVaultInfo(chosenAddress, key.trim());
      setInfo(vaultInfo);
      setPhase("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("pick");
    }
  };

  const clone = async () => {
    if (!chosenAddress) return;
    setError(null);
    setPhase("cloning");
    cancelled.current = false;
    try {
      const result = await receiveSharedVault({
        address: chosenAddress,
        token: key.trim(),
        name: chosenName,
        // Pin the certificate we just verified during the probe.
        fingerprint: info?.fingerprint,
      });
      if (result === null) {
        // User cancelled the folder picker — back to the ready step.
        if (!cancelled.current) setPhase("ready");
        return;
      }
      onClose(); // vault opened; welcome screen is gone
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("ready");
    }
  };

  const pickPeer = (address: string) => {
    setSelected(address);
    setManual("");
    setInfo(null);
    if (phase !== "pick") setPhase("pick");
  };

  return (
    <Modal onClose={onClose} className="connect-vault" title="Open a shared vault">
      <header className="modal-head">
        <span>Open a shared vault</span>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>

      <div className="cv-body">
        {!IN_TAURI && (
          <div className="setting-desc">
            Sync runs only in the desktop app.
          </div>
        )}

        <p className="cv-intro">
          Pull a vault from another one of your devices that's currently{" "}
          <b>receiving</b>. Pick it below or enter its pairing code, and you'll
          choose where to save it after connecting.
        </p>

        {/* Nearby devices */}
        <div className="cv-section">
          <div className="cv-section-title">Nearby devices</div>
          {!searching ? (
            <div className="cv-empty">
              <span>
                Searching broadcasts this device’s name and certificate
                fingerprint on the local network and stops when this dialog
                closes.
              </span>
              <button
                type="button"
                className="btn"
                disabled={!IN_TAURI}
                onClick={() => setSearching(true)}
              >
                Search nearby devices
              </button>
            </div>
          ) : discovered.length === 0 ? (
            <div className="cv-empty" role="status">
              <span className="cv-radar" aria-hidden />
              Looking for devices… open Sync on another device and turn on
              <b> Receive</b>.
            </div>
          ) : (
            <div className="cv-peer-list">
              {discovered.map((p) => (
                <button
                  key={p.id}
                  className={"cv-peer" + (selected === p.address ? " on" : "")}
                  onClick={() => pickPeer(p.address)}
                >
                  <span className="cv-peer-dot" />
                  <span className="cv-peer-body">
                    <span className="cv-peer-name">{p.name}</span>
                    <span className="cv-peer-addr">{p.address}</span>
                  </span>
                  {selected === p.address && <span className="cv-check">✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Manual entry */}
        <div className="cv-section">
          <div className="cv-section-title">Or enter an address</div>
          <input
            className="text-input"
            placeholder="#ABC-1234, LAN IP, or Tailscale name"
            value={manual}
            spellCheck={false}
            onChange={(e) => {
              setManual(e.target.value);
              setSelected("");
              setInfo(null);
              if (phase !== "pick") setPhase("pick");
            }}
          />
        </div>

        {/* Sync key */}
        <div className="cv-section">
          <div className="cv-section-title">Sync key</div>
          <input
            className="text-input"
            type="password"
            placeholder="the same key set on the sharing device"
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setInfo(null);
              if (phase !== "pick") setPhase("pick");
            }}
          />
        </div>

        {info && phase !== "pick" && (
          <div className="cv-found">
            <span className="cv-found-icon">✦</span>
            <span>
              Connected — <b>{info.files}</b> file{info.files === 1 ? "" : "s"}
              {info.bytes ? ` · ${humanBytes(info.bytes)}` : ""}. Choose a folder
              to save this vault.
            </span>
          </div>
        )}

        {error && <div className="cv-error">{error}</div>}
      </div>

      <footer className="cv-foot">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        {phase === "ready" || phase === "cloning" ? (
          <button
            className="btn primary"
            disabled={phase === "cloning"}
            onClick={() => void clone()}
          >
            {phase === "cloning" ? "Downloading…" : "Choose folder & download"}
          </button>
        ) : (
          <button
            className="btn primary"
            disabled={!canConnect}
            onClick={() => void connect()}
          >
            {phase === "checking" ? "Connecting…" : "Connect"}
          </button>
        )}
      </footer>
    </Modal>
  );
}
