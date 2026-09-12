import type { PaneView, RightPanel, Settings } from "../types";
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
    moveViewToRight: (view: PaneView, index?: number) => update(index === undefined ? openViewInWorkspace(get().settings.centerView, get().settings.rightStack, view) : placeInRight(get().settings.centerView, get().settings.rightStack, view, index)),
    flipDockSide: () => { const settings = get().settings; if (settings.rightStack.length) setSetting("dockSide", settings.dockSide === "right" ? "left" : "right"); },
    toggleGraphFull: () => set({ graphFull: !get().graphFull }),
  };
}
