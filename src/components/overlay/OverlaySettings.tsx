import { useAppStore, THEMES } from "../../store";
import { InterfaceStyleChoice, SettingToggle } from "../SettingsControls";

export function OverlaySettings({ onReset }: { onReset: () => void }) {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const uiStyle = useAppStore((s) => s.uiStyle);
  const setUiStyle = useAppStore((s) => s.setUiStyle);
  const settings = useAppStore((s) => s.settings);
  const setSetting = useAppStore((s) => s.setSetting);

  return (
    <div className="ov-settings">
      <section className="ov-settings-section">
        <div className="setting-name">Theme</div>
        <div className="seg theme-seg">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={"seg-btn" + (t.id === theme ? " on" : "")}
              title={t.blurb}
              aria-pressed={t.id === theme}
              onClick={() => setTheme(t.id)}
            >
              <span className="theme-swatch" aria-hidden="true" style={{ background: `linear-gradient(135deg, ${t.swatch[0]} 50%, ${t.swatch[1]} 50%)` }} />
              {t.label}
            </button>
          ))}
        </div>
      </section>
      <section className="ov-settings-section">
        <div className="setting-name">Interface</div>
        <InterfaceStyleChoice value={uiStyle} onChange={setUiStyle} />
      </section>
      <section className="ov-settings-section">
        <div className="ov-setting-line">
          <div>
            <div className="setting-name">Tabs</div>
            <div className="setting-desc">Optional browser-style editor tabs.</div>
          </div>
          <SettingToggle
            label="Tabs"
            on={settings.enableTabs}
            onChange={(v) => setSetting("enableTabs", v)}
          />
        </div>
        <div className="ov-setting-line">
          <div>
            <div className="setting-name">Auto-hide sidebar</div>
            <div className="setting-desc">Reveal the sidebar from the left edge.</div>
          </div>
          <SettingToggle
            label="Auto-hide sidebar"
            on={settings.sidebarAutoHide}
            onChange={(v) => {
              setSetting("sidebarAutoHide", v);
              if (v) setSetting("sidebarOpen", true);
            }}
          />
        </div>
        <div className="ov-setting-line">
          <div>
            <div className="setting-name">Animations</div>
            <div className="setting-desc">Window motion, fades, and UI transitions.</div>
          </div>
          <SettingToggle
            label="Animations"
            on={settings.animations}
            onChange={(v) => setSetting("animations", v)}
          />
        </div>
        <div className="ov-setting-line">
          <div>
            <div className="setting-name">Graph canvas smoothing</div>
            <div className="setting-desc">Ask the system canvas to favor smoother graph motion when available.</div>
          </div>
          <SettingToggle
            label="Graph canvas smoothing"
            on={settings.hardwareAccel}
            onChange={(v) => setSetting("hardwareAccel", v)}
          />
        </div>
      </section>
      <section className="ov-settings-section">
        <div className="setting-name">Overlay windows</div>
        <div className="setting-desc">
          Re-fit the overlay window layout if a pane is off-screen or awkwardly sized.
        </div>
        <button className="btn" onClick={onReset}>
          Reset overlay layout
        </button>
      </section>
    </div>
  );
}
