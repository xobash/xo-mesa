// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Desktop build: the main renderer relays Deep Research run snapshots to each
 * detached viewer that asks, and stops relaying on unmount. Child surfaces
 * and main-window effects are stubbed as in `App.shell.test.tsx`.
 */

const h = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => true),
  stub: () => null,
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  unlisten: vi.fn(),
  emitTo: vi.fn(async (_label: string, _event: string, _payload: unknown) => {}),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (event: { payload: unknown }) => void) => {
    h.listeners.set(name, cb);
    return h.unlisten;
  }),
  emit: vi.fn(async () => {}),
  emitTo: h.emitTo,
}));
vi.mock("./lib/vault", async () => ({ ...(await vi.importActual<object>("./lib/vault")), IN_TAURI: true }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("./components/useMainWindowEffects", () => ({
  useMainWindowEffects: () => {},
}));
vi.mock("./components/useApplyTheme", () => ({ useApplyTheme: () => {} }));
vi.mock("./components/useTrayStatus", () => ({ useTrayStatus: () => {} }));
vi.mock("./components/useCustomHotkeys", () => ({ useCustomHotkeys: () => {} }));
vi.mock("./components/useBrowserKeyGuard", () => ({ useBrowserKeyGuard: () => {} }));
vi.mock("./controllers/settingsFollow", () => ({ followOtherWindows: () => () => {} }));
vi.mock("./components/Welcome", () => ({ Welcome: h.stub }));
vi.mock("./components/TopBar", () => ({ TopBar: h.stub }));
vi.mock("./components/FileTree", () => ({ FileTree: h.stub }));
vi.mock("./components/TagList", () => ({ TagList: h.stub }));
vi.mock("./components/BookmarksList", () => ({ BookmarksList: h.stub }));
vi.mock("./components/StatusBar", () => ({ StatusBar: h.stub }));
vi.mock("./components/TasksModal", () => ({ TasksModal: h.stub }));
vi.mock("./components/Guide", () => ({ Tour: h.stub, HelpModal: h.stub }));
vi.mock("./components/DocumentView", () => ({ DocumentView: h.stub, DocPopoutModal: h.stub }));
vi.mock("./components/DropOverlay", () => ({ DropOverlay: h.stub }));
vi.mock("./components/LazySurfaces", () => ({
  AgentWindows: h.stub, EphemeralModals: h.stub, OverlayBoundary: h.stub,
  GraphView: () => <div data-graph-stub />,
}));
vi.mock("./components/DetachedWindows", () => ({ AgentWindow: h.stub, ResearchWindow: h.stub }));
vi.mock("./components/FloatingLayers", () => ({ DragGhostLayer: h.stub, PreviewLayer: h.stub }));
vi.mock("./components/SortMenu", () => ({ SortMenu: h.stub }));
vi.mock("./components/CenterRegion", () => ({ CenterRegion: h.stub }));
vi.mock("./components/RightStack", () => ({ RightStack: h.stub }));
vi.mock("./components/PanelWindow", () => ({ PanelWindow: h.stub }));

import App from "./App";
import { getStore, useAppStore } from "./store";
import { DEEP_RESEARCH_STATE_EVENT, DEEP_RESEARCH_STATE_REQUEST_EVENT } from "./lib/deepResearchWindow";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const initial = useAppStore.getState();

beforeEach(() => {
  h.listeners.clear();
  h.unlisten.mockClear();
  h.emitTo.mockClear();
  useAppStore.setState({ vaultPath: "/vault", files: [], graphFull: false });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  host.remove();
  useAppStore.setState(initial, true);
});

describe("Deep Research state relay", () => {
  it("answers each requesting window and mirrors later run changes only to them", async () => {
    await act(async () => root.render(<App />));
    const request = h.listeners.get(DEEP_RESEARCH_STATE_REQUEST_EVENT)!;
    expect(request).toBeTypeOf("function");
    act(() => request({ payload: {} }));
    expect(h.emitTo).not.toHaveBeenCalled();
    act(() => request({ payload: { label: "research-1" } }));
    expect(h.emitTo).toHaveBeenCalledWith("research-1", DEEP_RESEARCH_STATE_EVENT, getStore().deepResearch);
    h.emitTo.mockClear();
    act(() => useAppStore.setState({ status: "unrelated" }));
    expect(h.emitTo).not.toHaveBeenCalled();
    const next = { ...(getStore().deepResearch ?? {}), marker: 1 } as unknown as NonNullable<ReturnType<typeof getStore>["deepResearch"]>;
    act(() => useAppStore.setState({ deepResearch: next }));
    expect(h.emitTo).toHaveBeenCalledWith("research-1", DEEP_RESEARCH_STATE_EVENT, next);
    act(() => root.unmount());
    expect(h.unlisten).toHaveBeenCalledTimes(1);
    h.emitTo.mockClear();
    act(() => useAppStore.setState({ deepResearch: { ...next } }));
    expect(h.emitTo).not.toHaveBeenCalled();
  });

  it("drops a listener that registers after unmount", async () => {
    let resolve!: (off: () => void) => void;
    const { listen } = await import("@tauri-apps/api/event");
    vi.mocked(listen).mockImplementationOnce(() => new Promise((r) => { resolve = r as never; }));
    act(() => root.render(<App />));
    act(() => root.unmount());
    const late = vi.fn();
    await act(async () => resolve(late));
    expect(late).toHaveBeenCalledTimes(1);
  });
});
