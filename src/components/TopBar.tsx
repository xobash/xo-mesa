import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "../store";
import { IN_TAURI } from "../lib/vault";
import { vaultMenuPosition } from "../lib/vaultSwitcher";
import { startViewDrag } from "./panelDrag";

/** Vault switcher: the vault name opens a menu of recent vaults plus
 *  "Open vault…". The menu is fixed-positioned so it isn't clipped by the
 *  top bar's overflow. */
function VaultSwitcher() {
  const vaultName = useAppStore((s) => s.vaultName);
  const vaultPath = useAppStore((s) => s.vaultPath);
  const recents = useAppStore((s) => s.recentVaults);
  const openVault = useAppStore((s) => s.openVault);
  const removeRecentVault = useAppStore((s) => s.removeRecentVault);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const ref = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  if (!vaultName) return null;
  const others = recents.filter((r) => r !== vaultPath);
  const currentIsRecent = !!vaultPath && recents.includes(vaultPath);

  return (
    <div className="vault-switcher" ref={ref}>
      <button
        type="button"
        className="vault-name"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setPos(vaultMenuPosition(r, window.innerWidth));
          setOpen((v) => !v);
        }}
        title="Switch vault"
      >
        {vaultName} <span className="vault-caret">▾</span>
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="vault-menu"
          role="menu"
          style={{ left: pos.left, top: pos.top }}
        >
          <div className="vault-menu-current">
            <div className="vault-menu-current-head">
              <div>
                <div className="vault-menu-kicker">Current vault</div>
                <div className="vault-menu-current-name">{vaultName}</div>
              </div>
              {vaultPath && currentIsRecent && (
                <button
                  type="button"
                  className="vault-menu-forget"
                  onClick={() => removeRecentVault(vaultPath)}
                  title="Remove this vault from the recent list"
                  aria-label="Remove current vault from recent list"
                >
                  ✕
                </button>
              )}
            </div>
            {vaultPath && <div className="vault-menu-path">{vaultPath}</div>}
          </div>
          {others.length > 0 && (
            <div className="vault-menu-label">Recent vaults</div>
          )}
          {others.map((r) => (
            <div key={r} className="vault-menu-row">
              <button
                type="button"
                className="vault-menu-item"
                role="menuitem"
                title={r}
                onClick={() => {
                  setOpen(false);
                  void openVault(r);
                }}
              >
                <span className="vault-menu-name">{r.split(/[\\/]/).pop() || r}</span>
                <span className="vault-menu-path">{r}</span>
              </button>
              <button
                type="button"
                className="vault-menu-forget"
                onClick={() => removeRecentVault(r)}
                title="Remove this vault from the recent list"
                aria-label={`Remove ${r.split(/[\\/]/).pop() || r} from recent list`}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            className="vault-menu-open"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void openVault();
            }}
          >
            <span>＋</span>
            Open another vault
          </button>
        </div>,
        document.body
      )}
    </div>
  );
}

export function TopBar() {
  const rightStack = useAppStore((s) => s.settings.rightStack);
  const centerView = useAppStore((s) => s.settings.centerView);
  const graphFull = useAppStore((s) => s.graphFull);
  const togglePanel = useAppStore((s) => s.togglePanel);
  const toggleGraphFull = useAppStore((s) => s.toggleGraphFull);
  const openPanelWindow = useAppStore((s) => s.openPanelWindow);
  const removeViewFromWorkspace = useAppStore((s) => s.removeViewFromWorkspace);
  const setSearch = useAppStore((s) => s.setSearch);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const setSyncOpen = useAppStore((s) => s.setSyncOpen);
  const syncListening = useAppStore((s) => s.syncListening);
  const setHelpOpen = useAppStore((s) => s.setHelpOpen);
  const sidebarOpen = useAppStore((s) => s.settings.sidebarOpen);
  const sidebarAutoHide = useAppStore((s) => s.settings.sidebarAutoHide);
  const setSetting = useAppStore((s) => s.setSetting);
  const shows = (v: "preview" | "graph" | "tasks") =>
    centerView === v || rightStack.includes(v);

  // The sidebar is "docked" only when it's open and not in auto-hide mode.
  const sidebarDocked = sidebarOpen && !sidebarAutoHide;
  const toggleSidebar = () => {
    if (sidebarAutoHide) {
      // Override auto-hide: pin the sidebar docked (Settings updates to match).
      setSetting("sidebarAutoHide", false);
      setSetting("sidebarOpen", true);
    } else {
      setSetting("sidebarOpen", !sidebarOpen);
    }
  };

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button
          className="btn icon"
          onClick={toggleSidebar}
          title={
            sidebarAutoHide
              ? "Pin sidebar open (turns off auto-hide)"
              : sidebarOpen
              ? "Hide sidebar"
              : "Show sidebar"
          }
          aria-label="Toggle sidebar"
        >
          {sidebarDocked ? "⇤" : "⇥"}
        </button>
        <span className="brand">
          <span className="brand-mark">✦</span> Mesa
        </span>
        <VaultSwitcher />
        {!IN_TAURI && <span className="demo-badge">browser demo</span>}
      </div>
      <div className="topbar-right">
        <button
          className="btn icon search-top-btn"
          onClick={() => setSearch(true)}
          title="Search (⌘⇧F) — ⌘P for quick switcher"
          aria-label="Search"
        >
          <svg
            className="search-top-icon"
            viewBox="0 0 24 24"
            aria-hidden="true"
            focusable="false"
          >
            <circle cx="11" cy="11" r="6.5" />
            <path d="m16 16 5 5" />
          </svg>
        </button>
        <button
          className={"btn pane-handle" + (shows("tasks") ? " on" : "")}
          title="Toggle the Tasks panel · drag onto the right to dock, or away to pop out"
          onPointerDown={(e) => startViewDrag("tasks", "handle", e, () => togglePanel("tasks"))}
        >
          Tasks
        </button>
        <div className="seg">
          <button
            className={"seg-btn pane-handle" + (shows("preview") ? " on" : "")}
            title="Toggle the Preview panel · drag to dock or pop out"
            onPointerDown={(e) =>
              startViewDrag("preview", "handle", e, () => togglePanel("preview"))
            }
          >
            Preview
          </button>
          <button
            className={"seg-btn pane-handle" + (shows("graph") ? " on" : "")}
            title="Toggle the Graph panel · drag to dock or pop out"
            onPointerDown={(e) =>
              startViewDrag("graph", "handle", e, () => togglePanel("graph"))
            }
          >
            Graph
          </button>
        </div>
        <button
          className={"btn icon" + (graphFull ? " on" : "")}
          onClick={toggleGraphFull}
          title={graphFull ? "Exit full graph" : "Expand graph"}
          aria-label={graphFull ? "Exit full graph" : "Expand graph"}
        >
          ⤢
        </button>
        <button
          className="btn icon"
          onClick={() => {
            void openPanelWindow("graph");
            if (shows("graph")) removeViewFromWorkspace("graph");
          }}
          title="Open graph in a separate window"
          aria-label="Open graph in a separate window"
        >
          ⧉
        </button>
        <button
          className={"btn" + (syncListening ? " on" : "")}
          onClick={() => setSyncOpen(true)}
          title="Sync over LAN / Tailscale"
        >
          {syncListening ? "◉ Sync" : "Sync"}
        </button>
        <button
          className="btn icon"
          onClick={() => setHelpOpen(true)}
          title="Help & guide"
          aria-label="Help"
        >
          ?
        </button>
        <button
          className="btn icon"
          onClick={() => setSettingsOpen(true)}
          title="Settings (⌘,)"
          aria-label="Settings"
        >
          ⚙
        </button>
      </div>
    </header>
  );
}
