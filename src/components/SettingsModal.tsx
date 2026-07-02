import { useAppStore, THEMES } from "../store";
import { Modal } from "./Modal";

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      className={"toggle" + (on ? " on" : "")}
      role="switch"
      aria-checked={on}
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

  if (!open) return null;

  return (
    <Modal onClose={() => setOpen(false)} className="settings">
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
                onClick={() => setSetting("hoverDelayMs", ms)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-meta">
            <div className="setting-name">Hardware acceleration</div>
            <div className="setting-desc">
              GPU-assisted canvas and compositing for smoother motion. Changes
              apply the next time the graph opens.
            </div>
          </div>
          <Toggle
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
            on={settings.sidebarAutoHide}
            onChange={(v) => {
              setSetting("sidebarAutoHide", v);
              // Enabling auto-hide implies the sidebar exists (to reveal on hover).
              if (v) setSetting("sidebarOpen", true);
            }}
          />
        </div>
      </div>
    </Modal>
  );
}
