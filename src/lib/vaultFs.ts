import {
  readFile,
  writeFile as pluginWriteFile,
  remove as pluginRemove,
  rename as pluginRename,
  mkdir as pluginMkdir,
  exists,
} from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import type { VerifiedWriteFs } from "./verifiedWrite";
import { bytesToHex } from "./hex";
import { splitRelPath } from "./fsnames";
import { joinPath } from "./vaultPaths";
import { DEMO_ROOT } from "./vaultDemo";

/** Leaf module for the guarded vault filesystem: `vault.ts` and the split
 *  vault modules (import, recovery, watch) share it without an import cycle.
 *  `vault.ts` re-exports every name. */
/** Are we running inside the Tauri shell (vs. a plain browser preview)? */
export const IN_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const writeFile: typeof pluginWriteFile = async (path, data, options) => {
  if (IN_TAURI) throw new Error("Direct vault writes are disabled; use a verified save.");
  return pluginWriteFile(path, data, options);
};
const remove: typeof pluginRemove = async (path, options) => {
  if (IN_TAURI) throw new Error("Direct removal is disabled; use native recovery.");
  return pluginRemove(path, options);
};
const rename: typeof pluginRename = async (from, to, options) => {
  if (IN_TAURI) throw new Error("Direct moves are disabled; use native recovery.");
  return pluginRename(from, to, options);
};
const mkdir: typeof pluginMkdir = async (path, options) => {
  if (IN_TAURI) return invoke("vault_create_directory", { path });
  return pluginMkdir(path, options);
};

/** The native command owns the whole verified transaction. The plugin-fs
 *  callbacks remain for browser and compatibility paths. */
export const VAULT_FS: VerifiedWriteFs = {
  readFile, writeFile, remove, exists, rename,
  authorizeArtifacts: authorizeWriteArtifacts,
  flush: flushVaultFile,
  atomicWrite: IN_TAURI ? nativeVaultWriteAtomic : undefined,
};

/** Lowercase hex SHA-256 of exactly these bytes. WebCrypto copies the view's
 *  bytes when called, so a caller may release or reuse the buffer afterwards. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const data = bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : bytes.slice();
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

/** Hash an expected disk baseline without sending a second large file over IPC. */
export async function nativeVaultWriteAtomic(
  path: string,
  data: Uint8Array,
  expectedCurrentBytes?: Uint8Array | null
): Promise<void> {
  if (expectedCurrentBytes === undefined) {
    expectedCurrentBytes = await exists(path) ? await readFile(path) : null;
  }
  const expected = expectedCurrentBytes === null
    ? { kind: "missing" }
    : {
        kind: "hash",
        sha256: await sha256Hex(expectedCurrentBytes),
        size: expectedCurrentBytes.length,
      };
  // Bytes are the raw IPC body; a nested Uint8Array would be sent as a JSON
  // number array several times the file's size.
  const pathHex = bytesToHex(new TextEncoder().encode(path));
  await invoke("vault_write_atomic", data, {
    headers: { "x-mesa-path": pathHex, "x-mesa-expected": JSON.stringify(expected) },
  });
}

/** Guarded primitives for the split vault modules (import, recovery). */
export { rename as guardedRename };

/** Flush one approved vault file and its parent after verified staging or commit. */
export async function flushVaultFile(path: string): Promise<void> {
  if (IN_TAURI) await invoke("vault_flush_file", { path });
}

/** Grant only generated, dot-prefixed write artifacts inside an approved vault. */
export async function authorizeWriteArtifacts(paths: string[]): Promise<void> {
  if (!IN_TAURI || paths.length === 0) return;
  await invoke("vault_authorize_artifacts", { paths });
}

export function isDemo(pathOrRoot: string): boolean {
  return !IN_TAURI || pathOrRoot.startsWith(DEMO_ROOT);
}

export async function ensureDir(absDir: string): Promise<void> {
  await mkdir(absDir, { recursive: true });
}
export async function safeExists(abs: string): Promise<boolean> {
  try {
    return await exists(abs);
  } catch {
    return false;
  }
}
/** Most " (n)" suffixes `uniqueRel` probes before giving up; each probe is one IPC call. */
const UNIQUE_REL_TRIES = 10_000;

/** `rel` if free, else the first free "base (n).ext" in the same folder. A
 *  dot-leading name such as `.env` has no extension. */
export async function uniqueRel(root: string, rel: string): Promise<string> {
  if (!(await safeExists(joinPath(root, rel)))) return rel;
  const { dir, base, ext } = splitRelPath(rel);
  for (let n = 1; n <= UNIQUE_REL_TRIES; n++) {
    const candidate = `${dir}${base} (${n})${ext ? `.${ext}` : ""}`;
    if (!(await safeExists(joinPath(root, candidate)))) return candidate;
  }
  throw new Error(`No free name for ${rel} after ${UNIQUE_REL_TRIES} tries`);
}

