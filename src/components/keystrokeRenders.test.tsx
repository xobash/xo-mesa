// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

/**
 * A keystroke re-renders only what shows the text. Renders are counted from
 * React's commit hook: a fiber rendered when it is new since the last commit
 * and carries React's PerformedWork flag (bailed-out subtrees keep their old
 * fiber objects).
 */
const renders = vi.hoisted(() => {
  type Fiber = { tag: number; type: unknown; flags: number; child: Fiber | null; sibling: Fiber | null };
  const counts = new Map<string, number>();
  let previous = new WeakSet<Fiber>();
  const nameOf = (fiber: Fiber) => (fiber.type as { name?: string } | null)?.name ?? "";
  (globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, renderers: new Map(),
    inject: () => 1, checkDCE() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onScheduleFiberRoot() {},
    onCommitFiberRoot(_id: number, root: { current: Fiber }) {
      const seen = new WeakSet<Fiber>();
      const walk = (fiber: Fiber | null) => {
        for (; fiber; fiber = fiber.sibling) {
          seen.add(fiber);
          // Function, forward-ref and simple-memo components.
          if (!previous.has(fiber) && (fiber.flags & 1) && [0, 11, 15].includes(fiber.tag)) {
            counts.set(nameOf(fiber), (counts.get(nameOf(fiber)) ?? 0) + 1);
          }
          walk(fiber.child);
        }
      };
      walk(root.current);
      previous = seen;
    },
  };
  return counts;
});

import App from "../App";
import { useAppStore } from "../store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  Element.prototype.scrollIntoView ??= function () {};
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
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
  const ready = () => useAppStore.getState().activeContentState === "ready" &&
    !useAppStore.getState().notesIndexPending && host.querySelector(".backlinks") && host.querySelector(".cm-editor");
  for (let i = 0; i < 300 && !ready(); i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
});

afterAll(() => {
  act(() => root.unmount());
  host.remove();
});

it("renders the editor once and backlinks not at all per keystroke", async () => {
  expect(host.querySelector(".backlinks")).not.toBeNull();
  expect(useAppStore.getState().activeContentState).toBe("ready");
  const base = useAppStore.getState().content;
  renders.clear();
  for (let i = 1; i <= 20; i++) {
    await act(async () => { useAppStore.getState().setContentFromEditor(base + "x".repeat(i)); });
  }
  expect(renders.get("Editor")).toBe(20);
  expect(renders.get("Backlinks") ?? 0).toBe(0);
  // The preview still follows the text.
  expect(renders.get("Preview")).toBe(20);
});
