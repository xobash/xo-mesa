import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./vault", () => ({
  IN_TAURI: false,
  urlForPath: (path: string) => `file://${path}`,
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: async () => new Uint8Array(),
}));

vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: "mock-worker",
}));

const state = vi.hoisted(() => ({
  workersCreated: 0,
  workersDestroyed: 0,
  /** The worker each getDocument call was handed. */
  workersUsed: [] as unknown[],
  /** Paths whose parse should reject, standing in for a document pdf.js chokes on. */
  failParseFor: new Set<string>(),
  blockDestroy: false,
  destroyStarted: 0,
  releaseDestroy: null as null | (() => void),
}));

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  PDFWorker: class {
    destroyed = false;
    promise = Promise.resolve();
    constructor() {
      state.workersCreated++;
    }
    destroy() {
      this.destroyed = true;
      state.workersDestroyed++;
    }
  },
  getDocument: (params: { data?: Uint8Array; worker?: unknown }) => {
    state.workersUsed.push(params.worker ?? null);
    const label = new TextDecoder().decode(params.data ?? new Uint8Array());
    if ([...state.failParseFor].some((needle) => label.includes(needle))) {
      return { promise: Promise.reject(new Error("pdf.js could not parse this")) };
    }
    return {
      promise: Promise.resolve({
        destroy: () => {
          state.destroyStarted++;
          if (!state.blockDestroy) return Promise.resolve();
          return new Promise<void>((resolve) => {
            state.releaseDestroy = resolve;
          });
        },
        getPage: async () => ({
          getViewport: ({ scale }: { scale: number }) => ({
            width: 200 * scale,
            height: 260 * scale,
          }),
          render: () => ({ promise: Promise.resolve() }),
        }),
      }),
    };
  },
}));

import { invalidatePdfThumb } from "./pdfThumbInvalidation";
import { warmPdfThumb } from "./pdfThumb";
import { clearPdfWorkerSpare } from "./pdfWorkerPool";

/** A body that passes `sanitizePdfBytes` and carries an identifying label. */
function pdfBytes(label: string): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.4\n${label}\n%%EOF\n`);
}

const bodies = new Map<string, Uint8Array>();

beforeEach(() => {
  // Hovering also pre-warms a spare for the VIEWER (see pdfWorkerPool). It is
  // module state, and it is not the worker these tests are about, so it is
  // dropped before the counters are zeroed.
  clearPdfWorkerSpare();
  state.workersCreated = 0;
  state.workersDestroyed = 0;
  state.workersUsed.length = 0;
  state.failParseFor.clear();
  state.blockDestroy = false;
  state.destroyStarted = 0;
  state.releaseDestroy = null;
  bodies.clear();
  vi.stubGlobal("fetch", async (url: string) => {
    const bytes = bodies.get(String(url).replace("file://", ""));
    if (!bytes) throw new Error(`no body for ${url}`);
    return { arrayBuffer: async () => bytes.slice(0).buffer };
  });
  vi.stubGlobal("document", {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => null,
    }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function thumb(path: string): Promise<"ok" | "failed"> {
  try {
    await warmPdfThumb(path);
    return "ok";
  } catch {
    return "failed";
  }
}

describe("pdf thumbnail worker reuse", () => {
  it("renders many thumbnails on ONE worker", async () => {
    for (let i = 0; i < 5; i++) {
      const path = `/vault/doc-${i}.pdf`;
      bodies.set(path, pdfBytes(`doc-${i}`));
      expect(await thumb(path)).toBe("ok");
    }

    // pdf.js creates and destroys a worker per document when it is not given
    // one, which cost a full worker boot per hover card.
    expect(state.workersUsed).toHaveLength(5);
    expect(new Set(state.workersUsed).size).toBe(1);
    // Documents are released, but the worker they shared must NOT be.
    expect(state.workersDestroyed).toBe(0);
  });

  it("throws the shared worker away when pdf.js fails, and still recovers", async () => {
    bodies.set("/vault/bad.pdf", pdfBytes("wedge-me"));
    bodies.set("/vault/good.pdf", pdfBytes("fine"));
    state.failParseFor.add("wedge-me");

    expect(await thumb("/vault/bad.pdf")).toBe("failed");
    // One bad document must not leave every later hover card broken.
    expect(await thumb("/vault/good.pdf")).toBe("ok");

    expect(state.workersDestroyed).toBe(1);
    expect(state.workersUsed[1]).not.toBe(state.workersUsed[0]);
  });

  it("keeps the worker when the file simply is not a PDF", async () => {
    // Vaults hold hundreds of HTML error pages saved under a .pdf name. They
    // are rejected before pdf.js is involved, so they say nothing about the
    // worker's health and must not cost a reboot each.
    bodies.set("/vault/notpdf.pdf", new TextEncoder().encode("<!DOCTYPE html>"));
    bodies.set("/vault/real.pdf", pdfBytes("real"));

    expect(await thumb("/vault/real.pdf")).toBe("ok");
    for (let i = 0; i < 4; i++) {
      invalidatePdfThumb("/vault/notpdf.pdf");
      expect(await thumb("/vault/notpdf.pdf")).toBe("failed");
    }

    expect(state.workersDestroyed).toBe(0);
    expect(new Set(state.workersUsed).size).toBe(1);
  });

  it("waits for document teardown before resolving a thumbnail", async () => {
    const path = "/vault/teardown-race.pdf";
    bodies.set(path, pdfBytes("teardown"));
    state.blockDestroy = true;
    let settled = false;
    const pending = warmPdfThumb(path).then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(state.destroyStarted).toBe(1));
    expect(settled).toBe(false);
    state.releaseDestroy?.();
    await pending;
    expect(settled).toBe(true);
  });
});
