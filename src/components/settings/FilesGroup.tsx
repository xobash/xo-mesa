import { useAppStore } from "../../store";
import { SettingRow, SettingToggle } from "../SettingsControls";

/** Sidebar file visibility and the templates folder. */
export function FilesGroup() {
  const hideGeneratedFiles = useAppStore((s) => s.settings.hideGeneratedFiles);
  const templatesFolder = useAppStore((s) => s.settings.templatesFolder);
  const setSetting = useAppStore((s) => s.setSetting);
  return (
    <>
      <SettingRow name="Hide generated files" desc="Hide archives and conflict copies in the sidebar. Search still finds them.">
        <SettingToggle label="Hide generated files" on={hideGeneratedFiles} onChange={(value) => setSetting("hideGeneratedFiles", value)} />
      </SettingRow>
      <SettingRow
        name="Templates folder"
        desc={<>Notes in this folder appear in Insert template. Use {"{{date}}"}, {"{{time}}"} and {"{{title}}"} as placeholders.</>}
      >
        <input
          className="text-input"
          aria-label="Templates folder"
          placeholder="Templates"
          value={templatesFolder}
          onChange={(event) => setSetting("templatesFolder", event.target.value)}
        />
      </SettingRow>
    </>
  );
}
