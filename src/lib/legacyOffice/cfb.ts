// Legacy Office view of a Compound File Binary ([MS-CFB]) container. The one
// bounded, non-recursive reader is `src/lib/cfb.ts`; this module only adds the
// legacy size cap and turns its errors into refusals fit to show the user.

import { CfbError, isCfb, readCfb } from "../cfb";
import { formatBytes } from "../formatBytes";

/** Largest legacy Office file Mesa parses (also the bounded range-read limit). */
export const LEGACY_OFFICE_MAX_BYTES = 64 * 1024 * 1024;

export type LegacyOfficeRefusal = "malformed" | "encrypted" | "unsupported" | "tooLarge";

/** A file Mesa refuses to read, with a message fit to show the user. */
export class LegacyOfficeError extends Error {
  constructor(readonly reason: LegacyOfficeRefusal, message: string) {
    super(message);
    this.name = "LegacyOfficeError";
  }
}

export function malformed(detail: string): never {
  throw new LegacyOfficeError("malformed", `This file is damaged or not a valid Office file: ${detail}`);
}

export interface CfbEntry {
  readonly name: string;
  readonly kind: "storage" | "stream";
}

export interface CompoundFile {
  /** Streams and storages directly under the root, by upper-case name. */
  readonly rootChildren: ReadonlyMap<string, CfbEntry>;
  /** Bytes of a root-level stream (name compared without case), or `null`. */
  stream(name: string): Uint8Array | null;
}


function guarded<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof CfbError) malformed(error.message.replace(/^The compound file /, "its container ").replace(/^A compound file /, "a container "));
    throw error;
  }
}

/** Opens a compound file. Throws `LegacyOfficeError` for anything malformed or too large. */
export function openCompoundFile(bytes: Uint8Array): CompoundFile {
  if (!isCfb(bytes)) malformed("it has no compound file header.");
  if (bytes.length > LEGACY_OFFICE_MAX_BYTES) {
    throw new LegacyOfficeError("tooLarge", `This file is larger than ${formatBytes(LEGACY_OFFICE_MAX_BYTES)}, the most Mesa reads from an older Office file.`);
  }
  const file = guarded(() => readCfb(bytes));
  const children = new Map<string, CfbEntry>();
  for (const { path } of file.streams) {
    const slash = path.indexOf("/");
    const name = slash < 0 ? path : path.slice(0, slash);
    const key = name.toUpperCase();
    if (!children.has(key)) children.set(key, { name, kind: slash < 0 ? "stream" : "storage" });
  }
  return {
    rootChildren: children,
    stream(name) {
      const entry = children.get(name.toUpperCase());
      return entry?.kind === "stream" ? guarded(() => file.read(entry.name)) : null;
    },
  };
}
