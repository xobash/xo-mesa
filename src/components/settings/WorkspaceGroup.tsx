import { useAppStore } from "../../store";
import { MoreSettings, SettingRow, SettingToggle } from "../SettingsControls";

const PREVIEW_DELAYS = [
  ["Short", 200],
  ["Normal", 450],
  ["Long", 900],
] as const;

/** Panel presets, file tabs, the sidebar and, under More, hover preview timing. */
export function WorkspaceGroup() {
  const applyWorkspacePreset = useAppStore((s) => s.applyWorkspacePreset);
  const enableTabs = useAppStore((s) => s.settings.enableTabs);
  const sidebarAutoHide = useAppStore((s) => s.settings.sidebarAutoHide);
  const hoverDelayMs = useAppStore((s) => s.settings.hoverDelayMs);
  const setSetting = useAppStore((s) => s.setSetting);
  return (
    <>
      <SettingRow name="Workspace layout" desc="Set up panels for writing, reading, or research. Adjust them anytime.">
        <div className="seg" aria-label="Workspace layout">
          <button className="seg-btn" onClick={() => applyWorkspacePreset("write")}>Write</button>
          <button className="seg-btn" onClick={() => applyWorkspacePreset("read")}>Read</button>
          <button className="seg-btn" onClick={() => applyWorkspacePreset("research")}>Research</button>
        </div>
      </SettingRow>
      <SettingRow name="File tabs" desc="Show open files above the editor.">
        <SettingToggle label="File tabs" on={enableTabs} onChange={(v) => setSetting("enableTabs", v)} />
      </SettingRow>
      <SettingRow name="Auto-hide sidebar" desc="Reveal the sidebar when the pointer reaches the left edge.">
        <SettingToggle
          label="Auto-hide sidebar"
          on={sidebarAutoHide}
          onChange={(v) => {
            setSetting("sidebarAutoHide", v);
            // Enabling auto-hide implies the sidebar exists (to reveal on hover).
            if (v) setSetting("sidebarOpen", true);
          }}
        />
      </SettingRow>
      <MoreSettings label="More workspace options">
        <SettingRow name="Preview delay" desc="Wait before showing a preview on hover.">
          <div className="seg" aria-label="Preview delay">
            {PREVIEW_DELAYS.map(([label, ms]) => (
              <button
                key={ms}
                className={"seg-btn" + (hoverDelayMs === ms ? " on" : "")}
                aria-pressed={hoverDelayMs === ms}
                onClick={() => setSetting("hoverDelayMs", ms)}
              >
                {label}
              </button>
            ))}
          </div>
        </SettingRow>
      </MoreSettings>
    </>
  );
}
