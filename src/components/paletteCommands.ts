import { getStore, useAppStore, THEMES, UI_STYLES } from "../store";
import { localISO } from "../lib/daily";
import { activeEditorCommands } from "../lib/editorCommands";

export interface PaletteCommand {
  /** Stable id; user hotkeys are stored against it. */
  id: string;
  label: string;
  /** Built-in shortcut shown beside the label. */
  hint?: string;
  run: () => void;
}

const findInNote = () => {
  if (!activeEditorCommands()?.openFind()) useAppStore.setState({ status: "Open a note to find and replace in it." });
};

/** Every command-palette command. The palette and user hotkeys share this list. */
export const PALETTE_COMMANDS: readonly PaletteCommand[] = [
  { id: "new", label: "New note", hint: "⌘N", run: () => void getStore().newNote() },
  { id: "search", label: "Search in all notes", hint: "⌘⇧F", run: () => getStore().openSearch("") },
  { id: "find", label: "Find and replace in current note", hint: "⌘F", run: findInNote },
  { id: "insert-template", label: "Insert template…", run: () => getStore().openTemplatePicker() },
  { id: "tasks", label: "Open tasks dashboard", run: () => getStore().setTasksOpen(true) },
  { id: "sync", label: "Open device sync", run: () => getStore().setSyncOpen(true) },
  { id: "diagnostics", label: "Open diagnostics", run: () => getStore().setDiagnosticsOpen(true) },
  { id: "recovery", label: "Open recovery storage", run: () => getStore().openRecovery() },
  { id: "revisions", label: "Open revision history", run: () => getStore().openRevisionHistory() },
  {
    id: "calendar",
    label: "Open calendar (overlay)",
    hint: "⇧Tab",
    run: () => getStore().setOverlayOpen(true),
  },
  {
    id: "overlay-search",
    label: "Open overlay search",
    hint: "⇧Tab",
    run: () => {
      getStore().setOverlayOpen(true);
      getStore().openSearch("");
    },
  },
  { id: "pi", label: "Open Pi agent", run: () => getStore().setAgentOpen(true) },
  { id: "research", label: "Start Deep Research", run: () => getStore().openDeepResearch(true) },
  {
    id: "today",
    label: "Open today's daily note",
    run: () => void getStore().openDailyNote(localISO()),
  },
  { id: "help", label: "Help & guide", run: () => getStore().setHelpOpen(true) },
  { id: "settings", label: "Open settings", hint: "⌘,", run: () => getStore().setSettingsOpen(true) },
  { id: "graph", label: "Toggle full graph", run: () => getStore().toggleGraphFull() },
  {
    id: "theme",
    label: "Cycle theme",
    run: () => {
      const s = getStore();
      const order = THEMES.map((t) => t.id);
      s.setTheme(order[(order.indexOf(s.theme) + 1) % order.length]);
    },
  },
  {
    id: "ui-style",
    label: "Cycle interface style",
    run: () => {
      const s = getStore();
      const order = UI_STYLES.map((u) => u.id);
      s.setUiStyle(order[(order.indexOf(s.uiStyle) + 1) % order.length]);
    },
  },
  { id: "vault", label: "Open vault…", run: () => void getStore().openVault() },
];

export const paletteCommandLabel = (id: string): string =>
  PALETTE_COMMANDS.find((command) => command.id === id)?.label ?? id;
