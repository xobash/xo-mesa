// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAppStore } from "../store";

vi.mock("../lib/windowDock", () => ({ closeCurrentPopoutWindow: vi.fn(), dockIntoMainWindow: vi.fn(), installNativeDragDock: vi.fn(async () => () => {}) }));
vi.mock("./workspaceViews", () => ({ panelContent: () => null }));
import { PanelWindow } from "./PanelWindow";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const initial = useAppStore.getState();
const openVault = vi.fn(async () => {});
beforeEach(() => {
  vi.useFakeTimers();
  window.history.replaceState(null, "", "/index.html?panel=graph&vault=%2Fvault");
  useAppStore.setState({ openVault });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  useAppStore.setState(initial, true);
  openVault.mockClear();
  vi.useRealTimers();
});

it("opens the vault at once when no snapshot was handed over", async () => {
  await act(async () => root.render(<PanelWindow kind="graph" bootstrap={Promise.resolve(false)} />));
  expect(openVault).toHaveBeenCalledExactlyOnceWith("/vault");
});

it("refreshes a shown snapshot in place after it paints", async () => {
  await act(async () => root.render(<PanelWindow kind="graph" bootstrap={Promise.resolve(true)} />));
  expect(openVault).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(1200); });
  expect(openVault).toHaveBeenCalledExactlyOnceWith("/vault", { keepShown: true });
});

it("releases a drag dock that finishes installing after the panel moved on", async () => {
  const { installNativeDragDock } = await import("../lib/windowDock");
  const cleanups: Array<ReturnType<typeof vi.fn>> = [];
  const pending: Array<(cleanup: () => void) => void> = [];
  vi.mocked(installNativeDragDock).mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
  await act(async () => root.render(<PanelWindow kind="graph" bootstrap={Promise.resolve(true)} />));
  await act(async () => root.render(<PanelWindow kind="preview" bootstrap={Promise.resolve(true)} />));
  expect(pending).toHaveLength(2);
  for (const resolve of pending) { const cleanup = vi.fn(); cleanups.push(cleanup); await act(async () => resolve(cleanup)); }
  // The first install belongs to an effect that already cleaned up.
  expect(cleanups[0]).toHaveBeenCalledTimes(1);
  expect(cleanups[1]).not.toHaveBeenCalled();
  act(() => root.unmount());
  expect(cleanups[1]).toHaveBeenCalledTimes(1);
  root = createRoot(host);
  vi.mocked(installNativeDragDock).mockImplementation(async () => () => {});
});
