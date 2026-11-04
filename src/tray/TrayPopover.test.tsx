// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TrayPopoverState } from "../lib/trayPopover";

const io = vi.hoisted(() => ({ invoke: vi.fn(), handler: null as null | ((e: { payload: unknown }) => void) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: io.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_name: string, handler: (e: { payload: unknown }) => void) => { io.handler = handler; return () => { io.handler = null; }; },
}));
import { TrayPopover } from "./TrayPopover";

const base: TrayPopoverState = {
  vault: "Synthetic", save: "All changes saved", research: null, tasksSummary: "No open tasks",
  sync: { enabled: false, busy: false, label: "off" },
  recents: [{ rel: "Notes/Alpha.md", title: "Alpha", folder: "Notes" }],
  vaults: [{ id: "aa", label: "Synthetic", current: true }, { id: "bb", label: "Other", current: false }],
  query: "", results: [],
  graph: { nodes: [{ id: "Notes/Alpha.md", title: "Alpha", degree: 1 }, { id: "Beta.md", title: "Beta", degree: 1 }], links: [[0, 1]], active: 0, total: 2, pending: false },
  palette: { node: "rgb(1, 2, 3)", nodeActive: "rgb(4, 5, 6)", nodeIsolated: "rgb(7, 8, 9)", link: "rgba(1, 2, 3, 0.1)", glowRgb: "1,2,3", bloomAlpha: 1 },
};

let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
const acts = () => io.invoke.mock.calls.filter(([cmd]) => cmd === "tray_popover_act").map(([, a]) => (a as { request: unknown }).request);
const requests = () => io.invoke.mock.calls.filter(([cmd]) => cmd === "tray_popover_request").map(([, a]) => (a as { query: string }).query);
const send = async (state: TrayPopoverState) => { await act(async () => { io.handler!({ payload: state }); }); };
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); }); };
const byText = (text: string) => [...host.querySelectorAll<HTMLElement>("[role=button], button")].find((el) => el.textContent?.includes(text));

beforeEach(async () => {
  vi.useFakeTimers();
  io.invoke.mockResolvedValue(undefined);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(<TrayPopover />); });
  await act(async () => { await Promise.resolve(); });
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  vi.useRealTimers(); vi.restoreAllMocks(); io.invoke.mockReset();
});

it("asks main for state on open and refreshes while open", async () => {
  expect(requests()).toEqual([""]);
  await act(async () => { vi.advanceTimersByTime(1500); });
  expect(requests().length).toBeGreaterThanOrEqual(2);
});

it("shows the workspace and sends each row's action", async () => {
  await send(base);
  expect(host.querySelector(".tp-title")?.firstChild?.textContent).toBe("Synthetic");
  expect(host.querySelector("canvas")?.getAttribute("aria-label")).toBe("Graph of 2 of 2 files");
  await click(byText("Alpha"));
  await click(byText("New Note"));
  await click(byText("Open graph"));
  await click(host.querySelector("[role=switch]"));
  await click(byText("Quit Mesa"));
  // The vault title opens the vault list in place of the menu rows.
  expect(byText("Other")).toBeUndefined();
  await click(host.querySelector(".tp-head-text"));
  await click(byText("Other"));
  expect(acts()).toEqual([
    { action: "note", rel: "Notes/Alpha.md" },
    { action: "new-note" },
    { action: "graph" },
    { action: "sync-toggle" },
    { action: "quit" },
    { action: "vault", id: "bb" },
  ]);
});

it("searches through main, ignores stale replies, and opens the selected hit", async () => {
  await send(base);
  const input = host.querySelector("input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, "be"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { vi.advanceTimersByTime(100); });
  expect(requests()).toContain("be");
  await send({ ...base, query: "b", results: [{ rel: "Stale.md", title: "Stale", folder: "" }] });
  expect(host.textContent).not.toContain("Stale");
  await send({ ...base, query: "be", results: [{ rel: "Beta.md", title: "Beta", folder: "" }] });
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
  expect(acts()).toEqual([{ action: "note", rel: "Beta.md" }, { action: "close" }]);
});
