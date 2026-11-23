import { initializeVaultStorage } from "./vaultStorage";
import { readBoundedText } from "./boundedText";
import { open } from "@tauri-apps/plugin-dialog";
import {
  readTextFile,
  readFile,
  stat,
  // plugin-dialog owns the plain `open` name above.
  open as openFsFile,
} from "@tauri-apps/plugin-fs";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { VaultFile } from "../types";
import { persistVerifiedBytes } from "./verifiedWrite";
import { isMesaWriteArtifactName, type FoundArtifact } from "./writeRecovery";
// Re-exported because `recoverWriteArtifacts` now takes a pre-discovered list:
// `store.ts` holds one between `scanVault` and the recovery call.
export type { FoundArtifact };
import { forEachConcurrent } from "./concurrency";
import { MAX_TEXT_CACHE_FILE_BYTES } from "./textCachePlan";
import { baseName, extOf, joinPath, parentDir, stripExt, toVaultFile } from "./vaultPaths";
import { DEMO, DEMO_ROOT, SPARK_SVG, demoFiles, demoRead, demoWrite } from "./vaultDemo";
import { IN_TAURI, VAULT_FS, ensureDir, isDemo, sha256Hex } from "./vaultFs";
export {
  IN_TAURI, VAULT_FS, authorizeWriteArtifacts, ensureDir, flushVaultFile, guardedRename, isDemo, nativeVaultWriteAtomic,
  safeExists, sha256Hex, uniqueRel,
} from "./vaultFs";
export { baseName, extOf, parentDir, stripExt, toVaultFile } from "./vaultPaths";
export { DEMO_ROOT } from "./vaultDemo";
export { importDroppedPaths, MAX_DROPPED_FILE_BYTES, type DroppedImportOptions, type DroppedImportResult } from "./vaultImport";
export { decodeWatchBatch, watchVault, WATCH_FALLBACK_MAX_WAIT_MS, type VaultWatchEvent } from "./vaultWatch";
export {
  listRecoveryEntries, purgeRecoveryEntry, recoverWriteArtifacts, removeFile, removeVaultEntry, restoreRecoveryEntry,
  type RecoveryEntry, type WriteRecoveryResult,
} from "./vaultRecovery";
export {
  clearSniffedText, documentKind, fileKind, flushableNoteText, isEditableTextExt, isImageExt, isOpenableTextFile, isSpreadsheetExt, isWordExt,
  isTextExt, isTextualVaultFile, looksLikeUtf8Text, moveSniffedText, needsCachedTextRefresh, needsTextSniff, rememberSniffedText,
  resolveTextVaultLink, TEXT_SNIFF_BYTES, type FileKind,
} from "./vaultFileKinds";
export { canonicalRoot, isLikelyRemoteVaultPath, normalizeVaultRelPath, stripVerbatimPrefix } from "./vaultPathNormalize";
export {
  hasVaultMetadata, isIndexableVaultRelPath, isWindowsShellName, loadVaultMetadata, MAX_VAULT_REL_SEGMENTS, SKIPPED_DIRS,
  WALK_BATCH,
} from "./vaultWalk";
export { decodePeekBytes, decodeTextChunkOutcomes, type TextReadOutcome } from "./vaultTextFrame";
import { isOpenableTextFile, looksLikeUtf8Text, TEXT_SNIFF_BYTES } from "./vaultFileKinds";
import { canonicalRoot, isLikelyRemoteVaultPath } from "./vaultPathNormalize";
import { loadVaultMetadata, walk } from "./vaultWalk";
import { decodePeekBytes, decodeTextChunkOutcomes, type TextReadOutcome } from "./vaultTextFrame";
import { readVaultBytes } from "./vaultByteRead";

// --- public API -----------------------------------------------------------

/** Prompt for a vault folder. In browser preview mode, returns the demo vault. */
export async function pickVault(): Promise<string | null> {
  if (!IN_TAURI) return DEMO_ROOT;
  const result = await open({
    directory: true,
    multiple: false,
    recursive: true,
    title: "Open vault folder",
  });
  if (typeof result === "string") return canonicalRoot(result);
  return null;
}

/** Restore Tauri filesystem and asset access only for a user-approved vault.
 * Resolves with a non-blocking local-storage warning, if any. */
export async function authorizeVaultRoot(root: string): Promise<string | null> {
  if (isDemo(root)) return null;
  await invoke("vault_authorize", { root });
  return initializeVaultStorage(root);
}

/** Require a reachable remembered directory; unavailable roots must not become empty vaults. */
export async function assertVaultRootAvailable(root: string): Promise<void> {
  if (isDemo(root)) return;
  let info;
  try {
    info = await stat(root);
  } catch (error) {
    throw new Error(`Vault folder is not reachable: ${String(error)}`);
  }
  // Some test/compatibility adapters return partial FileInfo objects. Only a
  // definite non-directory result is grounds to reject the selected root.
  if (info.isDirectory === false) {
    throw new Error("The selected vault path is not a folder.");
  }
}

/** Recursively list vault files. metadata:false defers per-file stats on the
 * fallback path; metadata is included by default. */
/** Map native rel/size/mtime/created fields through shared frontend helpers.
 * Return null when scanning is unavailable; propagate research-recovery failures. */
interface NativeScan {
  files: VaultFile[];
  /** Write artifacts found by the SAME walk — see `scanVault`. */
  artifacts: FoundArtifact[] | null;
}

async function scanVaultNative(root: string): Promise<NativeScan | null> {
  if (!IN_TAURI) return null;
  try {
    const result = await invoke<{
      entries: {
        rel: string;
        size: number;
        mtime: number | null;
        created?: number | null;
      }[];
      artifacts: { dir: string; name: string }[];
    }>("vault_scan", { root });
    // A shell running the previous command shape returns a bare array. Treat it
    // as a listing with no artifact information rather than crashing the open;
    // `scanVault` then leaves recovery to its own walk.
    const entries = Array.isArray(result) ? result : result?.entries;
    if (!Array.isArray(entries)) return null;
    // A bare array is the older command shape. It has no artifact knowledge,
    // so preserve null and let recovery run its safe compatibility walk.
    const artifacts = Array.isArray(result) ? null : result?.artifacts ?? null;
    const files = entries.map((e) => ({
      ...toVaultFile(root, e.rel),
      size: e.size,
      mtime: e.mtime ?? undefined,
      createdAt: e.created ?? undefined,
    }));
    return {
      files,
      // The Rust matcher is a deliberate SUPERSET (see `looks_like_write_artifact`
      // in `vaultscan.rs`), so re-filter through the authoritative predicate
      // here. `dir` arrives vault-relative and empty at the root; recovery
      // works in absolute paths.
      artifacts:
        artifacts
          ?.filter((a) => isMesaWriteArtifactName(a.name))
          .map((a) => ({
            dir: a.dir ? joinPath(root, a.dir) : root,
            name: a.name,
          })) ?? null,
    };
  } catch (error) {
    if (String(error).includes("Research recovery is pending")) throw error;
    // Command missing or walk failed — the readDir path below still works.
    return null;
  }
}

/** List vault files through one native scan, falling back to the plugin walk.
 * metadata:false suppresses per-file stats only on the fallback path.
 * onArtifacts receives discovered recovery artifacts, or null when discovery
 * is unavailable and recovery must perform its own walk. */
export async function scanVault(
  root: string,
  options: {
    metadata?: boolean;
    stopped?: () => boolean;
    onArtifacts?: (artifacts: FoundArtifact[] | null) => void;
  } = {}
): Promise<VaultFile[]> {
  if (isDemo(root)) {
    options.onArtifacts?.(null);
    return demoFiles();
  }
  const native = await scanVaultNative(root);
  if (native) {
    if (options.stopped?.()) return [];
    options.onArtifacts?.(native.artifacts);
    native.files.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return native.files;
  }
  options.onArtifacts?.(null);
  const out: VaultFile[] = [];
  await walk(root, root, out, options.stopped);
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  if (options.metadata !== false) await loadVaultMetadata(out, options.stopped);
  return out;
}

export interface ReadNoteResult {
  ok: boolean;
  text: string;
}

/** Read a text file while preserving the difference between failure and empty bytes. */
export async function readNoteResult(file: VaultFile): Promise<ReadNoteResult> {
  if (isDemo(file.path)) return { ok: true, text: demoRead(file.relPath) };
  try {
    return { ok: true, text: await readTextFile(file.path) };
  } catch {
    return { ok: false, text: "" };
  }
}

/** Complete, bounded UTF-8 text for conflict review; never falls back to an unbounded read. */
export async function readReviewText(file: VaultFile, maxBytes = 1024 * 1024): Promise<string> {
  if (!file.isMarkdown && file.ext !== "txt") throw new Error("Inline review supports Markdown and plain text.");
  if (isDemo(file.path)) {
    const text = demoRead(file.relPath);
    if (new TextEncoder().encode(text).length > maxBytes) throw new Error("File exceeds the inline review limit.");
    return text;
  }
  if (IN_TAURI) {
    return new TextDecoder("utf-8", { fatal: true }).decode(await readVaultBytes(file.path, maxBytes, true));
  }
  return readBoundedText(await openFsFile(file.path, { read: true }), maxBytes);
}

/** A replacement character may be authored UTF-8 or a lossy decode. Check the original bytes. */
export async function isValidUtf8Text(file: VaultFile, text: string): Promise<boolean> {
  if (!text.includes("\uFFFD") || isDemo(file.path)) return true;
  const bytes = IN_TAURI
    ? await readVaultBytes(file.path, MAX_TEXT_CACHE_FILE_BYTES, true)
    : await readFile(file.path);
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return true; }
  catch { return false; }
}

export async function readNote(file: VaultFile): Promise<string> {
  return (await readNoteResult(file)).text;
}

/** In-flight per-file reads when the native bulk command is unavailable. Only
 *  the fallback needs a bound; the native path's parallelism is chosen in Rust. */
const FALLBACK_READ_CONCURRENCY = 16;

/**
 * One-IPC bulk read via `vaultread.rs`, or null when unavailable — an older
 * shell, a non-Tauri host, or any failure at all. A whole-batch failure falls
 * back to per-file reads rather than losing the batch.
 */
async function readVaultTextNative(
  root: string,
  rels: readonly string[],
  workerLimit: number
): Promise<TextReadOutcome[] | null> {
  if (!IN_TAURI) return null;
  try {
    const args: Record<string, unknown> = {
      root,
      rels: rels as string[],
      maxTextFileBytes: MAX_TEXT_CACHE_FILE_BYTES,
    };
    if (workerLimit > 0) args.workerLimit = workerLimit;
    const body = await invoke<ArrayBuffer | Uint8Array | number[]>(
      "vault_read_text",
      args
    );
    // A failed digest only costs the index its reuse check, never the read.
    const digests = new Map<number, Promise<string | undefined>>();
    const texts = decodeTextChunkOutcomes(body, (index, raw) => digests.set(index, sha256Hex(raw).catch(() => undefined)));
    // A short frame would silently shift every file's text onto the wrong path.
    // Refusing it costs one fallback batch; trusting it corrupts the cache.
    if (texts.length !== rels.length) return null;
    await Promise.all([...digests].map(async ([index, digest]) => {
      const outcome = texts[index];
      const sha256 = await digest;
      if (outcome.kind === "content" && sha256) outcome.sha256 = sha256;
    }));
    return texts;
  } catch {
    return null;
  }
}

async function readSearchTextFallback(file: VaultFile): Promise<TextReadOutcome> {
  if (isDemo(file.path)) return { kind: "content", text: demoRead(file.relPath) };
  if (typeof file.size === "number") {
    if (file.size > MAX_TEXT_CACHE_FILE_BYTES) return { kind: "skipped" };
  } else if (IN_TAURI) {
    try {
      const info = await stat(file.path);
      if (typeof info.size === "number" && info.size > MAX_TEXT_CACHE_FILE_BYTES) {
        return { kind: "skipped" };
      }
    } catch {
      return { kind: "failed" };
    }
  }
  const result = await readNoteResult(file);
  return result.ok ? { kind: "content", text: result.text } : { kind: "failed" };
}

export async function readVaultTextOutcomes(
  root: string,
  files: readonly VaultFile[]
): Promise<TextReadOutcome[]> {
  if (!files.length) return [];
  if (!isDemo(root)) {
    const texts = await readVaultTextNative(
      root,
      files.map((f) => f.relPath),
      isLikelyRemoteVaultPath(root) ? 2 : 0
    );
    if (texts) return texts;
  }
  const out = new Array<TextReadOutcome>(files.length);
  await forEachConcurrent(files, FALLBACK_READ_CONCURRENCY, async (file, i) => {
    out[i] = await readSearchTextFallback(file);
  });
  return out;
}

/** Up to `maxBytes` from the start of a file; never reads the rest. */
async function readPrefixBytes(path: string, maxBytes: number): Promise<Uint8Array> {
  if (IN_TAURI) return readVaultBytes(path, maxBytes, false);
  const fh = await openFsFile(path, { read: true });
  try {
    const buf = new Uint8Array(maxBytes);
    let filled = 0;
    // read() may return fewer bytes than requested — loop until full or EOF.
    while (filled < maxBytes) {
      const n = await fh.read(buf.subarray(filled));
      if (n == null || n <= 0) break;
      filled += n;
    }
    return buf.subarray(0, filled);
  } finally {
    await fh.close();
  }
}

/** Bound hover reads when streaming is available; compatibility may read the whole file.
 * Peeks must never become editable save baselines. */
export async function peekNote(file: VaultFile, maxBytes = 16384): Promise<string> {
  if (isDemo(file.path)) return demoRead(file.relPath);
  try {
    return decodePeekBytes(await readPrefixBytes(file.path, maxBytes));
  } catch {
    return readNote(file);
  }
}

/** Open-time check of an unknown-extension file: a bounded prefix that is valid
 *  UTF-8 with no NUL byte is text. Throws when the prefix cannot be read. */
export async function sniffVaultText(file: VaultFile): Promise<boolean> {
  const bytes = isDemo(file.path)
    ? new TextEncoder().encode(demoRead(file.relPath))
    : await readPrefixBytes(file.path, TEXT_SNIFF_BYTES);
  return looksLikeUtf8Text(bytes.subarray(0, TEXT_SNIFF_BYTES), bytes.length < TEXT_SNIFF_BYTES);
}

/** Write text only for files accepted by isOpenableTextFile; binary formats use byte-oriented writes. */
export async function writeNote(
  file: VaultFile,
  content: string,
  expectedCurrentContent?: string
): Promise<void> {
  if (!isOpenableTextFile(file)) {
    throw new Error(
      `Refusing to write text over "${file.relPath}" — Mesa only edits text files as text, and writing this one would corrupt it.`
    );
  }
  if (isDemo(file.path)) {
    demoWrite(file.relPath, content);
    return;
  }
  const encoder = new TextEncoder();
  let prefix = "";
  if (IN_TAURI && expectedCurrentContent !== undefined) {
    const head = await readVaultBytes(file.path, 3, false);
    if (head.length === 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) prefix = "\uFEFF";
  }
  const encode = (text: string) => encoder.encode(prefix && !text.startsWith(prefix) ? prefix + text : text);
  await persistVerifiedBytes(file.path, encode(content), VAULT_FS, {
    expectedCurrentBytes: expectedCurrentContent === undefined ? undefined : encode(expectedCurrentContent),
  });
}

export async function createNote(
  root: string,
  relPath: string,
  content = "",
  expectedMissing = true
): Promise<VaultFile> {
  const full = joinPath(root, relPath);
  const name = baseName(relPath);
  const file: VaultFile = {
    path: full,
    relPath,
    name: stripExt(name),
    ext: extOf(name),
    isMarkdown: true,
  };
  if (isDemo(root)) {
    demoWrite(relPath, content);
  } else {
    await ensureDir(parentDir(full)); // create the folder (e.g. Daily/) if needed
    const bytes = new TextEncoder().encode(content);
    await persistVerifiedBytes(full, bytes, VAULT_FS, {
      expectedCurrentBytes: expectedMissing ? null : undefined,
    });
  }
  return file;
}

/** Create or replace a text file in the vault, preserving its real file type. */
export async function writeVaultTextFile(
  root: string,
  relPath: string,
  content = "",
  options: { expectedMissing?: boolean } = {}
): Promise<VaultFile> {
  const full = joinPath(root, relPath);
  if (isDemo(root)) {
    demoWrite(relPath, content);
  } else {
    await ensureDir(parentDir(full));
    const bytes = new TextEncoder().encode(content);
    await persistVerifiedBytes(full, bytes, VAULT_FS, {
      expectedCurrentBytes: options.expectedMissing ? null : undefined,
    });
  }
  return toVaultFile(root, relPath);
}

/** Create a binary vault file through the same verified-write path as PDFs. */
export async function writeVaultBinaryFile(
  root: string,
  relPath: string,
  bytes: Uint8Array,
  options: { expectedMissing?: boolean } = {}
): Promise<VaultFile> {
  const full = joinPath(root, relPath);
  if (isDemo(root)) {
    throw new Error("The browser demo cannot save binary files into its sample vault.");
  }
  await ensureDir(parentDir(full));
  await persistVerifiedBytes(full, bytes, VAULT_FS, {
    expectedCurrentBytes: options.expectedMissing ? null : undefined,
  });
  return toVaultFile(root, relPath);
}

/** Create an empty folder in the vault (recursive; demo vault is a no-op). */
export async function createFolder(root: string, relPath: string): Promise<void> {
  const clean = relPath.replace(/^\/+|\/+$/g, "");
  if (!clean || isDemo(root)) return;
  await ensureDir(joinPath(root, clean));
}

/** Duplicate any vault file (text or binary) to a new relPath. */
export async function copyVaultFile(
  root: string,
  srcRel: string,
  destRel: string
): Promise<VaultFile> {
  if (isDemo(root)) {
    demoWrite(destRel, DEMO[srcRel] ?? "");
    return toVaultFile(root, destRel);
  }
  const srcAbs = joinPath(root, srcRel);
  const destAbs = joinPath(root, destRel);
  await ensureDir(parentDir(destAbs));
  const bytes = await readFile(srcAbs);
  await persistVerifiedBytes(destAbs, bytes, VAULT_FS, {
    expectedCurrentBytes: null,
  });
  return toVaultFile(root, destRel);
}

/** Rename bytes without decoding. Native no-replace publication preserves a concurrently created destination. */
export async function renameVaultFile(
  root: string,
  srcRel: string,
  destRel: string
): Promise<VaultFile> {
  if (isDemo(root)) {
    if (!(srcRel in DEMO)) {
      throw new Error("Renaming demo assets is not supported in the browser demo.");
    }
    if (destRel in DEMO) throw new Error(`"${destRel}" already exists.`);
    demoWrite(destRel, DEMO[srcRel] ?? "");
    delete DEMO[srcRel];
    return toVaultFile(root, destRel);
  }
  const caseOnlyRename = srcRel !== destRel && srcRel.toLowerCase() === destRel.toLowerCase();
  if (!IN_TAURI) throw new Error("Safe vault rename requires the Mesa desktop app.");
  await invoke("vault_rename_no_replace", {
    root,
    fromRel: srcRel,
    toRel: destRel,
    caseOnly: caseOnlyRename,
  });
  return toVaultFile(root, destRel);
}
/** Resolve an absolute file path to a URL the webview can load (images, etc). */
export function urlForPath(absPath: string): string {
  if (isDemo(absPath)) return SPARK_SVG;
  return convertFileSrc(absPath);
}
