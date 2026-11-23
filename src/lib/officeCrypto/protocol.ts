import { decryptOfficeFile, encryptOfficeFile, OfficeCryptoError, WrongPasswordError } from "./encryptedOffice";

// Requests for one open encrypted file. The password lives only in this
// state (the worker's, or the in-thread fallback's) and is dropped on
// `forget` or when the worker is terminated.

export type OfficeCryptoRequest =
  | { op: "unlock"; encrypted: Uint8Array; password: string }
  | { op: "reopen"; encrypted: Uint8Array }
  | { op: "seal"; template: Uint8Array; plain: Uint8Array }
  | { op: "forget" };

export interface OfficeCryptoState { password: string | null }

export interface OfficeCryptoFailure { kind: "wrongPassword" | "crypto" | "other"; message: string }

export function describeFailure(error: unknown): OfficeCryptoFailure {
  if (error instanceof WrongPasswordError) return { kind: "wrongPassword", message: error.message };
  if (error instanceof OfficeCryptoError) return { kind: "crypto", message: error.message };
  return { kind: "other", message: error instanceof Error ? error.message : String(error) };
}

export function failureError(failure: OfficeCryptoFailure): Error {
  if (failure.kind === "wrongPassword") return new WrongPasswordError();
  if (failure.kind === "crypto") return new OfficeCryptoError(failure.message);
  return new Error(failure.message);
}

function held(state: OfficeCryptoState): string {
  if (state.password === null) throw new OfficeCryptoError("The password is no longer held; open the file again.");
  return state.password;
}

/** Runs one request; returns the result bytes. */
export async function handleOfficeCryptoRequest(state: OfficeCryptoState, request: OfficeCryptoRequest): Promise<Uint8Array | null> {
  switch (request.op) {
    case "unlock": {
      const plain = await decryptOfficeFile(request.encrypted, request.password);
      state.password = request.password;
      return plain;
    }
    case "reopen":
      return decryptOfficeFile(request.encrypted, held(state));
    case "seal":
      return encryptOfficeFile(request.template, request.plain, held(state));
    case "forget":
      state.password = null;
      return null;
  }
}
