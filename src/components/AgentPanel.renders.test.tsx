// @vitest-environment jsdom
import { act, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./piSession", () => ({
  SHARED_PI_SESSION: { sessionId: null, terminal: null, fit: null },
  addSharedPiFontSizeListener: vi.fn(),
  adoptSharedPiSession: vi.fn(),
  claimSharedPiResizeOwnership: vi.fn(),
  ensureSharedPiSession: vi.fn(),
  getSharedPiFontSize: () => 13,
  // The xterm chunk never arrives: only the React surface is under test.
  getSharedPiTerminal: () => new Promise(() => {}),
  queueSharedPiResize: vi.fn(),
  registerSharedPiHost: vi.fn(),
  releaseSharedPiHost: vi.fn(),
  removeSharedPiFontSizeListener: vi.fn(),
}));
vi.mock("./PiFloatingWindow", () => ({ PiFloatingWindow: () => null }));
vi.mock("./BrowserHarness", () => ({ BrowserHarness: () => null }));
vi.mock("./DeepResearchPanel", () => ({ DeepResearchPanel: () => null }));
vi.mock("./DeepResearchPhaseChip", () => ({ DeepResearchPhaseChip: () => null }));

import { AgentSurface } from "./AgentPanel";
import { useAppStore } from "../store";
import type { DeepResearchRunState } from "../storeTypes";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const initial = useAppStore.getState();
let host: HTMLDivElement;
let root: Root;
let renders = 0;

beforeEach(() => {
  renders = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useAppStore.setState(initial, true);
});

it("does not re-render for research progress or unrelated settings commits", () => {
  const run = { runId: "r1", startedAt: 1_000, phase: "planning" } as unknown as DeepResearchRunState;
  act(() => useAppStore.setState({ deepResearch: run }));
  act(() => root.render(<Profiler id="pi" onRender={() => { renders++; }}><AgentSurface /></Profiler>));
  const before = renders;
  act(() => useAppStore.setState({ deepResearch: { ...run, phase: "researching" } as DeepResearchRunState }));
  act(() => useAppStore.setState({ settings: { ...useAppStore.getState().settings, tagsCollapsed: !useAppStore.getState().settings.tagsCollapsed } }));
  expect(renders).toBe(before);
  // A new run still reaches the surface.
  act(() => useAppStore.setState({ deepResearch: { ...run, runId: "r2", startedAt: 0 } as DeepResearchRunState }));
  expect(renders).toBe(before + 1);
});
