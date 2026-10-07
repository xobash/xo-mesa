// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * App renders the whole shell, and its direct children are not memoized, so
 * every App render re-renders the sidebar, center, dock and status bar. These
 * tests pin that high-churn store fields reach only the components that show
 * them. The supplied earlier demo-vault profile (jsdom, 20 updates each)
 * reported these total render costs: status 62 ms → 8 ms, loading 46 ms → 0 ms, Deep
 * Research progress 26 ms → 0.8 ms, navigation 68 ms → 44 ms.
 */

const shellRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./components/TopBar", () => ({
  TopBar: () => {
    shellRenders.count++;
    return null;
  },
}));

import App from "./App";
import { useAppStore } from "./store";
import type { DeepResearchRunState } from "./store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  // jsdom has no layout engine; CodeMirror still queries range geometry.
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  try { localStorage.setItem("mesa:toured", "1"); } catch { /* optional */ }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<App />));
  // The browser build opens the demo vault and selects its first note.
  for (let i = 0; i < 100 && !useAppStore.getState().activePath; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
});

afterAll(() => {
  act(() => root.unmount());
  host.remove();
});

async function shellRendersDuring(update: () => void): Promise<number> {
  const before = shellRenders.count;
  for (let i = 0; i < 5; i++) await act(async () => update());
  return shellRenders.count - before;
}

describe("App shell subscriptions", () => {
  it("opens the demo vault with the shell mounted", () => {
    expect(useAppStore.getState().vaultPath).toBeTruthy();
    expect(useAppStore.getState().activePath).toBeTruthy();
    expect(shellRenders.count).toBeGreaterThan(0);
  });

  it("does not re-render the shell for status or loading changes", async () => {
    let n = 0;
    expect(await shellRendersDuring(() => useAppStore.setState({ status: `status ${n++}` }))).toBe(0);
    expect(await shellRendersDuring(() => useAppStore.setState({ loading: n++ % 2 === 0 }))).toBe(0);
  });

  it("does not re-render the shell for file catalog or Deep Research updates", async () => {
    expect(await shellRendersDuring(() => useAppStore.setState({ files: useAppStore.getState().files.slice() }))).toBe(0);
    let n = 0;
    expect(await shellRendersDuring(() => useAppStore.setState({
      deepResearch: { ...(useAppStore.getState().deepResearch ?? {}), error: `progress ${n++}` } as DeepResearchRunState,
    }))).toBe(0);
  });

  it("does not re-render the shell when the active document changes", async () => {
    const notes = useAppStore.getState().files.filter((file) => file.isMarkdown).map((file) => file.relPath);
    expect(notes.length).toBeGreaterThan(1);
    let n = 0;
    expect(await shellRendersDuring(() => { void useAppStore.getState().selectFile(notes[n++ % notes.length]); })).toBe(0);
  });

  it("still re-renders the shell for layout settings it owns", async () => {
    const width = useAppStore.getState().settings.sidebarWidth;
    expect(await shellRendersDuring(() => useAppStore.getState().setSetting("sidebarWidth", width + 1))).toBeGreaterThan(0);
    act(() => useAppStore.getState().setSetting("sidebarWidth", width));
  });
});
