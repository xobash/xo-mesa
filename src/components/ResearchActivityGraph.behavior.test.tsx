// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  copyText: vi.fn<(text: string) => Promise<boolean>>(),
  rewrite: null as null | ((raw: string) => string),
}));
vi.mock("../lib/clipboard", () => ({ copyText: io.copyText }));
vi.mock("./useRemoteImageRewrite", () => ({ useRemoteImageRewrite: () => io.rewrite }));

import { ResearchActivityGraph, ResearchSourceIcon } from "./ResearchActivityGraph";
import type { DeepResearchRunState } from "../store";
import type { ResearchActivity } from "../lib/deepResearch";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

function run(activity: ResearchActivity[], sources: DeepResearchRunState["sources"] = []): DeepResearchRunState {
  return { query: "Why is the sky blue?", activity, sources } as unknown as DeepResearchRunState;
}

const nodes = () => [...host.querySelectorAll<SVGGElement>(".dr-graph-node")];
const nodeByKind = (kind: string) => host.querySelector<SVGGElement>(`.dr-graph-node-${kind}`)!;
const card = () => host.querySelector<HTMLElement>(".dr-graph-hover-card");

beforeEach(() => {
  vi.useFakeTimers();
  io.copyText.mockReset();
  io.rewrite = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const activity: ResearchActivity[] = [
  { kind: "status", message: "starting", at: 1 },
  { kind: "plan", message: "Plan the answer", at: 2 },
  { kind: "search", message: "rayleigh scattering", at: 3 },
  { kind: "source", message: "open", sourceUrl: "https://www.example.com/rayleigh", sourceTitle: "Rayleigh", observed: true, at: 4 },
];
const sources: DeepResearchRunState["sources"] = [
  { url: "https://www.example.com/rayleigh", title: "Rayleigh scattering", status: "done", observed: true, archiveRelPath: "Research/rayleigh.html" },
];

describe("ResearchActivityGraph", () => {
  it("shows only the query plus real actions, numbered, with counts", () => {
    act(() => root.render(<ResearchActivityGraph run={run(activity, sources)} openFile={vi.fn()} />));
    expect(nodes()).toHaveLength(4);
    expect(host.querySelector(".dr-map-title")?.textContent).toBe("Research path · 4 steps");
    // Status entries are not actions.
    expect(host.querySelector(".dr-map-hint")?.textContent).toContain("3 actions · 1 sources");
    expect(nodes()[0].getAttribute("aria-label")).toBe("Step 1 of 4, query: Why is the sky blue?. Open evidence actions.");
    expect(nodeByKind("source").getAttribute("class")).toContain("observed");
    expect(nodeByKind("plan").getAttribute("class")).toContain("reported");
    expect(host.querySelectorAll(".dr-research-graph-edges path")).toHaveLength(3);
    expect(host.querySelector(".dr-graph-empty")).toBeNull();
  });

  it("explains an empty run and discloses omitted older actions", () => {
    act(() => root.render(<ResearchActivityGraph run={run([])} openFile={vi.fn()} />));
    expect(host.querySelector(".dr-graph-empty")?.textContent).toContain("No research action has been observed yet");
    const many = Array.from({ length: 60 }, (_, i): ResearchActivity => ({ kind: "search", message: `q${i}`, at: i }));
    act(() => root.render(<ResearchActivityGraph run={run(many)} openFile={vi.fn()} />));
    expect(host.querySelector(".dr-map-hint")?.textContent).toContain("12 older actions omitted");
    expect(nodes()).toHaveLength(49);
  });

  it("opens a step's card on hover and closes it after leaving", () => {
    act(() => root.render(<ResearchActivityGraph run={run(activity, sources)} openFile={vi.fn()} />));
    const plan = nodeByKind("plan");
    act(() => { plan.querySelector(".dr-graph-hitbox")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
    expect(card()?.querySelector(".dr-graph-hover-text")?.textContent).toBe("Plan the answer");
    expect(card()?.querySelector(".dr-graph-hover-meta")?.textContent).toBe("Pi reported");
    // The hovered node paints last.
    expect(nodes().at(-1)?.getAttribute("class")).toContain("dr-graph-node-plan");
    expect(nodes().at(-1)?.getAttribute("class")).toContain("hovered");
    act(() => { plan.querySelector(".dr-graph-hitbox")!.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })); });
    expect(card()).not.toBeNull();
    // Moving into the card keeps it open.
    act(() => { card()!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
    act(() => { vi.advanceTimersByTime(500); });
    expect(card()).not.toBeNull();
    act(() => { card()!.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })); });
    act(() => { vi.advanceTimersByTime(139); });
    expect(card()).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(card()).toBeNull();
  });

  it("selects with the keyboard, focuses the first action and clears on Escape", () => {
    act(() => root.render(<ResearchActivityGraph run={run(activity, sources)} openFile={vi.fn()} />));
    const plan = nodeByKind("plan");
    act(() => { plan.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    expect(plan.getAttribute("aria-pressed")).toBe("true");
    act(() => { vi.runOnlyPendingTimers(); });
    expect(document.activeElement?.textContent).toBe("Copy full text");
    // Escape inside the card clears selection and hover.
    act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(card()).toBeNull();
    expect(nodeByKind("plan").getAttribute("aria-pressed")).toBe("false");
    // Space selects; Escape on the selected node clears it.
    act(() => { nodeByKind("plan").dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })); });
    expect(nodeByKind("plan").getAttribute("aria-pressed")).toBe("true");
    act(() => { nodeByKind("plan").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(nodeByKind("plan").getAttribute("aria-pressed")).toBe("false");
    expect(card()).toBeNull();
  });

  it("toggles selection on click and keeps the card while selected", () => {
    act(() => root.render(<ResearchActivityGraph run={run(activity, sources)} openFile={vi.fn()} />));
    act(() => { nodeByKind("search").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(nodeByKind("search").getAttribute("aria-pressed")).toBe("true");
    act(() => { nodeByKind("search").querySelector(".dr-graph-hitbox")!.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })); });
    act(() => { vi.advanceTimersByTime(200); });
    expect(card()?.querySelector(".dr-graph-hover-text")?.textContent).toBe("rayleigh scattering");
    act(() => { nodeByKind("search").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(nodeByKind("search").getAttribute("aria-pressed")).toBe("false");
  });

  it("shows focus as hover and hides it on blur", () => {
    act(() => root.render(<ResearchActivityGraph run={run(activity, sources)} openFile={vi.fn()} />));
    act(() => { nodeByKind("plan").dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
    expect(card()).not.toBeNull();
    act(() => { nodeByKind("plan").dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    act(() => { vi.advanceTimersByTime(140); });
    expect(card()).toBeNull();
  });

  it("copies a step's full text and shows Copied briefly; a failed copy changes nothing", async () => {
    io.copyText.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    act(() => root.render(<ResearchActivityGraph run={run(activity, sources)} openFile={vi.fn()} />));
    act(() => { nodeByKind("plan").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const copy = () => card()!.querySelector("button")!;
    await act(async () => { copy().click(); });
    expect(io.copyText).toHaveBeenLastCalledWith("Plan the answer");
    expect(copy().textContent).toBe("Copy full text");
    await act(async () => { copy().click(); });
    expect(copy().textContent).toBe("Copied");
    act(() => { vi.advanceTimersByTime(1800); });
    expect(copy().textContent).toBe("Copy full text");
  });

  it("shows real source state and opens the saved page only when archived", async () => {
    const openFile = vi.fn(async () => {});
    io.copyText.mockResolvedValue(true);
    act(() => root.render(<ResearchActivityGraph run={run(activity, sources)} openFile={openFile} />));
    act(() => { nodeByKind("source").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(card()?.querySelector(".dr-graph-hover-meta")?.textContent).toBe("Read · Mesa observed");
    expect(card()?.querySelector(".dr-graph-hover-source-title span")?.textContent).toBeTruthy();
    const buttons = [...card()!.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Copy link · example.com", "Open saved page"]);
    await act(async () => { buttons[0].click(); });
    expect(io.copyText).toHaveBeenCalledWith("https://example.com/rayleigh");
    await act(async () => { buttons[1].click(); });
    expect(openFile).toHaveBeenCalledWith("Research/rayleigh.html");

    const unsaved: DeepResearchRunState["sources"] = [{ url: "https://example.org/x", status: "reading" }];
    act(() => root.render(<ResearchActivityGraph run={run([], unsaved)} openFile={openFile} />));
    // A source without an activity still gets a node.
    act(() => { nodeByKind("source").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(card()?.querySelector(".dr-graph-hover-meta")?.textContent).toBe("Reading · Pi reported");
    expect([...card()!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Copy link · example.org"]);
  });

  it("adopts the measured canvas size", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 512.4, height: 300.6 } as DOMRect);
    act(() => root.render(<ResearchActivityGraph run={run(activity, sources)} openFile={vi.fn()} />));
    const svg = host.querySelector("svg.dr-research-graph-svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 512 301");
  });
});

describe("ResearchSourceIcon", () => {
  const source = {
    url: "https://example.com/", siteName: "Example", host: "example.com", pageTitle: "Home",
    faviconUrl: "https://example.com/favicon.ico", initial: "E",
  };

  it("uses the initial until the image broker is ready", () => {
    act(() => root.render(<ResearchSourceIcon source={source} />));
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector(".dr-source-icon-fallback")?.textContent).toBe("E");
  });

  it("loads the favicon through the broker and falls back on error until the URL changes", () => {
    io.rewrite = (raw) => `mesa-web://broker?u=${encodeURIComponent(raw)}`;
    act(() => root.render(<ResearchSourceIcon source={source} />));
    const img = host.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(`mesa-web://broker?u=${encodeURIComponent(source.faviconUrl)}`);
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    act(() => { img.dispatchEvent(new Event("error")); });
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector(".dr-source-icon-fallback")?.textContent).toBe("E");
    act(() => root.render(<ResearchSourceIcon source={{ ...source, faviconUrl: "https://other.example/favicon.ico" }} />));
    expect(host.querySelector("img")).not.toBeNull();
  });
});
