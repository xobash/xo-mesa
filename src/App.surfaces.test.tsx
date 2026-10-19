// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, expect, it } from "vitest";
import App from "./App";
import { useAppStore } from "./store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const settle = async (until: () => boolean) => {
  for (let i = 0; i < 200 && !until(); i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  return until();
};

beforeAll(async () => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  Element.prototype.scrollIntoView ??= () => {};
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  try { localStorage.setItem("mesa:toured", "1"); } catch { /* optional */ }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<App />));
  await settle(() => !!useAppStore.getState().activePath);
});

afterAll(() => {
  act(() => root.unmount());
  host.remove();
});

it("opens the demo vault and its first note in the browser build", () => {
  const state = useAppStore.getState();

  expect(state.vaultPath).toBeTruthy();
  expect(state.files.length).toBeGreaterThan(0);
  expect(state.activePath).toBeTruthy();
  expect(host.querySelector(".status-bar, [role=status], footer")).not.toBeNull();
});

it.each([
  ["command palette", "setPalette", "paletteOpen"],
  ["search", "setSearch", "searchOpen"],
  ["settings", "setSettingsOpen", "settingsOpen"],
  ["diagnostics", "setDiagnosticsOpen", "diagnosticsOpen"],
  ["sync", "setSyncOpen", "syncOpen"],
] as const)("lazily mounts and closes the %s surface", async (_name, action, key) => {
  const before = document.body.innerHTML.length;
  await act(async () => { (useAppStore.getState()[action] as (open: boolean) => void)(true); });
  expect(await settle(() => document.querySelector("[role=dialog]") !== null)).toBe(true);
  expect(document.body.innerHTML.length).toBeGreaterThan(before);
  await act(async () => { (useAppStore.getState()[action] as (open: boolean) => void)(false); });
  expect(useAppStore.getState()[key]).toBe(false);
  expect(await settle(() => document.querySelector("[role=dialog]") === null)).toBe(true);
});

const key = (init: KeyboardEventInit) => act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
const closeAll = () => act(async () => {
  useAppStore.setState({ paletteOpen: false, searchOpen: false, settingsOpen: false, diagnosticsOpen: false, syncOpen: false, helpOpen: false, tasksOpen: false });
});

it("opens the palette, search and settings from their keyboard shortcuts", async () => {
  (document.activeElement as HTMLElement | null)?.blur();
  await key({ key: "p", metaKey: true });
  expect(useAppStore.getState().paletteOpen).toBe(true);
  await closeAll();
  await key({ key: "F", metaKey: true, shiftKey: true });
  expect(useAppStore.getState().searchOpen).toBe(true);
  await closeAll();
  await key({ key: ",", ctrlKey: true });
  expect(useAppStore.getState().settingsOpen).toBe(true);
  await closeAll();
});

async function runPaletteQuery(query: string, moves: ("ArrowDown" | "ArrowUp")[] = []) {
  await act(async () => { useAppStore.getState().setPalette(true); });
  expect(await settle(() => document.querySelector<HTMLInputElement>(".palette input") !== null)).toBe(true);
  const input = document.querySelector<HTMLInputElement>(".palette input")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  for (const move of moves) await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: move, bubbles: true })); });
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(useAppStore.getState().paletteOpen).toBe(false);
}

it.each([
  ["> help", "helpOpen"],
  ["> tasks dashboard", "tasksOpen"],
  ["> revision history", "settingsOpen"],
  ["> open settings", "settingsOpen"],
  ["> diagnostics", "diagnosticsOpen"],
  ["> device sync", "syncOpen"],
  ["> search in all notes", "searchOpen"],
] as const)("runs the %s palette command", async (query, flag) => {
  await runPaletteQuery(query);
  expect(useAppStore.getState()[flag]).toBe(true);
  await closeAll();
});

it("cycles the theme and interface style from the palette", async () => {
  const { theme, uiStyle } = useAppStore.getState();
  await runPaletteQuery("> cycle theme");
  expect(useAppStore.getState().theme).not.toBe(theme);
  await runPaletteQuery("> cycle interface style");
  expect(useAppStore.getState().uiStyle).not.toBe(uiStyle);
});

it("opens a note chosen from the palette file results", async () => {
  const notes = useAppStore.getState().files.filter((f) => f.isMarkdown);
  const target = notes[notes.length - 1];
  await runPaletteQuery(target.name, ["ArrowDown", "ArrowUp"]);
  expect(await settle(() => useAppStore.getState().activePath === target.relPath)).toBe(true);
});

it("opens workspace surfaces from the top bar and toggles the sidebar", async () => {
  const click = (selector: string) => act(async () => { host.querySelector<HTMLElement>(selector)!.click(); });
  for (const [selector, flag] of [
    ['[aria-label="Search"]', "searchOpen"],
    ['[aria-label="Help"]', "helpOpen"],
    ['[aria-label="Diagnostics"]', "diagnosticsOpen"],
    ['[aria-label="Settings"]', "settingsOpen"],
    ['[title="Sync over LAN / Tailscale"]', "syncOpen"],
  ] as const) {
    await click(selector);
    expect(useAppStore.getState()[flag]).toBe(true);
    await closeAll();
  }
  await act(async () => { useAppStore.getState().setSetting("sidebarAutoHide", false); });
  const sidebar = useAppStore.getState().settings.sidebarOpen;
  await click('[aria-label="Toggle sidebar"]');
  expect(useAppStore.getState().settings.sidebarOpen).toBe(!sidebar);
  await click('[aria-label="Toggle sidebar"]');
  expect(useAppStore.getState().settings.sidebarOpen).toBe(sidebar);
  await click(".vault-name");
  expect(document.querySelector(".vault-menu[role=menu]")).not.toBeNull();
  await click(".vault-name");
  expect(document.querySelector(".vault-menu[role=menu]")).toBeNull();
});

it("changes file-tree sort order, direction and type filter from the sort menu", async () => {
  const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>(".sort-pop button")].find((b) => b.textContent?.includes(text))!;
  await act(async () => { useAppStore.getState().setSetting("sidebarOpen", true); });
  expect(await settle(() => host.querySelector(".sort-menu .sort-btn") !== null)).toBe(true);
  await act(async () => { host.querySelector<HTMLButtonElement>(".sort-menu .sort-btn")!.click(); });
  expect(host.querySelector(".sort-pop")).not.toBeNull();
  await act(async () => { button("Date modified").click(); });
  expect(useAppStore.getState().settings.sortMode).toBe("modified");
  await act(async () => { button("Desc").click(); });
  expect(useAppStore.getState().settings.sortDir).toBe("desc");
  await act(async () => { button("Asc").click(); });
  expect(useAppStore.getState().settings.sortDir).toBe("asc");
  await act(async () => { host.querySelector<HTMLButtonElement>(".sort-accordion")!.click(); });
  await act(async () => { button(".md").click(); });
  expect(useAppStore.getState().settings.typeFilter).toBe("md");
  await act(async () => { button("All types").click(); });
  expect(useAppStore.getState().settings.typeFilter).toBe("all");
  await act(async () => { button("Name (A").click(); });
  await act(async () => { document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  expect(host.querySelector(".sort-pop")).toBeNull();
});
