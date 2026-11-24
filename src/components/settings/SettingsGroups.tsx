import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { HotkeySettings } from "../HotkeySettings";
import { AppearanceGroup } from "./AppearanceGroup";
import { FilesGroup } from "./FilesGroup";
import { UpdatesGroup } from "./UpdatesGroup";
import { WorkspaceGroup } from "./WorkspaceGroup";
import {
  SETTINGS_GROUPS,
  rememberSettingsGroup,
  rememberedSettingsGroup,
  type SettingsGroupId,
} from "./settingsGroupList";

function groupBody(id: SettingsGroupId, updates: ReactNode): ReactNode {
  switch (id) {
    case "appearance": return <AppearanceGroup />;
    case "workspace": return <WorkspaceGroup />;
    case "files": return <FilesGroup />;
    case "shortcuts": return <HotkeySettings />;
    case "updates": return <UpdatesGroup>{updates}</UpdatesGroup>;
  }
}

/** Group list on the left, the one open group on the right. Every group has a
 *  panel (so each `aria-controls` resolves), but only the open one has content,
 *  so closed groups (the hotkey recorder) cost nothing. `updates` is the Updates
 *  section, shown under the version in the Updates group. */
export function SettingsGroups({ updates }: { updates?: ReactNode }) {
  const [openId, setOpenId] = useState<SettingsGroupId>(rememberedSettingsGroup);
  const baseId = useId();
  const navRef = useRef<HTMLDivElement>(null);
  const buttonId = (id: SettingsGroupId) => `${baseId}-group-${id}`;
  const panelId = (id: SettingsGroupId) => `${baseId}-panel-${id}`;

  const open = (id: SettingsGroupId) => {
    rememberSettingsGroup(id);
    setOpenId(id);
  };

  // Roving tabindex: only the open group's button is in the Tab order, so Tab
  // goes from the list straight into the open group. Up/Down (and Home/End)
  // move focus between groups; Enter or Space opens one.
  const onNavKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(navRef.current?.querySelectorAll<HTMLButtonElement>("button[aria-controls]") ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0 || !buttons.length) return;
    const last = buttons.length - 1;
    const next =
      event.key === "ArrowDown" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowUp" ? (index === 0 ? last : index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : -1;
    if (next < 0) return;
    event.preventDefault();
    buttons[next].focus();
  };

  return (
    <div className="settings-groups">
      <div className="settings-nav" role="group" aria-label="Settings groups" ref={navRef} onKeyDown={onNavKey}>
        {SETTINGS_GROUPS.map((group) => (
          <button
            key={group.id}
            type="button"
            id={buttonId(group.id)}
            className="settings-nav-btn"
            aria-expanded={group.id === openId}
            aria-controls={panelId(group.id)}
            tabIndex={group.id === openId ? 0 : -1}
            onClick={() => open(group.id)}
          >
            {group.label}
          </button>
        ))}
      </div>
      {SETTINGS_GROUPS.map((group) => (
        <div
          key={group.id}
          className="settings-group-panel"
          role="region"
          id={panelId(group.id)}
          aria-labelledby={buttonId(group.id)}
          data-settings-group={group.id}
          hidden={group.id !== openId}
        >
          {group.id === openId ? groupBody(group.id, updates) : null}
        </div>
      ))}
    </div>
  );
}
