import type { PDFWorker } from "pdfjs-dist/legacy/build/pdf.mjs";

/** One warm pdf.js worker, published only after boot and before document use.
 * Taking it clears the slot. Used workers are never returned; each viewer owns
 * and destroys its worker. Inject the factory to keep pdf.js out of startup. */

/** At most one spare exists at a time, so the idle cost is bounded to a single
 *  worker thread — and only in a session where the user has already touched a
 *  PDF. Priming is never speculative on app start. */
let spare: PDFWorker | null = null;
let booting = false;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const SPARE_IDLE_MS = 60_000;

function isUsable(worker: PDFWorker | null): worker is PDFWorker {
  return !!worker && !worker.destroyed;
}

function clearIdleTimer(): void {
  if (!idleTimer) return;
  clearTimeout(idleTimer);
  idleTimer = null;
}

function armIdleTimer(): void {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    clearPdfWorkerSpare();
  }, SPARE_IDLE_MS);
}


export function primePdfWorker(create: () => PDFWorker): void {
  if (booting || isUsable(spare)) return;
  let worker: PDFWorker;
  try {
    worker = create();
  } catch {
    return;
  }
  const booted = worker.promise;
  if (!booted) {
    // Nothing to wait on means nothing safe to publish. Pre-warming must never
    // be the reason an open fails, so drop it and let the viewer build its own.
    try {
      worker.destroy();
    } catch {
      // Nothing to clean up.
    }
    return;
  }
  booting = true;
  void booted.then(
    () => {
      booting = false;
      // Publish only a worker that finished booting, so a viewer can never
      // adopt one that failed on the way up and would fail its first parse.
      if (isUsable(spare)) {
        worker.destroy();
        return;
      }
      spare = worker;
      armIdleTimer();
    },
    () => {
      booting = false;
      try {
        worker.destroy();
      } catch {
        // Already torn down by the failure itself.
      }
    }
  );
}

/** Transfer exclusive ownership of the spare and clear the slot before returning it. */
export function takePdfWorker(): PDFWorker | null {
  clearIdleTimer();
  const worker = spare;
  spare = null;
  return isUsable(worker) ? worker : null;
}

/** Return only a worker that has never received a document. */
export function releaseUnusedPdfWorker(worker: PDFWorker): void {
  if (!isUsable(worker)) return;
  if (isUsable(spare)) {
    // Keeping only one spare is what bounds the idle cost to a single thread.
    worker.destroy();
    return;
  }
  spare = worker;
  armIdleTimer();
}

/** Drop the spare without handing it out — for teardown paths and tests. */
export function clearPdfWorkerSpare(): void {
  clearIdleTimer();
  const worker = spare;
  spare = null;
  if (isUsable(worker)) worker.destroy();
}
