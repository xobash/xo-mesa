import type { PaneView, RightPanel, Settings, WorkspacePreset } from "../types";
import { closeCenterView, openViewInWorkspace, placeInCenter, placeInRight, removeFromWorkspace, toggleWorkspacePanel } from "./panes";
import type { PaneDrag } from "./panes";

interface State { settings: Settings; dragView: PaneDrag | null; graphFull: boolean; }
interface Deps { get: () => State; set: (patch: Partial<State>) => void; commitSettings: (settings: Settings) => void; setSetting: (key: keyof Settings, value: Settings[keyof Settings]) => void; }

export function createWorkspaceActions({ get, set, commitSettings, setSetting }: Deps) {
  const update = (patch: Partial<Settings>) => commitSettings({ ...get().settings, ...patch });
  return {
    togglePanel: (panel: RightPanel) => update(toggleWorkspacePanel(get().settings.centerView, get().settings.rightStack, panel)),
    removeViewFromWorkspace: (view: PaneView) => update(removeFromWorkspace(get().settings.centerView, get().settings.rightStack, view)),
    dropViewInCenter: () => { const drag = get().dragView; if (!drag) return; update(placeInCenter(get().settings.centerView, get().settings.rightStack, drag.view)); set({ dragView: null }); },
    dropViewAt: (index: number) => { const drag = get().dragView; if (!drag) return; update(placeInRight(get().settings.centerView, get().settings.rightStack, drag.view, index)); set({ dragView: null }); },
    closeCenter: () => update(closeCenterView(get().settings.centerView, get().settings.rightStack)),
    moveViewToCenter: (view: PaneView) => update(placeInCenter(get().settings.centerView, get().settings.rightStack, view)),
    moveViewToRight: (view: PaneView, index?: number) => {
      const { centerView, rightStack } = get().settings;
      if (view === "agent" && index === undefined) {
        // Pi alone already fills the workspace; moving it aside would leave the center empty.
        const alone = centerView === "empty" || (centerView === "agent" && rightStack.length === 0);
        const placement = alone
          ? openViewInWorkspace(centerView, rightStack, view)
          : placeInRight(centerView, rightStack, view, 0);
        update({ ...placement, rightStack: alone ? [] : ["agent"] });
        set({ graphFull: false });
        return;
      }
      update(index === undefined ? openViewInWorkspace(centerView, rightStack, view) : placeInRight(centerView, rightStack, view, index));
    },
    flipDockSide: () => { const settings = get().settings; if (settings.rightStack.length) setSetting("dockSide", settings.dockSide === "right" ? "left" : "right"); },
    applyWorkspacePreset: (preset: WorkspacePreset) => {
      // Presets arrange existing surfaces only. They do not close documents,
      // alter a user's pane widths, or replace direct manipulation.
      const rightStack: PaneView[] = preset === "write" ? [] : preset === "read" ? ["preview"] : ["agent"];
      update({ sidebarOpen: true, sidebarAutoHide: false, centerView: "doc", rightStack });
    },
    toggleGraphFull: () => set({ graphFull: !get().graphFull }),
  };
}
