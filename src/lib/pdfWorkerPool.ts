import type { PDFWorker } from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * One warm, never-used pdf.js worker, booted before a PDF open needs it.
 *
 * Booting a worker means fetching and compiling ~1.4 MB of JavaScript on a new
 * thread. Measured on the open path: 145 ms the first time in a session and
 * ~46 ms afterwards (the script is cached, the compile is not). That cost used
 * to land in the middle of every open, because the viewer created its worker
 * only once the file's bytes had already been read — 51% of the 286 ms it took
 * to show page 1 of an 11 kB document.
 *
 * The safety argument for handing a worker to a viewer that did not create it
 * rests entirely on the spare being VIRGIN: it is constructed here and nothing
 * ever gives it a document, so adopting one is exactly equivalent to
 * constructing one, just earlier. That is why a used worker is never returned
 * here for recycling — `usePdfEditor` still destroys its own worker on unmount,
 * and a fresh spare is booted for the next open instead. A document that wedges
 * its worker therefore still cannot wedge any other viewer's PDF, which is the
 * property the PDF viewer contract requires.
 *
 * The module deliberately holds no static reference to pdfjs: callers pass a
 * factory. `pdfThumb.ts` is always bundled, so importing the engine here would
 * drag pdf.js into the entry chunk.
 */

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

/**
 * Boot a spare worker if there is not already one ready or on the way.
 *
 * Safe to call repeatedly and from any predictor of an imminent open (hovering
 * a PDF, leaving a viewer). Never throws: failing to pre-warm must be
 * indistinguishable from not having pre-warmed.
 */
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

/**
 * Take exclusive ownership of the warm spare, if one is ready.
 *
 * The slot is cleared before the worker is handed back, so two callers can
 * never end up holding the same worker. The caller owns it outright from here
 * and is responsible for destroying it.
 */
export function takePdfWorker(): PDFWorker | null {
  clearIdleTimer();
  const worker = spare;
  spare = null;
  return isUsable(worker) ? worker : null;
}

/**
 * Give back a worker that was taken but never handed a document.
 *
 * A viewer that mounts and unmounts without parsing anything — rapid tab
 * switching, React's development double-mount — would otherwise destroy a fully
 * booted worker and make the next open pay for a new one. Such a worker is
 * still virgin, so the argument for reusing it is the same one that makes the
 * spare safe. Callers MUST NOT pass a worker that has been given a document.
 */
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
