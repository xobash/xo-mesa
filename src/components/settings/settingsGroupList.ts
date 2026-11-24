/** Top-level Settings groups, in reading order. Settings show one group at a time. */
export const SETTINGS_GROUPS = [
  { id: "appearance", label: "Appearance" },
  { id: "workspace", label: "Workspace" },
  { id: "files", label: "Files" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "updates", label: "Updates" },
] as const;

export type SettingsGroupId = (typeof SETTINGS_GROUPS)[number]["id"];

// The last open group, kept for this window's session only (never persisted):
// reopening Settings returns to where the user was.
let rememberedGroup: SettingsGroupId = SETTINGS_GROUPS[0].id;

export function rememberedSettingsGroup(): SettingsGroupId {
  return rememberedGroup;
}

export function rememberSettingsGroup(id: SettingsGroupId): void {
  rememberedGroup = id;
}
