import { readFile, stat } from "@tauri-apps/plugin-fs";
import type { VaultFile } from "../types";
import { bytesEqual, persistVerifiedBytes } from "./verifiedWrite";
import { safeBaseName } from "./fsnames";
import { IN_TAURI, VAULT_FS, ensureDir, isDemo, isIndexableVaultRelPath, safeExists, uniqueRel } from "./vault";
import { baseName, extOf, joinPath, parentDir, toVaultFile } from "./vaultPaths";

// Drag-and-drop import into the vault through verified, missing-target writes.
const TEXT_EXT = /\.(md|markdown|txt|csv|json|ya?ml|html?|xml|css|js|ts|tsv|log)$/i;

interface DroppedImportFailure {
  /** Basename only: enough to identify the source without exposing its path. */
  name: string;
  message: string;
}

export interface DroppedImportResult {
  created: VaultFile[];
  failures: DroppedImportFailure[];
  /** The user stopped the operation; `created` is the durable partial result. */
  cancelled: boolean;
}

/** Largest single non-ZIP file a drag-and-drop import reads into memory. */
export const MAX_DROPPED_FILE_BYTES = 512 * 1024 * 1024;

/** Optional foreground controls for a long drag-and-drop import. */
export interface DroppedImportOptions {
  signal?: AbortSignal;
  onProgress?: (progress: { completedSources: number; totalSources: number; current: string }) => void;
}

function throwIfImportAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Import cancelled.", "AbortError");
}

/** Convert an already-safe ZIP relative path into a cross-platform vault path. */
function safeImportedRel(rel: string): string {
  const parts = rel.replace(/\\/g, "/").split("/").filter(Boolean).map(safeBaseName);
  if (!parts.length || parts.some((part) => !part)) {
    throw new Error(`ZIP entry cannot be represented safely on Windows: ${rel}.`);
  }
  return parts.join("/");
}

/**
 * Import OS-dropped file paths into the vault: text/markdown to the root,
 * images & other binaries to `attachments/`, and `.zip` archives extracted
 * into a folder. Returns every created file and every rejected source so a
 * partial import is never reported as a complete success. No-op in the demo.
 */
export async function importDroppedPaths(
  root: string,
  paths: string[],
  options: DroppedImportOptions = {}
): Promise<DroppedImportResult> {
  if (!IN_TAURI || isDemo(root)) return { created: [], failures: [], cancelled: false };
  const created: VaultFile[] = [];
  const failures: DroppedImportFailure[] = [];
  for (let index = 0; index < paths.length; index++) {
    if (options.signal?.aborted) return { created, failures, cancelled: true };
    const p = paths[index];
    const norm = p.replace(/\\/g, "/");
    const base = baseName(norm);
    const ext = extOf(base);
    options.onProgress?.({ completedSources: index, totalSources: paths.length, current: base });
    try {
      if (ext === "zip") {
        await importZip(root, norm, base, created, options.signal);
      } else {
        const destRel = TEXT_EXT.test(base) ? base : `attachments/${base}`;
        if (!isIndexableVaultRelPath(destRel)) {
          throw new Error(`Hidden file names are not imported: ${base}.`);
        }
        // Check the size before reading: the whole file is held in memory.
        const metadata = await stat(norm);
        if (metadata.size > MAX_DROPPED_FILE_BYTES) {
          throw new Error(`${base} exceeds the ${MAX_DROPPED_FILE_BYTES / 1024 / 1024} MB import limit.`);
        }
        const data = await readFile(norm);
        throwIfImportAborted(options.signal);
        await placeFile(root, destRel, data, created);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return { created, failures, cancelled: true };
      }
      failures.push({ name: base, message: String(error) });
    }
    options.onProgress?.({ completedSources: index + 1, totalSources: paths.length, current: base });
  }
  return { created, failures, cancelled: false };
}

/**
 * Write `data` to `destRel`, but never create spam duplicates: if a file with
 * the same path and identical bytes already exists, reuse it (so re-dropping
 * the same file just re-opens it). A same-name file with different content gets
 * a unique name so both are kept.
 */
async function placeFile(
  root: string,
  destRel: string,
  data: Uint8Array,
  created: VaultFile[]
): Promise<void> {
  const full = joinPath(root, destRel);
  if (await safeExists(full)) {
    const existing = await readFile(full).catch(() => null);
    if (existing && bytesEqual(existing, data)) {
      created.push(toVaultFile(root, destRel)); // identical — reuse, no copy
      return;
    }
    const rel = await uniqueRel(root, destRel); // different content, keep both
    await ensureDir(parentDir(joinPath(root, rel)));
    await persistVerifiedBytes(joinPath(root, rel), data, VAULT_FS, {
      expectedCurrentBytes: null,
    });
    created.push(toVaultFile(root, rel));
    return;
  }
  await ensureDir(parentDir(full));
  await persistVerifiedBytes(full, data, VAULT_FS, {
    expectedCurrentBytes: null,
  });
  created.push(toVaultFile(root, destRel));
}

async function importZip(
  root: string,
  srcPath: string,
  base: string,
  created: VaultFile[],
  signal?: AbortSignal,
): Promise<void> {
  const { inspectZipForImport, unzipForImport, ZIP_IMPORT_LIMITS } = await import("./zipCodec");
  const archiveMetadata = await stat(srcPath);
  if (archiveMetadata.size > ZIP_IMPORT_LIMITS.maxArchiveBytes) {
    throw new Error(`ZIP archive exceeds the ${ZIP_IMPORT_LIMITS.maxArchiveBytes / 1024 / 1024} MB import limit.`);
  }
  const data = await readFile(srcPath);
  const folder = base.replace(/\.zip$/i, "");
  const targetFolder = safeBaseName(folder);
  if (!targetFolder) throw new Error(`ZIP archive name cannot be represented safely on Windows: ${base}.`);
  const planned = inspectZipForImport(data);
  const entries = await unzipForImport(data, signal);
  for (const { name, expandedBytes } of planned) {
    throwIfImportAborted(signal);
    if (name.endsWith("/")) continue; // directory entry
    if (name.toLowerCase().startsWith("__macosx/")) continue; // macOS zip cruft
    const rel = safeImportedRel(name);
    // Hidden entries (.DS_Store, Mesa write artifacts) would be invisible and
    // could enter the recovery sweep.
    if (!isIndexableVaultRelPath(rel)) continue;
    const entry = entries[name];
    // Metadata validation is a budget promise; hold the decoder to it before a
    // verified write in case an invalid archive lied about its central directory.
    if (!entry || entry.byteLength !== expandedBytes) {
      throw new Error(`ZIP entry ${name} did not match its verified metadata.`);
    }
    await placeFile(root, `${targetFolder}/${rel}`, entry, created);
  }
}
