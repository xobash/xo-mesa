// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  fileFor: (rel: string) => ({ path: `/vault/${rel}`, name: rel, ext: rel.endsWith(".pdf") ? "pdf" : "png" }),
  openDocWindow: vi.fn(),
  setBinaryDirty: vi.fn(),
}));
vi.mock("../store", () => ({ useAppStore: (select: (value: typeof state) => unknown) => select(state) }));
vi.mock("../lib/vault", () => ({
  urlForPath: (path: string) => `asset://localhost${encodeURIComponent(path)}`,
  fileKind: (ext: string) => ext === "pdf" ? "pdf" : "image",
}));
vi.mock("./PdfView", async () => {
  const { useEffect } = await import("react");
  return { PdfView: ({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) => {
    useEffect(() => { onDirtyChange?.(true); return () => onDirtyChange?.(false); }, [onDirtyChange]);
    return <div>PDF editor</div>;
  } };
});
vi.mock("./HtmlView", () => ({ HtmlView: () => null }));
vi.mock("./RtfView", () => ({ RtfView: () => null }));
import { MediaView } from "./MediaView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement("div");
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.replaceChildren(); });

it("keeps the scoped PNG URL and shows an actionable message after decode failure", () => {
  root = createRoot(host);
  act(() => root.render(<MediaView rel="Hero Screenshot.png" />));
  const image = host.querySelector("img")!;
  expect(image.getAttribute("src")).toBe("asset://localhost%2Fvault%2FHero%20Screenshot.png");
  act(() => image.dispatchEvent(new Event("load")));
  expect(host.querySelector('[role="status"]')).toBeNull();
  act(() => image.dispatchEvent(new Event("error")));
  expect(host.querySelector("img")).toBeNull();
  expect(host.textContent).toContain("Cannot load image: Hero Screenshot.png.");
  expect(host.textContent).toContain("incomplete, unsupported, or unavailable");
  act(() => host.querySelector("button")!.click());
  expect(host.querySelector("img")).not.toBe(image);
  expect(host.querySelector('[role="status"]')).toBeNull();
});

it("does not carry an image failure into another document or accept an obsolete error", () => {
  root = createRoot(host);
  act(() => root.render(<MediaView rel="bad.png" />));
  const old = host.querySelector("img")!;
  act(() => old.dispatchEvent(new Event("error")));
  act(() => root.render(<MediaView rel="good.png" />));
  expect(host.querySelector("img")?.alt).toBe("good.png");
  act(() => old.dispatchEvent(new Event("error")));
  expect(host.querySelector('[role="status"]')).toBeNull();
});

it("keeps keyboard focus on Retry when the image fails again", () => {
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<MediaView rel="bad.png" />));
  act(() => host.querySelector("img")!.dispatchEvent(new Event("error")));
  host.querySelector("button")!.focus();
  act(() => host.querySelector("button")!.click());
  act(() => host.querySelector("img")!.dispatchEvent(new Event("error")));
  expect(document.activeElement).toBe(host.querySelector("button"));
  host.remove();
});

it("reports main-pane PDF edits to the store so close and navigation can guard them", async () => {
  root = createRoot(host);
  await act(async () => root.render(<MediaView rel="docs/Scan.pdf" />));
  await vi.waitFor(() => expect(state.setBinaryDirty).toHaveBeenCalledWith("docs/Scan.pdf", true));
  await act(async () => root.render(<MediaView rel="docs/Other.pdf" />));
  expect(state.setBinaryDirty).toHaveBeenCalledWith("docs/Scan.pdf", false);
  expect(state.setBinaryDirty).toHaveBeenLastCalledWith("docs/Other.pdf", true);
});
