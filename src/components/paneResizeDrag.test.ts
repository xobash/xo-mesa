// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { startPaneResizeDrag } from "./paneResizeDrag";

const pointer = (type: string, clientX = 0) => window.dispatchEvent(new MouseEvent(type, { clientX }) as unknown as PointerEvent);
const drags: Array<() => void> = [];
afterEach(() => { for (const end of drags.splice(0)) end(); });

function start(commit = vi.fn()) {
  const el = document.createElement("div");
  el.style.setProperty("--sidebar-w", "240px");
  drags.push(startPaneResizeDrag({ el, vars: ["--sidebar-w"], startX: 100, startWidth: 240, min: 160, max: 520, sign: 1, commit }));
  return { el, commit };
}

it("previews the clamped width while dragging and commits it on release", () => {
  const { el, commit } = start();
  pointer("pointermove", 1000);
  expect(el.style.getPropertyValue("--sidebar-w")).toBe("520px");
  pointer("pointermove", 150);
  pointer("pointerup");
  expect(commit).toHaveBeenCalledExactlyOnceWith(290);
  pointer("pointermove", 400);
  expect(el.style.getPropertyValue("--sidebar-w")).toBe("290px");
});

it("ends a cancelled drag without committing, so a later stray pointerup commits nothing", () => {
  const { el, commit } = start();
  pointer("pointermove", 200);
  pointer("pointercancel");
  expect(el.style.getPropertyValue("--sidebar-w")).toBe("240px");
  pointer("pointermove", 300);
  pointer("pointerup");
  expect(commit).not.toHaveBeenCalled();
  expect(el.style.getPropertyValue("--sidebar-w")).toBe("240px");
});
