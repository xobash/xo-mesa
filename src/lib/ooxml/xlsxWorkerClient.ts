import { assembleOoxmlPackage } from "./ooxmlPackage";
import { openXlsxPackage, type OpenedXlsx } from "./xlsxOpen";
import type { RowShiftJob, RowShiftResult } from "./xlsxRowShift";
import type { XlsxSavePlan } from "./xlsxSave";
import type { SheetIndex } from "./xlsxSheet";
import {
  describeFailure, failureError, handleXlsxRequest,
  type RowShiftData, type SheetIndexData, type XlsxOpenData, type XlsxWorkerFailure, type XlsxWorkerRequest, type XlsxWorkerState,
} from "./xlsxWorkerProtocol";

/** A worker that stays silent this long is stopped and the request fails. */
const REQUEST_TIMEOUT_MS = 120_000;

export interface XlsxWorkerClient {
  /** Opens bytes; the session already holds the first visible sheet's index. */
  open(bytes: Uint8Array): Promise<OpenedXlsx>;
  /** Indexes worksheet XML off the interface thread. */
  index(xml: string): Promise<SheetIndex>;
  /** Writes pending cells and moves rows off the interface thread. */
  shiftRows(job: RowShiftJob): Promise<RowShiftResult>;
  /** Writes and verifies a save against the bytes last opened. */
  write(plan: XlsxSavePlan): Promise<Uint8Array>;
  dispose(): void;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

function adoptOpen(bytes: Uint8Array, data: XlsxOpenData): OpenedXlsx {
  const pkg = assembleOoxmlPackage({ ...data.container, bytes }, new Map(data.parts));
  const opened = openXlsxPackage(pkg, data.report);
  if (data.firstIndex) {
    const { part, index } = data.firstIndex;
    opened.session.adoptIndex(part, { ...index, xml: opened.session.workbook.partText(part) });
  }
  return opened;
}

/** Fresh workers started after the first one dies; past this, saves ask for a reopen. */
export const MAX_WORKER_RESTARTS = 3;
export const WORKER_GONE_MESSAGE = "The spreadsheet worker stopped and could not be restarted. Close and reopen the file; unsaved edits in it are lost.";

type WorkerReplyMessage = MessageEvent<{ id: number; result?: unknown; failure?: XlsxWorkerFailure }>;

/**
 * Runs requests in a module worker, or in this thread only when workers are
 * unavailable (tests, old engines). A worker that crashes, fails a message or
 * times out is replaced on the next request, and the replacement re-opens the
 * last opened bytes first so saves still have the workbook. Restarts are
 * bounded; past the bound every request fails with WORKER_GONE_MESSAGE.
 */
export function createXlsxWorkerClient(): XlsxWorkerClient {
  let worker: Worker | null = null;
  let nextId = 0;
  let restarts = 0;
  let disposed = false;
  // The caller keeps these bytes as its save precondition, so holding the
  // reference costs no copy. A replacement worker re-opens them.
  let lastOpen: Uint8Array | null = null;
  // Requests that arrive while a replacement is re-opening share it.
  let restarting: Promise<Worker | null> | null = null;
  const pending = new Map<number, Pending>();
  const local: XlsxWorkerState = { container: null };

  const stop = (dead: Worker | null = worker) => {
    if (!dead || dead !== worker) return;
    dead.terminate();
    worker = null;
    for (const job of pending.values()) {
      clearTimeout(job.timer);
      job.reject(new Error("The spreadsheet worker stopped. Try again."));
    }
    pending.clear();
  };

  const start = (): Worker => {
    const next = new Worker(new URL("./xlsx.worker.ts", import.meta.url), { type: "module" });
    next.onmessage = (event: WorkerReplyMessage) => {
      const job = pending.get(event.data.id);
      if (!job) return;
      pending.delete(event.data.id);
      clearTimeout(job.timer);
      if (event.data.failure) job.reject(failureError(event.data.failure));
      else job.resolve(event.data.result);
    };
    next.onerror = () => stop(next);
    next.onmessageerror = () => stop(next);
    worker = next;
    return next;
  };

  let workersAvailable = typeof Worker !== "undefined";
  if (workersAvailable) {
    try {
      start();
    } catch {
      workersAvailable = false; // never had a worker: the in-thread path is the only one
    }
  }

  const post = <T>(target: Worker, request: XlsxWorkerRequest, transfer: Transferable[]): Promise<T> => {
    const id = ++nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => stop(target), REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        target.postMessage({ id, request }, { transfer });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  /** A live worker that holds the last opened workbook, or null when none can be had. */
  const restart = async (): Promise<Worker | null> => {
    if (disposed || restarts >= MAX_WORKER_RESTARTS) return null;
    restarts += 1;
    let next: Worker;
    try {
      next = start();
    } catch {
      return null;
    }
    if (!lastOpen) return next;
    const copy = lastOpen.slice();
    try {
      await post<XlsxOpenData>(next, { kind: "open", bytes: copy }, [copy.buffer]);
    } catch {
      return null;
    }
    return worker === next ? next : null;
  };

  const run = async <T>(request: XlsxWorkerRequest, transfer: Transferable[] = []): Promise<T> => {
    if (!workersAvailable) {
      try {
        return handleXlsxRequest(local, request).result as T;
      } catch (error) {
        throw failureError(describeFailure(error));
      }
    }
    // An open replaces the workbook, so a fresh worker needs no replay for it.
    if (!worker && request.kind === "open") lastOpen = null;
    if (!worker && !restarting) restarting = restart().finally(() => { restarting = null; });
    const target = worker && !restarting ? worker : await restarting;
    if (!target) throw new Error(WORKER_GONE_MESSAGE);
    return post<T>(target, request, transfer);
  };

  return {
    // The worker gets its own copy; the caller keeps `bytes` as the save precondition.
    open: async (bytes) => {
      const copy = bytes.slice();
      const data = await run<XlsxOpenData>({ kind: "open", bytes: copy }, [copy.buffer]);
      lastOpen = bytes;
      return adoptOpen(bytes, data);
    },
    index: async (xml) => ({ ...(await run<SheetIndexData>({ kind: "index", xml })), xml }),
    shiftRows: async ({ index, edits, row, delta }) => {
      const moved = await run<RowShiftData>({ kind: "shiftRows", job: { index, edits, row, delta } });
      return { index: { ...moved.index, xml: moved.xml }, hadFormulas: moved.hadFormulas };
    },
    write: (plan) => run<Uint8Array>({ kind: "write", plan }),
    dispose: () => {
      disposed = true;
      stop();
    },
  };
}
