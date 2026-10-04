import { afterEach, describe, expect, it, vi } from "vitest";
import type { PDFWorker } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  clearPdfWorkerSpare,
  primePdfWorker,
  releaseUnusedPdfWorker,
  takePdfWorker,
} from "./pdfWorkerPool";

interface FakeWorker {
  destroyed: boolean;
  destroy(): void;
  promise: Promise<void>;
  id: number;
}

let nextId = 1;

function fakeWorker(
  promise: Promise<void> = Promise.resolve()
): FakeWorker & PDFWorker {
  const worker: FakeWorker = {
    id: nextId++,
    destroyed: false,
    promise,
    destroy() {
      this.destroyed = true;
    },
  };
  return worker as unknown as FakeWorker & PDFWorker;
}

/** Let the boot promise's `.then` handlers run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
  clearPdfWorkerSpare();
});

describe("pdf.js warm worker spare", () => {
  it("hands out a booted spare exactly once", async () => {
    const worker = fakeWorker();
    primePdfWorker(() => worker);
    await settle();

    expect(takePdfWorker()).toBe(worker);
    // A second caller must never receive the same worker: two viewers sharing
    // one worker is the failure this whole design exists to prevent.
    expect(takePdfWorker()).toBeNull();
  });

  it("does not publish a worker whose boot failed", async () => {
    const worker = fakeWorker(Promise.reject(new Error("worker blocked")));
    primePdfWorker(() => worker);
    await settle();

    expect(takePdfWorker()).toBeNull();
    expect(worker.destroyed).toBe(true);
  });

  it("does not publish a worker that is still booting", async () => {
    let boot!: () => void;
    const worker = fakeWorker(new Promise<void>((resolve) => (boot = resolve)));
    primePdfWorker(() => worker);
    await settle();

    // Adopting a half-booted worker would tie a document's fate to a boot that
    // may still fail, turning a healthy open into a render error.
    expect(takePdfWorker()).toBeNull();
    boot();
    await settle();
    expect(takePdfWorker()).toBe(worker);
  });

  it("keeps at most one spare, so the idle cost stays one thread", async () => {
    const first = fakeWorker();
    primePdfWorker(() => first);
    await settle();

    const second = fakeWorker();
    primePdfWorker(() => second);
    await settle();

    // The second prime is a no-op while a spare is ready; the factory result
    // must not accumulate.
    expect(second.destroyed).toBe(false);
    expect(takePdfWorker()).toBe(first);
    expect(takePdfWorker()).toBeNull();
  });

  it("does not start a second boot while one is in flight", async () => {
    let boot!: () => void;
    const first = fakeWorker(new Promise<void>((resolve) => (boot = resolve)));
    let factoryCalls = 0;
    primePdfWorker(() => {
      factoryCalls++;
      return first;
    });
    primePdfWorker(() => {
      factoryCalls++;
      return fakeWorker();
    });
    expect(factoryCalls).toBe(1);
    boot();
    await settle();
    expect(takePdfWorker()).toBe(first);
  });

  it("survives a factory that throws", () => {
    expect(() =>
      primePdfWorker(() => {
        throw new Error("pdf.js unavailable");
      })
    ).not.toThrow();
    expect(takePdfWorker()).toBeNull();
  });

  it("never hands back a worker that was destroyed while parked", async () => {
    const worker = fakeWorker();
    primePdfWorker(() => worker);
    await settle();
    worker.destroy();

    expect(takePdfWorker()).toBeNull();
  });

  it("takes back an unused worker so a fast remount does not reboot one", () => {
    const worker = fakeWorker();
    releaseUnusedPdfWorker(worker);

    expect(takePdfWorker()).toBe(worker);
  });

  it("destroys a returned worker rather than keeping two spares", () => {
    const parked = fakeWorker();
    releaseUnusedPdfWorker(parked);
    const extra = fakeWorker();
    releaseUnusedPdfWorker(extra);

    expect(extra.destroyed).toBe(true);
    expect(takePdfWorker()).toBe(parked);
  });

  it("ignores a destroyed worker offered back", () => {
    const worker = fakeWorker();
    worker.destroy();
    releaseUnusedPdfWorker(worker);

    expect(takePdfWorker()).toBeNull();
  });

  it("destroys the spare when the slot is cleared", async () => {
    const worker = fakeWorker();
    primePdfWorker(() => worker);
    await settle();

    clearPdfWorkerSpare();
    expect(worker.destroyed).toBe(true);
    expect(takePdfWorker()).toBeNull();
  });

  it("expires an unused warm spare after an idle window", () => {
    vi.useFakeTimers();
    const worker = fakeWorker();
    releaseUnusedPdfWorker(worker);

    vi.advanceTimersByTime(59_999);
    expect(takePdfWorker()).toBe(worker);
    releaseUnusedPdfWorker(worker);
    vi.advanceTimersByTime(60_000);
    expect(worker.destroyed).toBe(true);
    expect(takePdfWorker()).toBeNull();
  });
});
