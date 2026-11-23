import { createContext, useContext } from "react";
import { DocumentChangedOnDiskError, readDocumentBytes, saveDocumentBytes, type DocumentBytesSave } from "../lib/documentBytesSave";
import { pdfBytesEqual } from "../lib/pdfBytes";
import type { OfficeCryptoClient } from "../lib/officeCrypto/client";

// Where an Office editor reads and writes its package bytes. Plain files go
// straight to the vault; a password-protected file is decrypted on read and
// re-encrypted (and verified) on save, with the encrypted bytes on disk as
// the write precondition. Editors never see the encrypted form.

export interface OfficeByteSource {
  /** The package bytes (decrypted when protected). */
  read(path: string): Promise<Uint8Array>;
  /** Verified in-place save; `expected` is the package bytes the editor opened. */
  save(request: DocumentBytesSave): Promise<void>;
  /** Bytes to write for a new copy of the edited package (encrypted again when protected). */
  copyBytes(plain: Uint8Array): Promise<Uint8Array>;
  /** Set when the file opens for viewing only. */
  readonly readOnlyReason: string | null;
}

export const PLAIN_SOURCE: OfficeByteSource = {
  read: (path) => readDocumentBytes(path),
  save: (request) => saveDocumentBytes(request),
  copyBytes: async (plain) => plain,
  readOnlyReason: null,
};

export const OfficeByteSourceContext = createContext<OfficeByteSource>(PLAIN_SOURCE);

export function useOfficeByteSource(): OfficeByteSource {
  return useContext(OfficeByteSourceContext);
}

/** A plain source whose first read returns bytes already read by the gate. */
export function primedSource(path: string, bytes: Uint8Array): OfficeByteSource {
  let primed: Uint8Array | null = bytes;
  return {
    ...PLAIN_SOURCE,
    read: (p) => {
      if (primed && p === path) { const out = primed; primed = null; return Promise.resolve(out); }
      return readDocumentBytes(p);
    },
  };
}

export interface EncryptedSourceDeps {
  readDisk?: (path: string) => Promise<Uint8Array>;
  saveDisk?: (request: DocumentBytesSave) => Promise<void>;
}

/** Source for one unlocked file. `encrypted`/`plain` track the last version read or saved. */
export function encryptedSource(
  path: string, client: OfficeCryptoClient, opened: { encrypted: Uint8Array; plain: Uint8Array },
  readOnlyReason: string | null, deps: EncryptedSourceDeps = {},
): OfficeByteSource {
  const readDisk = deps.readDisk ?? readDocumentBytes;
  const saveDisk = deps.saveDisk ?? saveDocumentBytes;
  let current = opened;
  return {
    readOnlyReason,
    async read(p) {
      if (p !== path) throw new Error("This encrypted source belongs to another file.");
      const disk = await readDisk(path);
      if (pdfBytesEqual(disk, current.encrypted)) return current.plain;
      const plain = await client.reopen(disk);
      current = { encrypted: disk, plain };
      return plain;
    },
    async save({ path: p, bytes, expected, kind, validate }) {
      if (readOnlyReason) throw new Error(readOnlyReason);
      if (p !== path || !expected) throw new Error("A password-protected file saves only in place.");
      const base = current;
      if (!pdfBytesEqual(expected, base.plain)) {
        throw new DocumentChangedOnDiskError(`This ${kind} changed on disk after it was opened, so nothing was overwritten. Your edits are still here.`);
      }
      if (pdfBytesEqual(bytes, base.plain)) return; // nothing to write
      if (validate) await validate(bytes);
      const sealed = await client.seal(base.encrypted, bytes);
      await saveDisk({
        path, bytes: sealed, expected: base.encrypted, kind,
        validate: (candidate) => { if (!pdfBytesEqual(candidate, sealed)) throw new Error("The bytes to write are not the verified encrypted file."); },
      });
      current = { encrypted: sealed, plain: bytes };
    },
    async copyBytes(plain) {
      if (readOnlyReason) throw new Error(readOnlyReason);
      return client.seal(current.encrypted, plain);
    },
  };
}
