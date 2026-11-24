import { useAppStore, THEMES } from "../../store";
import { HardwareAccelerationRow } from "./HardwareAccelerationRow";
import { InterfaceStyleChoice, MoreSettings, SettingRow, SettingToggle } from "../SettingsControls";

/** Theme, interface style, hardware acceleration and, under More, motion and layered overlays. */
export function AppearanceGroup() {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const uiStyle = useAppStore((s) => s.uiStyle);
  const setUiStyle = useAppStore((s) => s.setUiStyle);
  const hardwareAccel = useAppStore((s) => s.settings.hardwareAccel);
  const animations = useAppStore((s) => s.settings.animations);
  const setSetting = useAppStore((s) => s.setSetting);
  return (
    <>
      <div className="setting-row theme-setting-row">
        <div className="setting-name">Theme</div>
        <div className="seg theme-seg" aria-label="Theme">
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
      </div>
      <SettingRow
        name="Interface"
        desc="Shape and density of the window. Works with every theme. Classic is the original look."
        className="theme-setting-row"
      >
        <InterfaceStyleChoice value={uiStyle} onChange={setUiStyle} />
      </SettingRow>
      <HardwareAccelerationRow />
      <MoreSettings label="More appearance options">
        <SettingRow name="Interface animations" desc="Move and fade interface elements.">
          <SettingToggle label="Interface animations" on={animations} onChange={(v) => setSetting("animations", v)} />
        </SettingRow>
        <SettingRow name="Layered overlays" desc="Draw menus, hover cards and dialogs on their own layer for smoother fades.">
          <SettingToggle label="Layered overlays" on={hardwareAccel} onChange={(v) => setSetting("hardwareAccel", v)} />
        </SettingRow>
      </MoreSettings>
    </>
  );
}
