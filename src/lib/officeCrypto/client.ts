import {
  describeFailure, failureError, handleOfficeCryptoRequest,
  type OfficeCryptoFailure, type OfficeCryptoRequest, type OfficeCryptoState,
} from "./protocol";

export interface OfficeCryptoClient {
  /** Decrypts and, on success, holds the password for this file. Rejects with `WrongPasswordError` or `OfficeCryptoError`. */
  unlock(encrypted: Uint8Array, password: string): Promise<Uint8Array>;
  /** Decrypts newer bytes from disk with the held password. */
  reopen(encrypted: Uint8Array): Promise<Uint8Array>;
  /** Re-encrypts `plain` shaped like `template`, verified by decrypting it back. */
  seal(template: Uint8Array, plain: Uint8Array): Promise<Uint8Array>;
  /** Drops the password and stops the worker; pending requests reject. */
  dispose(): void;
}

type Pending = { resolve: (value: Uint8Array) => void; reject: (error: Error) => void };

/** One client per open file. Runs in a module worker, or in this thread when workers are unavailable (tests). */
export function createOfficeCryptoClient(): OfficeCryptoClient {
  let worker: Worker | null = null;
  let nextId = 0;
  let disposed = false;
  const pending = new Map<number, Pending>();
  const local: OfficeCryptoState = { password: null };

  const stop = (reason: string) => {
    worker?.terminate();
    worker = null;
    for (const job of pending.values()) job.reject(new Error(reason));
    pending.clear();
  };

  try {
    if (typeof Worker !== "undefined") {
      worker = new Worker(new URL("./officeCrypto.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<{ id: number; result?: Uint8Array | null; failure?: OfficeCryptoFailure }>) => {
        const job = pending.get(event.data.id);
        if (!job) return;
        pending.delete(event.data.id);
        if (event.data.failure) job.reject(failureError(event.data.failure));
        else job.resolve(event.data.result ?? new Uint8Array(0));
      };
      worker.onerror = () => stop("The decryption worker stopped.");
      worker.onmessageerror = () => stop("The decryption worker stopped.");
    }
  } catch {
    worker = null;
  }

  const run = (request: OfficeCryptoRequest): Promise<Uint8Array> => {
    if (disposed) return Promise.reject(new Error("This file was closed."));
    if (!worker) {
      return handleOfficeCryptoRequest(local, request).then(
        (result) => result ?? new Uint8Array(0),
        (error: unknown) => { throw failureError(describeFailure(error)); },
      );
    }
    const id = ++nextId;
    const active = worker;
    return new Promise<Uint8Array>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      active.postMessage({ id, request });
    });
  };

  return {
    unlock: (encrypted, password) => run({ op: "unlock", encrypted, password }),
    reopen: (encrypted) => run({ op: "reopen", encrypted }),
    seal: (template, plain) => run({ op: "seal", template, plain }),
    dispose() {
      if (disposed) return;
      disposed = true;
      local.password = null;
      stop("This file was closed.");
    },
  };
}
