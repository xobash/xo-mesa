import { initializeVaultStorage } from "./vaultStorage";
import { readBoundedText } from "./boundedText";
import { open } from "@tauri-apps/plugin-dialog";
import {
  readDir,
  readTextFile,
  readFile,
  writeFile as pluginWriteFile,
  remove as pluginRemove,
  rename as pluginRename,
  mkdir as pluginMkdir,
  exists,
  stat,
  // plugin-dialog owns the plain `open` name above.
  open as openFsFile,
} from "@tauri-apps/plugin-fs";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { VaultFile } from "../types";
import { persistVerifiedBytes, type VerifiedWriteFs } from "./verifiedWrite";
import { isMesaWriteArtifactName, type FoundArtifact } from "./writeRecovery";
// Re-exported because `recoverWriteArtifacts` now takes a pre-discovered list:
// `store.ts` holds one between `scanVault` and the recovery call.
export type { FoundArtifact };
import { forEachConcurrent } from "./concurrency";
import { MAX_TEXT_CACHE_FILE_BYTES } from "./textCachePlan";
import { linkKey } from "./fsnames";
import { baseName, extOf, joinPath, parentDir, relBase, stripExt, toRel, toVaultFile } from "./vaultPaths";
import { DEMO, DEMO_ROOT, SPARK_SVG, demoFiles, demoRead, demoWrite } from "./vaultDemo";
export { baseName, extOf, parentDir, stripExt, toVaultFile } from "./vaultPaths";
export { DEMO_ROOT } from "./vaultDemo";
export { importDroppedPaths, MAX_DROPPED_FILE_BYTES, type DroppedImportOptions, type DroppedImportResult } from "./vaultImport";
export { decodeWatchBatch, watchVault, WATCH_FALLBACK_MAX_WAIT_MS, type VaultWatchEvent } from "./vaultWatch";
export {
  listRecoveryEntries, purgeRecoveryEntry, recoverWriteArtifacts, removeFile, removeVaultEntry, restoreRecoveryEntry,
  type RecoveryEntry, type WriteRecoveryResult,
} from "./vaultRecovery";

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
        sha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", expectedCurrentBytes.slice().buffer)))
          .map((byte) => byte.toString(16).padStart(2, "0")).join(""),
        size: expectedCurrentBytes.length,
      };
  // Bytes are the raw IPC body; a nested Uint8Array would be sent as a JSON
  // number array several times the file's size.
  const pathHex = Array.from(new TextEncoder().encode(path))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

/** Text-renderable files we can open in the editor/preview/code viewer. */
export function isTextExt(ext: string): boolean {
  return /^(md|markdown|txt|text|csv|tsv|json|jsonc|ya?ml|html?|xml|svg|css|scss|less|js|jsx|ts|tsx|mjs|cjs|log|toml|ini|conf|cfg|properties|env|sh|bash|zsh|bat|cmd|ps1|psm1|py|rb|go|rs|c|h|hpp|cc|cpp|java|kt|php|sql)$/i.test(
    ext
  );
}

/** Textual files that open in the editable note editor (vs. the read-only code
 *  viewer). Markdown and plain text are editable; code/data files are viewed. */
export function isEditableTextExt(ext: string): boolean {
  return /^(md|markdown|txt|text)$/i.test(ext);
}
/** Shared text-pipeline eligibility predicate. Binary editing uses byte-oriented persistence. */
export function isTextualVaultFile(file: {
  ext: string;
  isMarkdown?: boolean;
}): boolean {
  return !!file.isMarkdown || isTextExt(file.ext) || /^rtf$/i.test(file.ext);
}

/** Resolve a vault link to a real text file without making a new Markdown note.
 * Exact relative paths win. A bare name then prefers Markdown and falls back
 * to another editable text file, such as `.txt`. */
export function resolveTextVaultLink(
  files: readonly VaultFile[],
  target: string
): VaultFile | undefined {
  let normalized = target.split("|")[0]?.split("#")[0]?.trim().replace(/\\/g, "/") ?? "";
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Keep a malformed percent escape literal. It can still be a real name.
  }
  if (!normalized) return undefined;
  const lower = linkKey(normalized);
  const exact = files.find(
    (file) => isTextualVaultFile(file) && linkKey(file.relPath) === lower
  );
  if (exact) return exact;
  const base = relBase(lower);
  const matches = files.filter(
    (file) => isTextualVaultFile(file) && linkKey(file.name) === base
  );
  return matches.find((file) => file.isMarkdown) ?? matches[0];
}

/** Return cached text only for eligible text files; null means skip.
 * An absent cache entry is not an empty document, while a cached empty string is valid content. */
export function flushableNoteText(
  file: { ext: string; isMarkdown?: boolean },
  cachedContent: string | undefined
): string | null {
  if (cachedContent === undefined) return null;
  if (!isTextualVaultFile(file)) return null;
  return cachedContent;
}

/** Refresh text only for existing cache entries after an external modification. */
export function needsCachedTextRefresh(
  file: { ext: string; isMarkdown?: boolean },
  cachedContent: string | undefined
): boolean {
  if (cachedContent === undefined) return false;
  return isTextualVaultFile(file);
}

/** Image files we can display in a viewer. */
export function isImageExt(ext: string): boolean {
  return /^(png|jpe?g|gif|webp|bmp|avif|ico)$/i.test(ext);
}
/** How a file should be rendered in the main pane. */
export type FileKind =
  | "text"
  | "image"
  | "video"
  | "pdf"
  | "rtf"
  | "html"
  | "other";
export function fileKind(ext: string): FileKind {
  // html before the generic text check so it renders, not shows source
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "markdown" || isTextExt(ext)) return "text";
  if (isImageExt(ext) || ext === "svg") return "image";
  if (/^(mp4|webm|ogg|ogv|mov|m4v)$/i.test(ext)) return "video";
  if (ext === "pdf") return "pdf";
  if (ext === "rtf") return "rtf";
  return "other";
}

// --- path helpers (forward-slash normalized) ------------------------------

/** Windows reserved names and characters that only a verbatim path can reach. */
const VERBATIM_ONLY_SEGMENT_RE = /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\..*)?$|[<>:"|?*]|[. ]$/i;

/**
 * Drop a Windows verbatim prefix (`\\?\C:\…`, `\\?\UNC\srv\share\…`, either
 * slash) when the rest is an ordinary drive or UNC path. Native code applies
 * the same rule (`strip_verbatim_prefix` in `vaultscope.rs`). Other paths,
 * including every Unix path, are returned unchanged.
 */
export function stripVerbatimPrefix(p: string): string {
  const match = /^[\\/]{2}\?[\\/](?:([a-zA-Z]:)(?=[\\/]|$)|unc[\\/])/i.exec(p);
  if (!match) return p;
  // A drive match stops before its separator; a bare `\\?\C:` stays as is.
  if (match[1] && p.length === match[0].length) return p;
  const rest = p.slice(match[0].length + (match[1] ? 1 : 0)).split(/[\\/]/);
  if (rest.length && rest[rest.length - 1] === "") rest.pop();
  const required = match[1] ? 0 : 2;
  const ok =
    rest.length >= required &&
    rest.every((part) => part !== "" && part !== "." && part !== ".." && !VERBATIM_ONLY_SEGMENT_RE.test(part) && ![...part].some((ch) => ch.charCodeAt(0) < 0x20));
  if (!ok) return p;
  const sep = p[0];
  return match[1] ? p.slice(4) : `${sep}${sep}${p.slice(match[0].length)}`;
}

/** Canonical vault-root spelling for storage/comparison: forward slashes and normalized trailing separators. */
export function canonicalRoot(p: string): string {
  const trimmed = stripVerbatimPrefix(p.trim()).replace(/\\/g, "/");
  let slashed = trimmed.replace(/\/+$/, "");
  // A bare filesystem or drive root keeps its separator: `/` and `D:/`, never
  // "" or the drive-relative `D:`.
  if (!slashed && trimmed.startsWith("/")) slashed = "/";
  else if (/^[a-zA-Z]:$/.test(slashed)) slashed += "/";
  // Windows drive letters are case-insensitive; different entry points hand
  // back `c:/…` vs `C:/…` for the same folder. One canonical spelling keeps
  // the recents list and lastVault from storing duplicates.
  return slashed.replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`);
}

/**
 * Normalize an external path into a vault-relative path Mesa can match.
 *
 * Handles direct relative paths, `./` prefixes, `file://` URLs, and absolute
 * paths that end with one of the currently known vault-relative paths.
 * Returns `""` when the path cannot be mapped safely.
 */
export function normalizeVaultRelPath(
  rawPath: string,
  vaultRoot: string | null,
  knownRelPaths: string[] = []
): string {
  let raw = stripVerbatimPrefix(rawPath.trim()).replace(/\\/g, "/");
  if (!raw) return "";
  if (raw.startsWith("file://")) {
    try {
      const url = new URL(raw);
      const pathname = decodeURIComponent(url.pathname).replace(/\\/g, "/");
      // `file://server/share/x` (Windows UNC) keeps its host; a plain
      // `file:///…` does not.
      raw = url.hostname ? `//${url.hostname}${pathname}` : pathname;
    } catch {
      raw = raw.slice("file://".length).replace(/\\/g, "/");
    }
  }
  // Windows drive-letter file URLs decode to `/C:/…` — strip the URL slash so
  // the absolute path matches the vault root's `C:/…` spelling.
  raw = raw.replace(/^\/([a-zA-Z]:\/)/, "$1");
  const givenRoot = vaultRoot?.trim() ?? "";
  // `/` and `D:/` reduce to the prefixes "" and `D:`; the separator check below
  // still requires a segment boundary.
  const root = stripVerbatimPrefix(givenRoot).replace(/\\/g, "/").replace(/\/+$/, "");
  // Vault filesystems are case-insensitive on Windows and (by default) macOS,
  // and tools report the same file under different casings (`c:\…` vs `C:/…`).
  // Match prefixes case-insensitively but keep the reported casing in the rel.
  if (
    givenRoot &&
    raw.toLowerCase().startsWith(root.toLowerCase()) &&
    (raw.length === root.length || raw[root.length] === "/")
  ) {
    return raw.slice(root.length).replace(/^\/+/, "");
  }
  const rel = raw.replace(/^\.\/+/, "").replace(/^\/+/, "");
  if (!raw.startsWith("/") && !/^[a-zA-Z]:\//.test(raw)) return rel;
  if (!knownRelPaths.length) return "";
  // The first listed path that is a `/`-bounded suffix of the raw path.
  const index = suffixIndexFor(knownRelPaths);
  const rawLower = raw.toLowerCase();
  let best: { order: number; rel: string } | undefined;
  for (let i = rawLower.indexOf("/"); i >= 0; i = rawLower.indexOf("/", i + 1)) {
    const hit = index.get(rawLower.slice(i + 1));
    if (hit && (!best || hit.order < best.order)) best = hit;
  }
  return best?.rel ?? "";
}

/** Lowercased path → its first position in a known-path list, cached per list
 *  identity so a watcher batch does not rescan the whole catalogue per path. */
const suffixIndexes = new WeakMap<readonly string[], Map<string, { order: number; rel: string }>>();
function suffixIndexFor(knownRelPaths: readonly string[]): Map<string, { order: number; rel: string }> {
  let index = suffixIndexes.get(knownRelPaths);
  if (index) return index;
  index = new Map();
  knownRelPaths.forEach((candidate, order) => {
    const rel = candidate.replace(/\\/g, "/").replace(/^\/+/, "");
    const key = rel.toLowerCase();
    if (rel && !index!.has(key)) index!.set(key, { order, rel });
  });
  suffixIndexes.set(knownRelPaths, index);
  return index;
}
export function isDemo(pathOrRoot: string): boolean {
  return !IN_TAURI || pathOrRoot.startsWith(DEMO_ROOT);
}

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

/** Fill size/mtime/createdAt in place using bounded per-file stat requests.
 * Viewers subscribe to primitive metadata; graph timelapse uses creation time. */
export async function loadVaultMetadata(
  files: readonly VaultFile[],
  stopped?: () => boolean
): Promise<void> {
  try {
    await forEachConcurrent(files, 32, async (f) => {
      try {
        const s = await stat(f.path);
        f.size = s.size;
        f.mtime = s.mtime ? new Date(s.mtime).getTime() : undefined;
        f.createdAt = s.birthtime ? new Date(s.birthtime).getTime() : undefined;
      } catch {
        /* leave undefined */
      }
    }, stopped);
  } catch {
    /* stat unavailable — sorting by name/links still works */
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

/** Whether a listing already carries the `size`/`mtime` a stat pass would add. */
export function hasVaultMetadata(files: readonly VaultFile[]): boolean {
  return files.length > 0 && files.every((f) => f.size !== undefined);
}

/** Directory names `walk` never descends into. */
export const SKIPPED_DIRS = new Set(["node_modules", ".git"]);

/** Names Windows Explorer and the volume create for themselves. Every walk, the
 * index and sync skip them on every platform, ASCII case-insensitively. Keep in
 * parity with `is_windows_shell_artifact` in `src-tauri/src/platform_fs.rs`. */
const WINDOWS_SHELL_NAMES = new Set(["desktop.ini", "thumbs.db", "$recycle.bin", "system volume information"]);

export function isWindowsShellName(name: string): boolean {
  return WINDOWS_SHELL_NAMES.has(name.replace(/[A-Z]/g, (c) => c.toLowerCase()));
}

/** Shared scan/watch path filter. Exclude dot-prefixed path segments,
 * dependency directories and Windows shell files before registration or
 * fallback rescanning. */
export function isIndexableVaultRelPath(rel: string): boolean {
  if (!rel) return false;
  for (const seg of rel.split("/")) {
    if (!seg || seg.startsWith(".") || SKIPPED_DIRS.has(seg) || isWindowsShellName(seg)) return false;
  }
  return true;
}

/** List sibling directories in bounded level batches; final sorting makes traversal order irrelevant. */
export const WALK_BATCH = 16;

async function walk(
  dir: string,
  root: string,
  out: VaultFile[],
  stopped?: () => boolean
): Promise<void> {
  let level = [dir];
  while (level.length && !stopped?.()) {
    const next: string[] = [];
    for (let i = 0; i < level.length && !stopped?.(); i += WALK_BATCH) {
      await Promise.all(
        level.slice(i, i + WALK_BATCH).map(async (current) => {
          if (stopped?.()) return;
          let entries;
          try {
            entries = await readDir(current);
          } catch (error) {
            // Losing a child folder mid-scan should not hide the rest of a
            // vault. Losing the ROOT is different: returning [] here makes an
            // offline network drive look exactly like a valid empty vault.
            if (current === root) throw error;
            return;
          }
          for (const e of entries) {
            if (!e.name || e.name.startsWith(".") || isWindowsShellName(e.name)) continue;
            const full = joinPath(current, e.name);
            if (e.isDirectory) {
              if (SKIPPED_DIRS.has(e.name)) continue;
              next.push(full);
            } else if (e.isFile) {
              const ext = extOf(e.name);
              out.push({
                path: full,
                relPath: toRel(root, full),
                name: stripExt(e.name),
                ext,
                isMarkdown: ext === "md" || ext === "markdown",
              });
            }
          }
        })
      );
    }
    level = next;
  }
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
    const bytes = await invoke<ArrayBuffer>("vault_read_bytes", { path: file.path, maxBytes, requireComplete: true });
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  }
  return readBoundedText(await openFsFile(file.path, { read: true }), maxBytes);
}

/** A replacement character may be authored UTF-8 or a lossy decode. Check the original bytes. */
export async function isValidUtf8Text(file: VaultFile, text: string): Promise<boolean> {
  if (!text.includes("\uFFFD") || isDemo(file.path)) return true;
  const bytes = IN_TAURI
    ? new Uint8Array(await invoke<ArrayBuffer>("vault_read_bytes", { path: file.path, maxBytes: MAX_TEXT_CACHE_FILE_BYTES, requireComplete: true }))
    : await readFile(file.path);
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return true; }
  catch { return false; }
}

export async function readNote(file: VaultFile): Promise<string> {
  return (await readNoteResult(file)).text;
}

/** Use lower read concurrency for UNC and mounted-volume path hints without probing storage. */
export function isLikelyRemoteVaultPath(root: string): boolean {
  const normalized = root.replace(/\\/g, "/");
  return normalized.startsWith("//") || normalized.startsWith("/Volumes/");
}

/** Failure marker in the `vault_read_text` frame — see `vaultread.rs`. */
const TEXT_READ_FAILED = 0xffffffff;
const TEXT_READ_SKIPPED = 0xfffffffe;
/** Online-only cloud file (OneDrive Files On-Demand): background reads leave it
 *  in the cloud; opening the note downloads it through the ordinary read. */
const TEXT_READ_OFFLINE = 0xfffffffd;
export type TextReadOutcome =
  | { kind: "content"; text: string }
  | { kind: "skipped" }
  | { kind: "offline" }
  | { kind: "failed" };

/** In-flight per-file reads when the native bulk command is unavailable. Only
 *  the fallback needs a bound; the native path's parallelism is chosen in Rust. */
const FALLBACK_READ_CONCURRENCY = 16;

/** Decode ordered little-endian count/length frames; reserved lengths distinguish skips and failures.
 * Use nonfatal UTF-8 decoding consistently with plugin reads and retain outcome distinctions. */
export function decodeTextChunkOutcomes(
  /** Whatever `invoke` handed back. The custom-protocol IPC yields an
   *  `ArrayBuffer`, but Tauri silently falls back to `postMessage` if that
   *  protocol is ever blocked, and there a byte array arrives as a plain array
   *  of numbers. `plugin-fs`'s own readers handle both; so must this one, or a
   *  fallback shell would decode garbage instead of degrading. */
  body: ArrayBuffer | Uint8Array | number[]
): TextReadOutcome[] {
  const bytes =
    body instanceof ArrayBuffer
      ? new Uint8Array(body)
      : body instanceof Uint8Array
        ? body
        : Uint8Array.from(body);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  // Every read is bounds-checked rather than trusted. `subarray` CLAMPS out of
  // range instead of throwing, so a frame that was truncated in transit would
  // otherwise decode as quietly-shortened note text and be cached as the real
  // file. Throwing sends the batch down the per-file fallback instead.
  const need = (at: number, n: number) => {
    if (at + n > bytes.byteLength) throw new Error("truncated vault_read_text frame");
  };
  need(0, 4);
  const count = view.getUint32(0, true);
  const out: TextReadOutcome[] = [];
  let at = 4;
  for (let i = 0; i < count; i++) {
    need(at, 4);
    const len = view.getUint32(at, true);
    at += 4;
    if (len === TEXT_READ_FAILED) {
      out.push({ kind: "failed" });
      continue;
    }
    if (len === TEXT_READ_SKIPPED) {
      out.push({ kind: "skipped" });
      continue;
    }
    if (len === TEXT_READ_OFFLINE) {
      out.push({ kind: "offline" });
      continue;
    }
    need(at, len);
    out.push({ kind: "content", text: decoder.decode(bytes.subarray(at, at + len)) });
    at += len;
  }
  if (at !== bytes.byteLength) throw new Error("trailing vault_read_text bytes");
  return out;
}

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
    const texts = decodeTextChunkOutcomes(body);
    // A short frame would silently shift every file's text onto the wrong path.
    // Refusing it costs one fallback batch; trusting it corrupts the cache.
    if (texts.length !== rels.length) return null;
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

/** Decode a byte-capped peek to text, dropping any trailing partial UTF-8
 *  sequence (a cut multi-byte char decodes to U+FFFD at the very end). */
export function decodePeekBytes(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return text.replace(/�+$/, "");
}

/** Bound hover reads when streaming is available; compatibility may read the whole file.
 * Peeks must never become editable save baselines. */
export async function peekNote(file: VaultFile, maxBytes = 16384): Promise<string> {
  if (isDemo(file.path)) return demoRead(file.relPath);
  try {
    if (IN_TAURI) return decodePeekBytes(new Uint8Array(await invoke<ArrayBuffer>("vault_read_bytes", { path: file.path, maxBytes, requireComplete: false })));
    const fh = await openFsFile(file.path, { read: true });
    try {
      const buf = new Uint8Array(maxBytes);
      let filled = 0;
      // read() may return fewer bytes than requested — loop until full or EOF.
      while (filled < maxBytes) {
        const n = await fh.read(buf.subarray(filled));
        if (n == null || n <= 0) break;
        filled += n;
      }
      return decodePeekBytes(buf.subarray(0, filled));
    } finally {
      await fh.close();
    }
  } catch {
    return readNote(file);
  }
}

/** Write text only for files accepted by isTextualVaultFile; binary formats use byte-oriented writes. */
export async function writeNote(
  file: VaultFile,
  content: string,
  expectedCurrentContent?: string
): Promise<void> {
  if (!isTextualVaultFile(file)) {
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
    const head = new Uint8Array(await invoke<ArrayBuffer>("vault_read_bytes", {
      path: file.path, maxBytes: 3, requireComplete: false,
    }));
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
  await mkdir(joinPath(root, clean), { recursive: true });
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
export async function uniqueRel(root: string, rel: string): Promise<string> {
  let candidate = rel;
  let n = 1;
  while (await safeExists(joinPath(root, candidate))) {
    const slash = rel.lastIndexOf("/");
    const dot = rel.lastIndexOf(".");
    if (dot > slash) {
      candidate = `${rel.slice(0, dot)} (${n})${rel.slice(dot)}`;
    } else {
      candidate = `${rel} (${n})`;
    }
    n++;
  }
  return candidate;
}

/** Resolve an absolute file path to a URL the webview can load (images, etc). */
export function urlForPath(absPath: string): string {
  if (isDemo(absPath)) return SPARK_SVG;
  return convertFileSrc(absPath);
}
