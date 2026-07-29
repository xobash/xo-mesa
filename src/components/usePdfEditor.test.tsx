// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { VaultFile } from "../types";

const fsState = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  onRead: null as null | ((path: string, bytes: Uint8Array) => Uint8Array),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: async (path: string) => fsState.files.has(path),
  readFile: async (path: string) => {
    const bytes = fsState.files.get(path);
    if (!bytes) throw new Error(`Missing ${path}`);
    const copy = bytes.slice(0);
    return fsState.onRead ? fsState.onRead(path, copy) : copy;
  },
  writeFile: async (path: string, bytes: Uint8Array) => {
    fsState.files.set(path, bytes.slice(0));
  },
  remove: async (path: string) => {
    fsState.files.delete(path);
  },
  rename: async (from: string, to: string) => {
    const bytes = fsState.files.get(from);
    if (!bytes) throw new Error(`Missing ${from}`);
    fsState.files.set(to, bytes.slice(0));
    fsState.files.delete(from);
  },
}));

vi.mock("../lib/vault", () => ({
  IN_TAURI: true,
  urlForPath: (path: string) => path,
}));

// Passthrough spy: the bound itself is unit-tested in pdfHistory.test.ts; here
// we pin that the hook actually routes BOTH stacks through it.
const trimCalls = vi.hoisted(
  () => [] as { entries: number; otherBytes: number }[]
);
vi.mock("../lib/pdfHistory", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/pdfHistory")>("../lib/pdfHistory");
  return {
    ...actual,
    trimPdfHistory: (
      snapshots: Uint8Array[],
      otherBytes = 0,
      limits?: Parameters<typeof actual.trimPdfHistory>[2]
    ) => {
      trimCalls.push({ entries: snapshots.length, otherBytes });
      return actual.trimPdfHistory(snapshots, otherBytes, limits);
    },
  };
});

vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: "mock-worker",
}));

const pdfjsState = vi.hoisted(() => ({
  textContentCalls: 0,
  /** 1-based page numbers pdf.js was asked to extract text from. */
  textContentPages: [] as number[],
  /** 1-based page numbers pdf.js was asked for a page proxy for (render, text
   *  extraction, or the paint-free measure pass). */
  getPageNumbers: [] as number[],
  /** 1-based page numbers pdf.js was actually asked to RASTERIZE. */
  renderedPageNumbers: [] as number[],
  numPages: 1,
  /** When true, a parse hangs until `releaseDocument()` is called, so a zoom
   *  can be made to land while a reparse is still in flight. */
  gateDocument: false,
  releaseDocument: null as null | (() => void),
  /** Workers constructed, and the worker each getDocument call was handed. */
  workersCreated: 0,
  workersDestroyed: 0,
  workersUsed: [] as unknown[],
  /** When true, the next parse rejects, standing in for a corrupt document. */
  failNextParse: false,
}));

vi.mock("pdfjs-dist", () => {
  const PAGE_HEIGHT = 200;
  return {
    GlobalWorkerOptions: { workerSrc: "" },
    // The real 2x3 affine multiply, so the geometry projection is exercised
    // rather than short-circuited.
    Util: {
      transform: (m1: number[], m2: number[]) => [
        m1[0] * m2[0] + m1[2] * m2[1],
        m1[1] * m2[0] + m1[3] * m2[1],
        m1[0] * m2[2] + m1[2] * m2[3],
        m1[1] * m2[2] + m1[3] * m2[3],
        m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
        m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
      ],
    },
    PDFWorker: class {
      destroyed = false;
      constructor() {
        pdfjsState.workersCreated++;
      }
      destroy() {
        this.destroyed = true;
        pdfjsState.workersDestroyed++;
      }
    },
    getDocument: (params?: { worker?: unknown }) => {
      pdfjsState.workersUsed.push(params?.worker ?? null);
      if (pdfjsState.failNextParse) {
        pdfjsState.failNextParse = false;
        return { promise: Promise.reject(new Error("corrupt document")) };
      }
      const makeDoc = () => ({
        get numPages() {
          return pdfjsState.numPages;
        },
        destroy: () => Promise.resolve(),
        getPage: async (pageNumber: number) => {
          pdfjsState.getPageNumbers.push(pageNumber);
          return {
            getViewport: ({ scale }: { scale: number }) => ({
              width: 300 * scale,
              height: PAGE_HEIGHT * scale,
              transform: [scale, 0, 0, -scale, 0, PAGE_HEIGHT * scale],
              convertToPdfPoint: (x: number, y: number) => [x / scale, y / scale],
            }),
            render: () => {
              pdfjsState.renderedPageNumbers.push(pageNumber);
              return { promise: Promise.resolve(), cancel: () => undefined };
            },
            // A page with no drawing operations: a blank paint from it is the
            // correct result, not a render failure.
            getOperatorList: async () => ({ fnArray: [] as number[] }),
            getTextContent: async () => {
              pdfjsState.textContentCalls++;
              pdfjsState.textContentPages.push(pageNumber);
              return {
                items: [
                  {
                    str: `page-${pageNumber}`,
                    width: 40,
                    height: 12,
                    transform: [12, 0, 0, 12, 20, 150],
                  },
                ],
              };
            },
          };
        },
      });
      if (!pdfjsState.gateDocument) return { promise: Promise.resolve(makeDoc()) };
      return {
        promise: new Promise((resolve) => {
          pdfjsState.releaseDocument = () => resolve(makeDoc());
        }),
      };
    },
  };
});

import { addText, pdfBytesEqual } from "../lib/pdf";
import { paintedBlankUnexpectedly, usePdfEditor } from "./usePdfEditor";

type HookValue = ReturnType<typeof usePdfEditor>;
let latest: HookValue | null = null;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function makePdf(label: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(label, { x: 24, y: 140, size: 18, font });
  return doc.save();
}

function file(path: string): VaultFile {
  return {
    path,
    relPath: path.slice(1),
    name: path.slice(1),
    ext: "pdf",
    isMarkdown: false,
    size: fsState.files.get(path)?.length ?? 0,
    mtime: 1,
  };
}

function Harness({
  current,
  options,
}: {
  current: VaultFile;
  options?: Parameters<typeof usePdfEditor>[1];
}) {
  latest = usePdfEditor(current, options);
  return null;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error("Timed out waiting for hook state");
}

async function render(
  current: VaultFile,
  options?: Parameters<typeof usePdfEditor>[1]
): Promise<void> {
  await act(async () => {
    root!.render(<Harness current={current} options={options} />);
  });
}

async function mountHookCanvases(count: number): Promise<void> {
  await waitFor(() => !!latest);
  await act(async () => {
    for (let page = 0; page < count; page++) {
      latest!.bindCanvas(page)({
        getContext: () => null,
      } as unknown as HTMLCanvasElement);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** A canvas the render pass can actually finish painting into. Cached per page
 *  because React hands the same element back on re-render, and a *different*
 *  element legitimately means "blank bitmap, repaint me". */
const paintableCanvases = new Map<number, HTMLCanvasElement>();

function paintableCanvas(page: number): HTMLCanvasElement {
  let canvas = paintableCanvases.get(page);
  if (!canvas) {
    canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: () => undefined,
        getImageData: (_x: number, _y: number, w: number, h: number) => ({
          data: new Uint8ClampedArray(Math.max(4, w * h * 4)),
        }),
      }),
    } as unknown as HTMLCanvasElement;
    paintableCanvases.set(page, canvas);
  }
  return canvas;
}

async function mountPaintableCanvases(count: number): Promise<void> {
  await waitFor(() => !!latest);
  await act(async () => {
    for (let page = 0; page < count; page++) {
      latest!.bindCanvas(page)(paintableCanvas(page));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number;
  globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id);
});

afterEach(async () => {
  fsState.files.clear();
  fsState.onRead = null;
  trimCalls.length = 0;
  pdfjsState.textContentCalls = 0;
  pdfjsState.textContentPages.length = 0;
  pdfjsState.getPageNumbers.length = 0;
  pdfjsState.renderedPageNumbers.length = 0;
  pdfjsState.numPages = 1;
  pdfjsState.gateDocument = false;
  pdfjsState.releaseDocument = null;
  pdfjsState.failNextParse = false;
  latest = null;
  paintableCanvases.clear();
  if (root) {
    await act(async () => root!.unmount());
  }
  root = null;
  host?.remove();
  host = null;
  // Worker teardown is deliberately asynchronous (the worker has to outlive the
  // document's "Terminate" exchange), so let it settle and reset the counters
  // AFTER unmount — otherwise this test's teardown is counted against the next.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  pdfjsState.workersCreated = 0;
  pdfjsState.workersDestroyed = 0;
  pdfjsState.workersUsed.length = 0;
});

describe("usePdfEditor document identity safety", () => {
  it("does not ask pdf.js for unmounted pages on the first paint path", async () => {
    pdfjsState.numPages = 5;
    const start = await makePdf("first-paint");
    fsState.files.set("/first-paint.pdf", start);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await render(file("/first-paint.pdf"));
    await waitFor(() => latest?.pageCount === 5);

    // Parsing alone must not synchronously discover every page. The render
    // effect runs once before React mounts any page canvas and should skip
    // without touching pdf.js page proxies.
    expect(pdfjsState.getPageNumbers).toEqual([]);

    await mountHookCanvases(1);
    await waitFor(() => latest!.viewports.current.size === 1);

    expect(pdfjsState.getPageNumbers).toEqual([1]);
  });

  it("discards an edit that finishes after the user switches to another PDF", async () => {
    const a = await makePdf("A");
    const b = await makePdf("B");
    const transformedA = await addText(a, { page: 0, x: 20, y: 20, text: "late" });
    fsState.files.set("/a.pdf", a);
    fsState.files.set("/b.pdf", b);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await render(file("/a.pdf"));
    await waitFor(() => !!latest?.bytes && pdfBytesEqual(latest.bytes, a));

    let resolveTransform!: (value: Uint8Array) => void;
    const delayed = new Promise<Uint8Array>((resolve) => {
      resolveTransform = resolve;
    });
    let edit!: Promise<void>;
    act(() => {
      edit = latest!.apply(async () => delayed);
    });

    await render(file("/b.pdf"));
    await waitFor(() => !!latest?.bytes && pdfBytesEqual(latest.bytes, b));

    await act(async () => {
      resolveTransform(transformedA);
      await edit;
    });

    expect(pdfBytesEqual(latest!.bytes, b)).toBe(true);
    expect(pdfBytesEqual(latest!.bytes, transformedA)).toBe(false);
    expect(latest!.dirty).toBe(false);
  });

  it("repaints every page when a zoom lands mid-reparse, not just the edited one", async () => {
    pdfjsState.numPages = 3;
    const start = await makePdf("zoom-race");
    const edited = await addText(start, { page: 0, x: 10, y: 10, text: "stamp" });
    fsState.files.set("/race-zoom.pdf", start);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await render(file("/race-zoom.pdf"));
    await mountHookCanvases(3);
    await waitFor(() => latest!.viewports.current.size === 3);
    for (const page of [0, 1, 2]) {
      expect(latest!.viewports.current.get(page)!.width).toBeCloseTo(300 * 1.2, 6);
    }

    // Hold the next parse open so the page-scoped edit's override is pending
    // while the zoom settles.
    pdfjsState.gateDocument = true;
    await act(async () => {
      await latest!.apply(async () => edited, { pages: [1] });
    });
    act(() => {
      latest!.setScale(2.4);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    await waitFor(() => latest!.renderScale === 2.4);

    // The zoom pass must not consume the edit's page override: every page has
    // to be re-measured, or the untouched ones stay sized for the old scale.
    for (const page of [0, 1, 2]) {
      expect(
        latest!.viewports.current.get(page)!.width,
        `page ${page} after zoom`
      ).toBeCloseTo(300 * 2.4, 6);
    }

    // Releasing the parse then applies the scoped repaint, still at 2.4.
    await act(async () => {
      pdfjsState.releaseDocument?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    for (const page of [0, 1, 2]) {
      expect(latest!.viewports.current.get(page)!.width).toBeCloseTo(300 * 2.4, 6);
    }
  });

  it("re-extracts only the edited page, and the whole document when it must", async () => {
    pdfjsState.numPages = 3;
    const start = await makePdf("incremental");
    const edited = await addText(start, { page: 0, x: 10, y: 10, text: "stamp" });
    fsState.files.set("/inc.pdf", start);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await render(file("/inc.pdf"), { extractText: true });
    await waitFor(() => (latest?.textRuns.length ?? 0) === 3);
    expect(pdfjsState.textContentPages).toEqual([1, 2, 3]);

    // A page-scoped edit touches only its own page's text.
    pdfjsState.textContentPages.length = 0;
    await act(async () => {
      await latest!.apply(async () => edited, { pages: [1] });
    });
    await waitFor(() => pdfjsState.textContentPages.length > 0);
    expect(pdfjsState.textContentPages).toEqual([2]);

    // The untouched pages kept their runs, and the whole set is still intact
    // and page-ordered.
    await waitFor(() => (latest?.textRuns.length ?? 0) === 3);
    expect(latest!.textRuns.map((r) => r.text)).toEqual([
      "page-1",
      "page-2",
      "page-3",
    ]);
    expect(latest!.textRuns.map((r) => r.page)).toEqual([0, 1, 2]);

    // A structural edit can shift page indices, so every cached run is suspect.
    const structural = await addText(edited, { page: 0, x: 10, y: 30, text: "s2" });
    pdfjsState.textContentPages.length = 0;
    await act(async () => {
      await latest!.apply(async () => structural, { structural: true });
    });
    await waitFor(() => pdfjsState.textContentPages.length > 0);
    expect(pdfjsState.textContentPages).toEqual([1, 2, 3]);
  });

  it("re-extracts every page after undo, which can change any of them", async () => {
    pdfjsState.numPages = 2;
    const start = await makePdf("undoable");
    const edited = await addText(start, { page: 0, x: 10, y: 10, text: "stamp" });
    fsState.files.set("/undo.pdf", start);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await render(file("/undo.pdf"), { extractText: true });
    await waitFor(() => (latest?.textRuns.length ?? 0) === 2);

    await act(async () => {
      await latest!.apply(async () => edited, { pages: [0] });
    });
    await waitFor(() => pdfjsState.textContentPages.includes(1));

    pdfjsState.textContentPages.length = 0;
    await act(async () => {
      await latest!.undo();
    });
    await waitFor(() => pdfjsState.textContentPages.length > 0);
    expect(pdfjsState.textContentPages).toEqual([1, 2]);
  });

  it("reprojects text runs on zoom without re-extracting them", async () => {
    const start = await makePdf("zoom");
    fsState.files.set("/zoom.pdf", start);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await render(file("/zoom.pdf"), { extractText: true });
    await waitFor(() => (latest?.textRuns.length ?? 0) > 0);

    const extractionsAfterOpen = pdfjsState.textContentCalls;
    expect(extractionsAfterOpen).toBeGreaterThan(0);
    const before = latest!.textRuns[0];

    // Zoom in; renderScale settles on a 140 ms debounce.
    act(() => {
      latest!.setScale(2.4);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    await waitFor(() => latest!.renderScale === 2.4);
    await waitFor(() => latest!.textRuns[0]?.height !== before.height);

    const after = latest!.textRuns[0];
    // Screen geometry followed the zoom...
    expect(after.height).toBeCloseTo(before.height * 2, 6);
    expect(after.left).toBeCloseTo(before.left * 2, 6);
    // ...PDF-space coordinates (what edits are written with) did not...
    expect(after.pdfX).toBe(before.pdfX);
    expect(after.pdfY).toBe(before.pdfY);
    expect(after.pdfWidth).toBe(before.pdfWidth);
    expect(after.pdfHeight).toBe(before.pdfHeight);
    // ...and pdf.js was never asked for the text again.
    expect(pdfjsState.textContentCalls).toBe(extractionsAfterOpen);
  });

  it("bounds both undo and redo retention, counting the bytes it already holds", async () => {
    const start = await makePdf("bounded");
    const once = await addText(start, { page: 0, x: 20, y: 20, text: "one" });
    const twice = await addText(once, { page: 0, x: 20, y: 40, text: "two" });
    fsState.files.set("/bounded.pdf", start);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await render(file("/bounded.pdf"));
    await waitFor(() => !!latest?.bytes && pdfBytesEqual(latest.bytes, start));

    await act(async () => {
      await latest!.apply(async () => once);
    });
    await act(async () => {
      await latest!.apply(async () => twice);
    });
    expect(latest!.canUndo).toBe(true);

    // Undo pushes the current bytes onto the redo stack — that stack must be
    // bounded too, or redo becomes the unbounded leak instead of undo.
    await act(async () => {
      await latest!.undo();
    });
    expect(latest!.canRedo).toBe(true);
    expect(pdfBytesEqual(latest!.bytes, once)).toBe(true);

    // Every trim saw the bytes held outside the stack it was trimming, so the
    // budget covers real retention rather than one stack in isolation.
    expect(trimCalls.length).toBeGreaterThanOrEqual(3);
    expect(trimCalls.every((c) => c.otherBytes > 0)).toBe(true);

    // Ordinary documents keep their full history — the bound must not be
    // trimming real editing sessions.
    await act(async () => {
      await latest!.redo();
    });
    expect(pdfBytesEqual(latest!.bytes, twice)).toBe(true);
    expect(latest!.canUndo).toBe(true);
  });

  it("blocks save when an external rewrite lands during verified staging", async () => {
    const baseline = await makePdf("baseline");
    const external = await addText(baseline, {
      page: 0,
      x: 30,
      y: 30,
      text: "external",
    });
    const edited = await addText(baseline, {
      page: 0,
      x: 40,
      y: 40,
      text: "mesa",
    });
    fsState.files.set("/race.pdf", baseline);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await render(file("/race.pdf"));
    await waitFor(() => !!latest?.bytes && pdfBytesEqual(latest.bytes, baseline));
    await act(async () => {
      await latest!.apply(async () => edited);
    });
    await waitFor(() => latest?.dirty === true);

    let pathReads = 0;
    fsState.onRead = (path, bytes) => {
      if (path === "/race.pdf" && ++pathReads === 1) {
        fsState.files.set(path, external.slice(0));
      }
      return bytes;
    };
    await act(async () => {
      await latest!.save();
    });

    expect(pdfBytesEqual(fsState.files.get("/race.pdf")!, external)).toBe(true);
    expect(pdfBytesEqual(fsState.files.get("/race.pdf")!, edited)).toBe(false);
    expect(latest!.status).toMatch(/^Save blocked:/);
    expect(latest!.dirty).toBe(true);
  });

  it("saves the result of an earlier queued edit instead of its pre-edit bytes", async () => {
    const baseline = await makePdf("baseline");
    const edited = await addText(baseline, {
      page: 0,
      x: 40,
      y: 40,
      text: "queued edit",
    });
    fsState.files.set("/queued.pdf", baseline);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await render(file("/queued.pdf"));
    await waitFor(() => !!latest?.bytes && pdfBytesEqual(latest.bytes, baseline));

    let resolveTransform!: (value: Uint8Array) => void;
    const delayed = new Promise<Uint8Array>((resolve) => {
      resolveTransform = resolve;
    });
    let edit!: Promise<void>;
    let save!: Promise<void> | undefined;
    act(() => {
      edit = latest!.apply(async () => delayed);
      save = latest!.save();
    });

    await act(async () => {
      resolveTransform(edited);
      await edit;
      await save;
    });

    expect(pdfBytesEqual(fsState.files.get("/queued.pdf")!, edited)).toBe(true);
    expect(latest!.dirty).toBe(false);
    expect(latest!.status).toBe("Saved.");
  });
});

describe("blank first-page detection", () => {
  const WHITE = (w: number, h: number) => ({
    data: new Uint8ClampedArray(w * h * 4).fill(255),
  });
  const INKED = (w: number, h: number) => {
    const data = new Uint8ClampedArray(w * h * 4).fill(255);
    for (let i = 0; i < data.length; i += 4) data[i] = 0; // black-ish red channel
    return { data };
  };
  const canvas = { width: 64, height: 64 };
  const ctxOf = (make: (w: number, h: number) => { data: Uint8ClampedArray }) => ({
    getImageData: () => make(canvas.width, canvas.height),
  });
  const pageWithOps = (length: number, calls?: { n: number }) => ({
    getOperatorList: async () => {
      if (calls) calls.n++;
      return { fnArray: new Array(length), argsArray: [] } as never;
    },
  });

  it("accepts a blank paint when the page has nothing to draw", async () => {
    // A blank cover/separator sheet: pdf.js reports an empty operator list, so
    // blank IS the correct render and must not drop Mesa into the fallback.
    await expect(
      paintedBlankUnexpectedly(ctxOf(WHITE), canvas, pageWithOps(0))
    ).resolves.toBe(false);
  });

  it("still reports a blank paint when the page had content to draw", async () => {
    await expect(
      paintedBlankUnexpectedly(ctxOf(WHITE), canvas, pageWithOps(31))
    ).resolves.toBe(true);
  });

  it("never pays for the operator list when the page painted normally", async () => {
    const calls = { n: 0 };
    await expect(
      paintedBlankUnexpectedly(ctxOf(INKED), canvas, pageWithOps(31, calls))
    ).resolves.toBe(false);
    expect(calls.n).toBe(0);
  });

  it("treats an unreadable canvas as 'cannot tell', not as a failed render", async () => {
    await expect(
      paintedBlankUnexpectedly(
        {
          getImageData: () => {
            throw new Error("tainted canvas");
          },
        },
        canvas,
        pageWithOps(31)
      )
    ).resolves.toBe(false);
  });

  it("keeps the protective fallback when pdf.js cannot report the page content", async () => {
    await expect(
      paintedBlankUnexpectedly(ctxOf(WHITE), canvas, {
        getOperatorList: async () => {
          throw new Error("worker gone");
        },
      })
    ).resolves.toBe(true);
  });
});

describe("page-scoped repaint accumulation", () => {
  it("repaints BOTH pages when two scoped edits land before one reparse", async () => {
    pdfjsState.numPages = 3;
    const start = await makePdf("accumulate");
    // The document itself only needs to CHANGE per edit; which page each edit
    // claims to touch is carried by the `pages` option below.
    const afterA = await addText(start, { page: 0, x: 10, y: 10, text: "A" });
    const afterB = await addText(afterA, { page: 0, x: 10, y: 30, text: "B" });
    fsState.files.set("/accumulate.pdf", start);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await render(file("/accumulate.pdf"));
    await mountHookCanvases(3);
    await waitFor(() => latest!.viewports.current.size === 3);

    // Hold every reparse open so BOTH scoped edits commit before the render
    // effect ever sees a new document — the rapid-annotation case.
    pdfjsState.gateDocument = true;
    await act(async () => {
      await latest!.apply(async () => afterA, { pages: [0] });
    });
    await act(async () => {
      await latest!.apply(async () => afterB, { pages: [2] });
    });

    // Only pages the next render pass actually touches get re-measured.
    latest!.viewports.current.clear();
    pdfjsState.gateDocument = false;
    await act(async () => {
      pdfjsState.releaseDocument?.();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await waitFor(() => latest!.viewports.current.size > 0);

    const touched = [...latest!.viewports.current.keys()].sort();
    // Page 0's edit must not be dropped just because page 2 was edited after it.
    expect(touched).toContain(0);
    expect(touched).toContain(2);
  });
});

describe("render pass idempotence", () => {
  // These tests need paints to actually COMPLETE, so the effect-local scratch
  // canvas needs a working 2d context too — the suite default hands back null.
  beforeEach(() => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(
      () =>
        ({
          drawImage: () => undefined,
          getImageData: (_x: number, _y: number, w: number, h: number) => ({
            data: new Uint8ClampedArray(Math.max(4, w * h * 4)),
          }),
        }) as unknown as CanvasRenderingContext2D
    );
  });

  afterEach(() => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
  });

  it("paints newly mounted pages without repainting the pages already up", async () => {
    pdfjsState.numPages = 6;
    const start = await makePdf("idempotent");
    fsState.files.set("/idempotent.pdf", start);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await render(file("/idempotent.pdf"));
    await waitFor(() => latest?.pageCount === 6);

    // Page 1 alone is mounted first, exactly as PdfView admits it.
    await mountPaintableCanvases(1);
    await waitFor(() => latest!.paintedPages.size === 1);
    expect(pdfjsState.renderedPageNumbers).toEqual([1]);

    // The remaining shells arrive, and the viewer reports the whole document on
    // screen. Each mount re-runs the render effect, and the pass must cost only
    // the pages that are actually missing — repainting page 1 on every batch is
    // what made a 357-page document plan 8,294 page renders instead of 357.
    await mountPaintableCanvases(6);
    await act(async () => {
      latest!.setOnscreenPages(new Set([0, 1, 2, 3, 4, 5]));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => latest!.paintedPages.size === 6);
    expect(pdfjsState.renderedPageNumbers).toEqual([1, 2, 3, 4, 5, 6]);

    // Every page is credited at the scale it was painted at.
    expect([...latest!.paintedPages.values()]).toEqual([1.2, 1.2, 1.2, 1.2, 1.2, 1.2]);
  });

  it("still repaints a page whose canvas element was replaced", async () => {
    pdfjsState.numPages = 2;
    const start = await makePdf("remount");
    fsState.files.set("/remount.pdf", start);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await render(file("/remount.pdf"));
    await waitFor(() => latest?.pageCount === 2);
    await mountPaintableCanvases(2);
    await waitFor(() => latest!.paintedPages.size === 2);
    pdfjsState.renderedPageNumbers.length = 0;

    // React handing back a DIFFERENT canvas means a blank bitmap, however
    // painted the old element was. Skipping that page would leave it empty.
    paintableCanvases.delete(1);
    await mountPaintableCanvases(2);
    await waitFor(() => pdfjsState.renderedPageNumbers.length > 0);
    await waitFor(() => latest!.paintedPages.size === 2);
    expect(pdfjsState.renderedPageNumbers).toEqual([2]);
  });

  it("repaints only the page a scoped edit invalidated", async () => {
    pdfjsState.numPages = 3;
    const start = await makePdf("scoped");
    const edited = await addText(start, { page: 0, x: 10, y: 10, text: "stamp" });
    fsState.files.set("/scoped.pdf", start);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await render(file("/scoped.pdf"));
    await waitFor(() => latest?.pageCount === 3);
    await mountPaintableCanvases(3);
    await waitFor(() => latest!.paintedPages.size === 3);
    pdfjsState.renderedPageNumbers.length = 0;

    await act(async () => {
      await latest!.apply(async () => edited, { pages: [1] });
    });
    await waitFor(() => pdfjsState.renderedPageNumbers.length > 0);
    await waitFor(() => latest!.paintedPages.size === 3);
    expect(pdfjsState.renderedPageNumbers).toEqual([2]);
  });

  it("repaints every mounted page after a zoom, at the new scale", async () => {
    pdfjsState.numPages = 3;
    const start = await makePdf("zoomed");
    fsState.files.set("/zoomed.pdf", start);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await render(file("/zoomed.pdf"));
    await waitFor(() => latest?.pageCount === 3);
    await mountPaintableCanvases(3);
    await waitFor(() => latest!.paintedPages.size === 3);
    pdfjsState.renderedPageNumbers.length = 0;

    // Two acts on purpose: the first flushes the state update so the zoom
    // debounce is (re)armed, the second waits that debounce out.
    await act(async () => {
      latest!.setScale(2);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    await waitFor(
      () =>
        latest!.paintedPages.size === 3 &&
        [...latest!.paintedPages.values()].every((s) => s === 2)
    );
    expect(pdfjsState.renderedPageNumbers).toEqual([1, 2, 3]);
  });

  it("repaints everything after undo, which can change any page", async () => {
    pdfjsState.numPages = 3;
    const start = await makePdf("undo-all");
    const edited = await addText(start, { page: 0, x: 10, y: 10, text: "stamp" });
    fsState.files.set("/undo-all.pdf", start);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await render(file("/undo-all.pdf"));
    await waitFor(() => latest?.pageCount === 3);
    await mountPaintableCanvases(3);
    await waitFor(() => latest!.paintedPages.size === 3);

    await act(async () => {
      await latest!.apply(async () => edited, { pages: [1] });
    });
    await waitFor(() => latest!.canUndo);
    await waitFor(() => latest!.paintedPages.size === 3);
    pdfjsState.renderedPageNumbers.length = 0;

    await act(async () => {
      await latest!.undo();
    });
    await waitFor(() => pdfjsState.renderedPageNumbers.length >= 3);
    expect([...new Set(pdfjsState.renderedPageNumbers)].sort()).toEqual([1, 2, 3]);
  });
});

describe("viewport-windowed rasterization", () => {
  beforeEach(() => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(
      () =>
        ({
          drawImage: () => undefined,
          getImageData: (_x: number, _y: number, w: number, h: number) => ({
            data: new Uint8ClampedArray(Math.max(4, w * h * 4)),
          }),
        }) as unknown as CanvasRenderingContext2D
    );
  });

  afterEach(() => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
  });

  it("rasterizes a bounded window instead of the whole document", async () => {
    pdfjsState.numPages = 400;
    const start = await makePdf("huge");
    fsState.files.set("/huge.pdf", start);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await render(file("/huge.pdf"));
    await waitFor(() => latest?.pageCount === 400);
    await mountPaintableCanvases(400);
    await waitFor(() => latest!.paintedPages.size > 0);
    // Let any further passes settle.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // Every page has a canvas mounted, but only the window around the reader's
    // position is allowed to hold pixels. Painting all 400 is what cost ~1 GB.
    expect(latest!.paintedPages.size).toBeLessThanOrEqual(8);
    expect(latest!.paintedPages.has(0)).toBe(true);
    expect(latest!.paintedPages.has(399)).toBe(false);
  });

  it("paints pages as they scroll into view and releases the ones left behind", async () => {
    pdfjsState.numPages = 400;
    const start = await makePdf("scrolled");
    fsState.files.set("/scrolled.pdf", start);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await render(file("/scrolled.pdf"));
    await waitFor(() => latest?.pageCount === 400);
    await mountPaintableCanvases(400);
    await waitFor(() => latest!.paintedPages.has(0));

    await act(async () => {
      latest!.setOnscreenPages(new Set([200, 201]));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await waitFor(
      () => latest!.paintedPages.has(200) && latest!.paintedPages.has(201)
    );

    // The pages the reader is on are painted...
    expect(latest!.paintedPages.has(201)).toBe(true);
    // ...page 1 is always kept (it retires the native view and carries the
    // blank-paint check)...
    expect(latest!.paintedPages.has(0)).toBe(true);
    // ...and the pages left far behind gave their pixel memory back.
    expect(latest!.paintedPages.has(3)).toBe(false);
    expect(latest!.paintedPages.size).toBeLessThanOrEqual(10);
  });

  it("repaints a released page when the reader scrolls back to it", async () => {
    pdfjsState.numPages = 200;
    const start = await makePdf("back");
    fsState.files.set("/back.pdf", start);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await render(file("/back.pdf"));
    await waitFor(() => latest?.pageCount === 200);
    await mountPaintableCanvases(200);
    await act(async () => {
      latest!.setOnscreenPages(new Set([50]));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await waitFor(() => latest!.paintedPages.has(50));

    await act(async () => {
      latest!.setOnscreenPages(new Set([150]));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await waitFor(() => latest!.paintedPages.has(150));
    expect(latest!.paintedPages.has(50)).toBe(false);

    // Coming back must repaint rather than trust a canvas whose bitmap we
    // deliberately dropped — otherwise the reader gets a blank page.
    pdfjsState.renderedPageNumbers.length = 0;
    await act(async () => {
      latest!.setOnscreenPages(new Set([50]));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await waitFor(() => latest!.paintedPages.has(50));
    expect(pdfjsState.renderedPageNumbers).toContain(51);
  });

  it("measures every page without painting it, so layout can be reserved", async () => {
    pdfjsState.numPages = 60;
    const start = await makePdf("measured");
    fsState.files.set("/measured.pdf", start);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await render(file("/measured.pdf"));
    await waitFor(() => latest?.pageCount === 60);
    await mountPaintableCanvases(60);
    await waitFor(() => latest!.pageSizes.size === 60);

    // Sizes are intrinsic (scale 1), so a zoom re-derives them without a
    // second measure pass.
    expect(latest!.pageSizes.get(0)).toEqual({ width: 300, height: 200 });
    // Measuring is metadata only: it must not have painted the document.
    expect(latest!.paintedPages.size).toBeLessThanOrEqual(8);
  });
});

describe("pdf.js worker lifecycle", () => {
  it("reuses one worker across the documents a viewer opens", async () => {
    const a = await makePdf("W-A");
    const b = await makePdf("W-B");
    fsState.files.set("/w-a.pdf", a);
    fsState.files.set("/w-b.pdf", b);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await render(file("/w-a.pdf"));
    await waitFor(() => !!latest?.bytes && pdfBytesEqual(latest.bytes, a));
    await render(file("/w-b.pdf"));
    await waitFor(() => !!latest?.bytes && pdfBytesEqual(latest.bytes, b));
    await waitFor(() => pdfjsState.workersUsed.length >= 2);

    // Booting a worker was the whole cost of the parse phase for small PDFs,
    // so the second document must not pay it again.
    expect(pdfjsState.workersCreated).toBe(1);
    expect(pdfjsState.workersUsed[0]).toBeTruthy();
    expect(pdfjsState.workersUsed[1]).toBe(pdfjsState.workersUsed[0]);
  });

  it("throws the worker away after a failed parse", async () => {
    const good = await makePdf("W-good");
    fsState.files.set("/w-bad.pdf", good);
    fsState.files.set("/w-good.pdf", good);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    pdfjsState.failNextParse = true;
    await render(file("/w-bad.pdf"));
    await waitFor(() => latest?.renderError === true);
    expect(pdfjsState.workersDestroyed).toBe(1);

    // Whatever the bad document did to that worker, the next one starts clean —
    // reuse must not turn one corrupt file into a poisoned viewer.
    await render(file("/w-good.pdf"));
    await waitFor(() => pdfjsState.workersUsed.length >= 2);
    expect(pdfjsState.workersCreated).toBe(2);
    expect(pdfjsState.workersUsed[1]).not.toBe(pdfjsState.workersUsed[0]);
  });

  it("destroys the worker on unmount, after the document it serves", async () => {
    const doc = await makePdf("W-unmount");
    fsState.files.set("/w-unmount.pdf", doc);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await render(file("/w-unmount.pdf"));
    await waitFor(() => latest?.pageCount === 1);
    expect(pdfjsState.workersCreated).toBe(1);
    expect(pdfjsState.workersDestroyed).toBe(0);

    await act(async () => {
      root!.unmount();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    root = null;
    await waitFor(() => pdfjsState.workersDestroyed === 1);
    expect(pdfjsState.workersDestroyed).toBe(1);
  });
});

describe("memory behaviour on the open path", () => {
  it("adopts the freshly read buffer instead of copying it", async () => {
    const doc = await makePdf("adopt");
    fsState.files.set("/adopt.pdf", doc);
    // Hand back a buffer we keep a reference to, so we can check identity.
    let handedOut: Uint8Array | null = null;
    fsState.onRead = (_path, bytes) => {
      handedOut = bytes;
      return bytes;
    };
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await render(file("/adopt.pdf"));
    await waitFor(() => !!latest?.bytes);

    // Opening an N-byte PDF allocated 3N (read + defensive snapshot + the copy
    // pdf.js transfers to its worker). The snapshot is the one that buys
    // nothing, and on a swapping machine it is paid for in page faults.
    expect(latest!.bytes).toBe(handedOut);
  });

  it("keeps edited bytes on their own copy, never aliasing the transform result", async () => {
    const start = await makePdf("alias");
    const edited = await addText(start, { page: 0, x: 10, y: 10, text: "x" });
    fsState.files.set("/alias.pdf", start);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await render(file("/alias.pdf"));
    await waitFor(() => !!latest?.bytes);

    // Adoption is only safe for buffers the hook exclusively owns. An edit
    // result comes from a caller that may keep using it, so it must be copied.
    await act(async () => {
      await latest!.apply(async () => edited, { pages: [1] });
    });
    await waitFor(() => latest!.dirty);
    expect(latest!.bytes).not.toBe(edited);
    expect(pdfBytesEqual(latest!.bytes!, edited)).toBe(true);
  });
});
