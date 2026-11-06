// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Tabs } from "./Tabs";
import { useAppStore } from "../store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const initial = useAppStore.getState();
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Element.prototype.scrollIntoView ??= () => {};
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useAppStore.setState(initial, true);
});

it("scrolls an overflowing tab strip sideways with a mouse wheel", () => {
  useAppStore.setState({
    openTabs: ["/vault/A.md", "/vault/B.md"],
    settings: { ...initial.settings, enableTabs: true },
  });
  act(() => root.render(<Tabs />));
  const strip = host.querySelector<HTMLDivElement>(".tabs")!;
  Object.defineProperty(strip, "clientWidth", { value: 200 });
  Object.defineProperty(strip, "scrollWidth", { value: 800 });
  const event = new WheelEvent("wheel", { deltaY: 90, cancelable: true, bubbles: true });
  strip.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(strip.scrollLeft).toBe(90);
});
