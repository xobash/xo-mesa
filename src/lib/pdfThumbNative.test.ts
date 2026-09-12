import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  events: [] as string[],
  bodies: new Map<string, Uint8Array>(),
  urlError: null as Error | null,
  byteError: null as Error | null,
  blockFailedDestroy: false,
  failFailedDestroy: false,
  failSuccessfulDestroy: false,
  workersCreated: 0,
  attempts: [] as {
    kind: "url" | "bytes";
    worker: { id: number; destroyed: boolean };
    destroyStarted: boolean;
    destroyFinished: boolean;
    releaseDestroy: null | (() => void);
  }[],
}));

vi.mock("./vault", () => ({
  IN_TAURI: true,
  urlForPath: (path: string) => `asset://${path}`,
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: async (path: string) => {
    state.events.push("read-bytes");
    const body = state.bodies.get(path);
    if (!body) throw new Error("Missing fixture");
    return body.slice();
  },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: "mock-worker",
}));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  PDFWorker: class {
    id = ++state.workersCreated;
    destroyed = false;
    promise = Promise.resolve();
    destroy() {
      this.destroyed = true;
      state.events.push(`destroy-worker:${this.id}`);
    }
  },
  getDocument: (params: {
    url?: string;
    data?: Uint8Array;
    worker: { id: number; destroyed: boolean };
  }) => {
    const kind = params.url ? "url" : "bytes";
    const failure = kind === "url" ? state.urlError : state.byteError;
    const attempt: (typeof state.attempts)[number] = {
      kind,
      worker: params.worker,
      destroyStarted: false,
      destroyFinished: false,
      releaseDestroy: null as null | (() => void),
    };
    state.attempts.push(attempt);
    state.events.push(`open-${kind}`);
    const destroy = () => {
      attempt.destroyStarted = true;
      state.events.push(`destroy-${kind}-start`);
      if ((failure && state.failFailedDestroy) || (!failure && state.failSuccessfulDestroy)) {
        return Promise.reject(new Error("Document teardown rejected"));
      }
      const finish = () => {
        attempt.destroyFinished = true;
        state.events.push(`destroy-${kind}-end`);
      };
      if (failure && state.blockFailedDestroy) {
        return new Promise<void>((resolve) => {
          attempt.releaseDestroy = () => {
            finish();
            resolve();
          };
        });
      }
      finish();
      return Promise.resolve();
    };
    return {
      destroy,
      promise: failure
        ? Promise.reject(failure)
        : Promise.resolve({
            destroy,
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

let warmPdfThumb: typeof import("./pdfThumb").warmPdfThumb;
let clearPdfWorkerSpare: typeof import("./pdfWorkerPool").clearPdfWorkerSpare;

beforeEach(async () => {
  vi.resetModules();
  state.events.length = 0;
  state.bodies.clear();
  state.attempts.length = 0;
  state.urlError = null;
  state.byteError = null;
  state.blockFailedDestroy = false;
  state.failFailedDestroy = false;
  state.failSuccessfulDestroy = false;
  state.workersCreated = 0;
  vi.stubGlobal("document", {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({}),
    }),
  });
  ({ warmPdfThumb } = await import("./pdfThumb"));
  ({ clearPdfWorkerSpare } = await import("./pdfWorkerPool"));
});

afterEach(() => {
  clearPdfWorkerSpare();
  vi.unstubAllGlobals();
});

function valid(path: string) {
  state.bodies.set(path, new TextEncoder().encode("%PDF-1.4\nvalid fixture\n%%EOF"));
}

describe("native PDF thumbnail document cleanup", () => {
  it("renders a successful URL preview without reading the full file", async () => {
    const snapshot = await warmPdfThumb("/vault/url-preview.pdf");
    expect(snapshot.width).toBe(320);
    expect(state.events).not.toContain("read-bytes");
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0].destroyFinished).toBe(true);
    expect(state.attempts[0].worker.destroyed).toBe(false);
  });

  it("finishes failed URL teardown before reading and parsing the byte fallback", async () => {
    valid("/vault/fallback.pdf");
    state.urlError = new Error("URL parse rejected");
    await warmPdfThumb("/vault/fallback.pdf");
    expect(state.events.slice(0, 5)).toEqual([
      "open-url", "destroy-url-start", "destroy-url-end", "read-bytes", "open-bytes",
    ]);
    expect(state.attempts).toHaveLength(2);
    expect(state.attempts[0].destroyFinished).toBe(true);
    expect(state.attempts[1].worker).toBe(state.attempts[0].worker);
    expect(state.attempts[1].destroyFinished).toBe(true);
  });

  it("does not start a fallback or queued hover during failed-task teardown", async () => {
    valid("/vault/held.pdf");
    state.urlError = new Error("URL parse rejected");
    state.blockFailedDestroy = true;
    const first = warmPdfThumb("/vault/held.pdf");
    await vi.waitFor(() => expect(state.attempts[0]?.destroyStarted).toBe(true));
    const second = warmPdfThumb("/vault/next.pdf");
    expect(state.events).toEqual(["open-url", "destroy-url-start"]);
    state.blockFailedDestroy = false;
    state.urlError = null;
    state.attempts[0].releaseDestroy?.();
    await Promise.all([first, second]);
    expect(state.attempts.map((attempt) => attempt.kind)).toEqual(["url", "bytes", "url"]);
    expect(state.attempts.every((attempt) => attempt.destroyFinished)).toBe(true);
  });

  it("releases repeated invalid URL documents even when byte validation rejects", async () => {
    state.urlError = new Error("Not a PDF");
    for (let i = 0; i < 3; i++) {
      const path = `/vault/not-pdf-${i}.pdf`;
      state.bodies.set(path, new TextEncoder().encode("<!doctype html>"));
      await expect(warmPdfThumb(path)).rejects.toThrow("no %PDF header");
    }
    expect(state.attempts).toHaveLength(3);
    expect(state.attempts.every((attempt) => attempt.destroyFinished)).toBe(true);
    expect(new Set(state.attempts.map((attempt) => attempt.worker)).size).toBe(1);
    expect(state.attempts[0].worker.destroyed).toBe(false);
    state.urlError = null;
    await expect(warmPdfThumb("/vault/recovered.pdf")).resolves.toMatchObject({ width: 320 });
    expect(state.attempts[3].worker).toBe(state.attempts[0].worker);
  });

  it("releases a failed byte parse before discarding the worker and preserves its error", async () => {
    valid("/vault/failed-fallback.pdf");
    state.urlError = new Error("URL parse rejected");
    const failure = new Error("Byte parse rejected");
    state.byteError = failure;
    await expect(warmPdfThumb("/vault/failed-fallback.pdf")).rejects.toBe(failure);
    const byteAttempt = state.attempts[1];
    expect(byteAttempt.destroyFinished).toBe(true);
    expect(state.events.indexOf("destroy-bytes-end")).toBeLessThan(
      state.events.indexOf(`destroy-worker:${byteAttempt.worker.id}`)
    );
    state.urlError = null;
    state.byteError = null;
    await warmPdfThumb("/vault/after-failure.pdf");
    expect(state.attempts[2].worker).not.toBe(byteAttempt.worker);
  });

  it("replaces the worker before fallback when failed-task teardown rejects", async () => {
    valid("/vault/teardown-error.pdf");
    state.urlError = new Error("URL parse rejected");
    state.failFailedDestroy = true;
    await expect(warmPdfThumb("/vault/teardown-error.pdf")).resolves.toMatchObject({ width: 320 });
    expect(state.attempts[0].destroyStarted).toBe(true);
    expect(state.attempts[0].worker.destroyed).toBe(true);
    expect(state.attempts[1].worker).not.toBe(state.attempts[0].worker);
    expect(state.attempts[1].worker.destroyed).toBe(false);
  });

  it("keeps a completed preview but replaces its worker after document teardown rejects", async () => {
    state.failSuccessfulDestroy = true;
    await expect(warmPdfThumb("/vault/finished-with-teardown-error.pdf")).resolves.toMatchObject({ width: 320 });
    const previous = state.attempts[0].worker;
    expect(previous.destroyed).toBe(true);
    state.failSuccessfulDestroy = false;
    await warmPdfThumb("/vault/after-teardown-error.pdf");
    expect(state.attempts[1].worker).not.toBe(previous);
  });
});
