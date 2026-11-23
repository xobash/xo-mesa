// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAppStore } from "../store";
import { useMainWindowEffects } from "./useMainWindowEffects";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness() {
  const appRootRef = useRef<HTMLDivElement | null>(null);
  useMainWindowEffects({
    mainWindow: true, vaultPath: "/vault", unavailableVault: null, openVault: async () => {},
    requestedVault: "", onBlocked: async () => "keep", appRootRef,
  });
  return <div ref={appRootRef} />;
}

let host: HTMLDivElement, root: Root;
beforeEach(async () => {
  useAppStore.setState({ vaultPath: "/vault", keyboardFocus: { region: "center", rightIndex: 0 }, status: "" });
  useAppStore.getState().setSetting("centerView", "doc");
  useAppStore.getState().setSetting("rightStack", ["preview"]);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })); });

it("the window-command hint names only keys that act on the two panes", async () => {
  await press("w", { ctrlKey: true });
  const hint = useAppStore.getState().status;
  expect(hint).not.toMatch(/j\/k|stack/i);
  expect(hint).toMatch(/h\/l focus/);
  await press("l");
  expect(useAppStore.getState().keyboardFocus).toEqual({ region: "right", rightIndex: 0 });
  // j/k after the window prefix has no stacked panel to choose.
  await press("w", { ctrlKey: true });
  await press("J", { shiftKey: true });
  expect(useAppStore.getState().keyboardFocus).toEqual({ region: "right", rightIndex: 0 });
  expect(useAppStore.getState().settings.rightStack).toEqual(["preview"]);
  await press("w", { ctrlKey: true });
  await press("H", { shiftKey: true });
  expect(useAppStore.getState().settings.centerView).toBe("preview");
  expect(useAppStore.getState().keyboardFocus.region).toBe("center");
});
