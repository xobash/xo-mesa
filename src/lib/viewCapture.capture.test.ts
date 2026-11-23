// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn<(cmd: string, body?: unknown, options?: unknown) => Promise<unknown>>());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { answerViewRequest, captureView } from "./viewCapture";

// jsdom has no layout or 2D canvas: give elements explicit boxes and record
// what the capture draws onto its output canvas.
interface DrawCall {
  source: unknown;
  args: number[];
}
let draws: DrawCall[];
let fills: string[];
let contextAvailable: boolean;
let encodeResult: "blob" | "null";
let loadImages: boolean;

function box(el: Element, left: number, top: number, width: number, height: number) {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
}

function canvas(width: number, height: number) {
  const el = document.createElement("canvas");
  el.width = width;
  el.height = height;
  return el;
}

function image(naturalWidth: number, naturalHeight: number, complete = true) {
  const el = document.createElement("img");
  el.src = "asset://localhost/vault/pic.png";
  Object.defineProperty(el, "naturalWidth", { value: naturalWidth });
  Object.defineProperty(el, "naturalHeight", { value: naturalHeight });
  Object.defineProperty(el, "complete", { value: complete });
  return el;
}

class FakeImage {
  crossOrigin = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    queueMicrotask(() => (loadImages ? this.onload?.() : this.onerror?.()));
  }
}

function sentRespond() {
  const call = invoke.mock.calls.find(([cmd]) => cmd === "activity_view_respond");
  if (!call) throw new Error("no activity_view_respond");
  const [, bytes, options] = call as [string, Uint8Array, { headers: Record<string, string> }];
  return { bytes, headers: options.headers, meta: JSON.parse(decodeURIComponent(options.headers["x-mesa-view-meta"])) };
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  draws = [];
  fills = [];
  contextAvailable = true;
  encodeResult = "blob";
  loadImages = true;
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("devicePixelRatio", 2);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    if (!contextAvailable) return null;
    const ctx = {
      fillStyle: "",
      fillRect: () => fills.push(String(ctx.fillStyle)),
      drawImage: (source: unknown, ...args: number[]) => draws.push({ source, args }),
    };
    return ctx as unknown as CanvasRenderingContext2D;
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (callback: BlobCallback, type?: string) {
    callback(encodeResult === "blob" ? new Blob([new Uint8Array([1, 2, 3])], { type: type ?? "" }) : null);
  });
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("captureView", () => {
  it("composites only the visible part of a canvas clipped by the root", async () => {
    const root = document.createElement("div");
    root.style.backgroundColor = "rgb(10, 20, 30)";
    box(root, 0, 0, 400, 300);
    const page = canvas(800, 1200);
    box(page, 0, -100, 400, 600);
    root.appendChild(page);
    document.body.appendChild(root);

    const capture = await captureView(root, "Docs/a.pdf", "doc");

    expect(capture.meta).toEqual({ path: "Docs/a.pdf", view: "doc", width: 800, height: 600, layers: 1, notes: [] });
    expect(capture.image?.type).toBe("image/jpeg");
    expect(fills).toEqual(["rgb(10, 20, 30)"]);
    expect(draws).toHaveLength(1);
    expect(draws[0].source).toBe(page);
    // Visible strip y 0..300 of a page drawn at y -100..500 is bitmap rows 200..800.
    expect(draws[0].args).toEqual([0, 200, 800, 600, 0, 0, 800, 600]);
  });

  it("clips by an overflow ancestor and ignores hidden and empty layers", async () => {
    const root = document.createElement("div");
    box(root, 0, 0, 500, 500);
    const scroller = document.createElement("div");
    scroller.style.overflow = "hidden";
    box(scroller, 0, 0, 200, 100);
    const shown = canvas(100, 100);
    box(shown, 0, 0, 300, 300);
    const ariaHidden = canvas(10, 10);
    ariaHidden.setAttribute("aria-hidden", "true");
    box(ariaHidden, 0, 0, 10, 10);
    const invisible = canvas(10, 10);
    invisible.style.visibility = "hidden";
    box(invisible, 0, 0, 10, 10);
    const empty = canvas(0, 0);
    box(empty, 0, 0, 10, 10);
    const offscreen = canvas(10, 10);
    box(offscreen, 600, 600, 10, 10);
    scroller.append(shown, ariaHidden, invisible, empty);
    root.append(scroller, offscreen);
    document.body.appendChild(root);

    const capture = await captureView(root, null, "graph");

    expect(capture.meta.layers).toBe(1);
    expect(draws.map((d) => d.source)).toEqual([shown]);
    expect(capture.meta.width).toBe(400);
    expect(capture.meta.height).toBe(200);
    // A transparent root background falls back to white for JPEG.
    expect(fills).toEqual(["#ffffff"]);
  });

  it("reports frames and videos it cannot draw, once each", async () => {
    const root = document.createElement("div");
    box(root, 0, 0, 300, 300);
    for (const tag of ["iframe", "iframe", "video"]) {
      const el = document.createElement(tag);
      box(el, 0, 0, 100, 100);
      root.appendChild(el);
    }
    document.body.appendChild(root);

    const capture = await captureView(root, "Web/page.html", "doc");

    expect(capture.image).toBeNull();
    expect(capture.meta.layers).toBe(0);
    expect(capture.meta.notes).toEqual([
      expect.stringContaining("embedded page"),
      expect.stringContaining("video"),
      expect.stringContaining("read Web/page.html directly"),
    ]);
  });

  it("says no document is open when nothing is visible and no path is set", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const capture = await captureView(root, null, "graph");
    expect(capture).toEqual({
      meta: { path: null, view: "graph", width: 0, height: 0, layers: 0, notes: ["No document is open in the Mesa view."] },
      image: null,
    });
  });

  it("draws a loaded image inside its object-fit content box", async () => {
    const root = document.createElement("div");
    box(root, 0, 0, 400, 400);
    const pic = image(100, 50);
    pic.style.objectFit = "contain";
    box(pic, 0, 0, 200, 200);
    root.appendChild(pic);
    document.body.appendChild(root);

    const capture = await captureView(root, "pic.png", "media");

    expect(capture.meta.layers).toBe(1);
    // contain: 200x100 content centred vertically at y 50.
    expect(capture.meta.width).toBe(400);
    expect(capture.meta.height).toBe(200);
    const final = draws[draws.length - 1];
    expect(final.source).toBeInstanceOf(HTMLCanvasElement);
    expect(final.args).toEqual([0, 0, 100, 50, 0, 0, 400, 200]);
  });

  it("notes an image that has not loaded or fails to reload", async () => {
    const root = document.createElement("div");
    box(root, 0, 0, 400, 400);
    const pending = image(0, 0, false);
    box(pending, 0, 0, 100, 100);
    root.appendChild(pending);
    document.body.appendChild(root);
    let capture = await captureView(root, "pic.png", "media");
    expect(capture.meta.notes[0]).toBe("An image in the view could not be captured.");

    loadImages = false;
    root.replaceChildren(image(10, 10));
    box(root.firstElementChild as Element, 0, 0, 10, 10);
    capture = await captureView(root, "pic.png", "media");
    expect(capture.meta.notes[0]).toBe("An image in the view could not be captured.");
    expect(capture.image).toBeNull();
  });
});

describe("answerViewRequest", () => {
  it("answers with the captured JPEG and its metadata", async () => {
    document.body.innerHTML = '<div class="center-body"></div>';
    const root = document.querySelector(".center-body") as HTMLElement;
    box(root, 0, 0, 100, 100);
    const layer = canvas(50, 50);
    box(layer, 0, 0, 100, 100);
    root.appendChild(layer);

    await answerViewRequest("req-1", "Notes/a.md", "graph");

    const sent = sentRespond();
    expect(Array.from(sent.bytes)).toEqual([1, 2, 3]);
    expect(sent.headers["x-mesa-view-request"]).toBe("req-1");
    expect(sent.headers["x-mesa-view-mime"]).toBe("image/jpeg");
    expect(sent.meta).toMatchObject({ path: "Notes/a.md", view: "graph", layers: 1, width: 200, height: 200 });
  });

  it("refuses to capture Pi itself but still answers", async () => {
    document.body.innerHTML = '<div class="center-body"></div>';
    await answerViewRequest("req-2", null, "agent");
    const sent = sentRespond();
    expect(sent.bytes).toHaveLength(0);
    expect(sent.headers["x-mesa-view-mime"]).toBe("none");
    expect(sent.meta.notes).toEqual(["No document view is visible in the Mesa workspace."]);
  });

  it("answers with the reason when the canvas context is unavailable", async () => {
    document.body.innerHTML = '<div class="center-body"></div>';
    const root = document.querySelector(".center-body") as HTMLElement;
    box(root, 0, 0, 100, 100);
    const layer = canvas(10, 10);
    box(layer, 0, 0, 10, 10);
    root.appendChild(layer);
    contextAvailable = false;
    await answerViewRequest("req-3", "a.pdf", "doc");
    const sent = sentRespond();
    expect(sent.headers["x-mesa-view-mime"]).toBe("none");
    expect(sent.meta.notes).toEqual(["Capture failed: Error: 2D canvas is unavailable"]);
  });

  it("answers with the reason when encoding fails", async () => {
    document.body.innerHTML = '<div class="center-body"></div>';
    const root = document.querySelector(".center-body") as HTMLElement;
    box(root, 0, 0, 100, 100);
    const layer = canvas(10, 10);
    box(layer, 0, 0, 10, 10);
    root.appendChild(layer);
    encodeResult = "null";
    await answerViewRequest("req-4", "a.pdf", "doc");
    expect(sentRespond().meta.notes).toEqual(["Capture failed: Error: The view could not be encoded"]);
  });
});
