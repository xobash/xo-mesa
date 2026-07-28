// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  numPages: 1,
  /** When true, a parse hangs until `releaseDocument()` is called, so a zoom
   *  can be made to land while a reparse is still in flight. */
  gateDocument: false,
  releaseDocument: null as null | (() => void),
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
    getDocument: () => {
      const makeDoc = () => ({
        get numPages() {
          return pdfjsState.numPages;
        },
        destroy: () => Promise.resolve(),
        getPage: async (pageNumber: number) => ({
          getViewport: ({ scale }: { scale: number }) => ({
            width: 300 * scale,
            height: PAGE_HEIGHT * scale,
            transform: [scale, 0, 0, -scale, 0, PAGE_HEIGHT * scale],
            convertToPdfPoint: (x: number, y: number) => [x / scale, y / scale],
          }),
          render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
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
        }),
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

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
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
  pdfjsState.numPages = 1;
  pdfjsState.gateDocument = false;
  pdfjsState.releaseDocument = null;
  latest = null;
  if (root) {
    await act(async () => root!.unmount());
  }
  root = null;
  host?.remove();
  host = null;
});

describe("usePdfEditor document identity safety", () => {
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
