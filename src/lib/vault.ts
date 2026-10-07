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
  watch,
  // plugin-dialog owns the plain `open` name above.
  open as openFsFile,
} from "@tauri-apps/plugin-fs";
import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { VaultFile } from "../types";
import {
  persistVerifiedBytes,
  bytesEqual,
  parseWriteArtifactName,
  type VerifiedWriteFs,
} from "./verifiedWrite";
import {
  isMesaWriteArtifactName,
  planWriteRecovery,
  type FoundArtifact,
} from "./writeRecovery";
// Re-exported because `recoverWriteArtifacts` now takes a pre-discovered list:
// `store.ts` holds one between `scanVault` and the recovery call.
export type { FoundArtifact };
import { forEachConcurrent } from "./concurrency";
import { MAX_TEXT_CACHE_FILE_BYTES } from "./textCachePlan";
import { safeBaseName } from "./fsnames";

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
const VAULT_FS: VerifiedWriteFs = {
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
  const expected = expectedCurrentBytes === undefined
    ? { kind: "any" }
    : expectedCurrentBytes === null
      ? { kind: "missing" }
      : {
          kind: "hash",
          sha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", expectedCurrentBytes.slice().buffer)))
            .map((byte) => byte.toString(16).padStart(2, "0")).join(""),
          size: expectedCurrentBytes.length,
        };
  await invoke("vault_write_atomic", { path, data, expected });
}



export const DEMO_ROOT = "mesa://demo";

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
  const lower = normalized.toLowerCase();
  const exact = files.find(
    (file) => isTextualVaultFile(file) && file.relPath.toLowerCase() === lower
  );
  if (exact) return exact;
  const base = lower.split("/").pop() ?? lower;
  const matches = files.filter(
    (file) => isTextualVaultFile(file) && file.name.toLowerCase() === base
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

/** Canonical vault-root spelling for storage/comparison: forward slashes and normalized trailing separators. */
export function canonicalRoot(p: string): string {
  const slashed = p.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  // Windows drive letters are case-insensitive; different entry points hand
  // back `c:/…` vs `C:/…` for the same folder. One canonical spelling keeps
  // the recents list and lastVault from storing duplicates.
  return slashed.replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`);
}

function joinPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, "")}/${name}`;
}
function toRel(root: string, full: string): string {
  const r = root.replace(/[\\/]+$/, "");
  const rel = full.startsWith(r) ? full.slice(r.length) : full;
  return rel.replace(/^[\\/]+/, "").replace(/\\/g, "/");
}
function baseName(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
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
  let raw = rawPath.trim().replace(/\\/g, "/");
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
  const root = vaultRoot?.trim().replace(/\\/g, "/").replace(/\/+$/, "") ?? "";
  // Vault filesystems are case-insensitive on Windows and (by default) macOS,
  // and tools report the same file under different casings (`c:\…` vs `C:/…`).
  // Match prefixes case-insensitively but keep the reported casing in the rel.
  if (
    root &&
    raw.toLowerCase().startsWith(root.toLowerCase()) &&
    (raw.length === root.length || raw[root.length] === "/")
  ) {
    return raw.slice(root.length).replace(/^\/+/, "");
  }
  const rel = raw.replace(/^\.\/+/, "").replace(/^\/+/, "");
  if (!raw.startsWith("/") && !/^[a-zA-Z]:\//.test(raw)) return rel;
  const rawLower = raw.toLowerCase();
  for (const candidate of knownRelPaths) {
    const relCandidate = candidate.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!relCandidate) continue;
    if (rawLower.endsWith(`/${relCandidate.toLowerCase()}`)) {
      return relCandidate;
    }
  }
  return "";
}
export function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}
export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}
function isDemo(pathOrRoot: string): boolean {
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

/** Restore Tauri filesystem and asset access only for a user-approved vault. */
export async function authorizeVaultRoot(root: string): Promise<void> {
  if (isDemo(root)) return;
  await invoke("vault_authorize", { root });
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
    const files = entries.map((e) => {
      const base = baseName(e.rel);
      const ext = extOf(base);
      return {
        path: joinPath(root, e.rel),
        relPath: e.rel,
        name: stripExt(base),
        ext,
        isMarkdown: ext === "md" || ext === "markdown",
        size: e.size,
        mtime: e.mtime ?? undefined,
        createdAt: e.created ?? undefined,
      };
    });
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
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);

/** Shared scan/watch path filter. Exclude dot-prefixed path segments and
 * dependency directories before registration or fallback rescanning. */
export function isIndexableVaultRelPath(rel: string): boolean {
  if (!rel) return false;
  for (const seg of rel.split("/")) {
    if (!seg || seg.startsWith(".") || SKIPPED_DIRS.has(seg)) return false;
  }
  return true;
}

/** List sibling directories in bounded level batches; final sorting makes traversal order irrelevant. */
const WALK_BATCH = 16;

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
            if (!e.name || e.name.startsWith(".")) continue;
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
    const bytes = await invoke<number[]>("vault_read_bytes", { path: file.path, maxBytes, requireComplete: true });
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  }
  return readBoundedText(await openFsFile(file.path, { read: true }), maxBytes);
}

export async function readNote(file: VaultFile): Promise<string> {
  return (await readNoteResult(file)).text;
}

/** Maximum paths per native text-read response, bounding decode and progress batches. */
export const VAULT_TEXT_CHUNK = 128;

/** Use lower read concurrency for UNC and mounted-volume path hints without probing storage. */
export function isLikelyRemoteVaultPath(root: string): boolean {
  const normalized = root.replace(/\\/g, "/");
  return normalized.startsWith("//") || normalized.startsWith("/Volumes/");
}

/** Number of native bulk read batches allowed to overlap. */
export function vaultTextChunkConcurrency(root: string): number {
  return isLikelyRemoteVaultPath(root) ? 1 : 3;
}

/** Failure marker in the `vault_read_text` frame — see `vaultread.rs`. */
const TEXT_READ_FAILED = 0xffffffff;
const TEXT_READ_SKIPPED = 0xfffffffe;
export type TextReadOutcome = { kind: "content"; text: string } | { kind: "skipped" } | { kind: "failed" };

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
    need(at, len);
    out.push({ kind: "content", text: decoder.decode(bytes.subarray(at, at + len)) });
    at += len;
  }
  if (at !== bytes.byteLength) throw new Error("trailing vault_read_text bytes");
  return out;
}

/** Compatibility view for search-only callers. Neither unavailable outcome is content. */
export function decodeTextChunk(body: ArrayBuffer | Uint8Array | number[]): (string | null)[] {
  return decodeTextChunkOutcomes(body).map(result => result.kind === "content" ? result.text : null);
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

export async function readVaultTextOptional(root: string, files: readonly VaultFile[]): Promise<(string | null)[]> {
  return (await readVaultTextOutcomes(root, files)).map(result => result.kind === "content" ? result.text : null);
}

/** Read files in request order. Null means no authoritative read, never an editable empty document. */
export async function readVaultText(
  root: string,
  files: readonly VaultFile[]
): Promise<(string | null)[]> {
  return readVaultTextOptional(root, files);
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
    if (IN_TAURI) return decodePeekBytes(Uint8Array.from(await invoke<number[]>("vault_read_bytes", { path: file.path, maxBytes, requireComplete: false })));
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
  const bytes = new TextEncoder().encode(content);
  await persistVerifiedBytes(file.path, bytes, VAULT_FS, {
    expectedCurrentBytes:
      expectedCurrentContent === undefined
        ? undefined
        : new TextEncoder().encode(expectedCurrentContent),
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

// --- drag-and-drop import -------------------------------------------------
const TEXT_EXT = /\.(md|markdown|txt|csv|json|ya?ml|html?|xml|css|js|ts|tsv|log)$/i;

function toVaultFile(root: string, rel: string): VaultFile {
  const base = baseName(rel);
  const ext = extOf(base);
  return {
    path: joinPath(root, rel),
    relPath: rel,
    name: stripExt(base),
    ext,
    isMarkdown: ext === "md" || ext === "markdown",
  };
}
function parentDir(abs: string): string {
  const i = abs.lastIndexOf("/");
  return i >= 0 ? abs.slice(0, i) : abs;
}
async function ensureDir(absDir: string): Promise<void> {
  await mkdir(absDir, { recursive: true });
}
async function safeExists(abs: string): Promise<boolean> {
  try {
    return await exists(abs);
  } catch {
    return false;
  }
}
async function uniqueRel(root: string, rel: string): Promise<string> {
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

export interface RecoveryEntry {
  trashRelPath: string;
  originalRelPath: string;
  name: string;
  isDirectory: boolean;
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
    const base = norm.split("/").pop() || norm;
    const ext = extOf(base);
    options.onProgress?.({ completedSources: index, totalSources: paths.length, current: base });
    try {
      if (ext === "zip") {
        await importZip(root, norm, base, created, options.signal);
      } else {
        const data = await readFile(norm);
        throwIfImportAborted(options.signal);
        const destRel = TEXT_EXT.test(base) ? base : `attachments/${base}`;
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
    const entry = entries[name];
    // Metadata validation is a budget promise; hold the decoder to it before a
    // verified write in case an invalid archive lied about its central directory.
    if (!entry || entry.byteLength !== expandedBytes) {
      throw new Error(`ZIP entry ${name} did not match its verified metadata.`);
    }
    await placeFile(root, `${targetFolder}/${safeImportedRel(name)}`, entry, created);
  }
}

/** A file change observed by the filesystem watcher. */
export interface VaultWatchEvent {
  /** Absolute paths affected by the change. */
  paths: string[];
  /** Coarse kind: "create" (file or folder appeared), "modify" (data/metadata
   *  changed), "remove" (file or folder deleted). Falls back to "modify" when
   *  the underlying event kind is ambiguous. */
  kind: "create" | "modify" | "remove";
}

/** Validate a batch delivered by the native `vault_watch` channel before it
 * reaches `handleExternalChange`. The Rust side already filtered and coalesced,
 * but a shape mismatch (an older/newer native build) must degrade to "ignore",
 * never feed a malformed event into the store. Returns the well-formed events,
 * or `null` when the message is not a usable batch. */
export function decodeWatchBatch(msg: unknown): VaultWatchEvent[] | null {
  if (!Array.isArray(msg)) return null;
  const out: VaultWatchEvent[] = [];
  for (const item of msg) {
    if (!item || typeof item !== "object") return null;
    const rec = item as { paths?: unknown; kind?: unknown };
    if (!Array.isArray(rec.paths)) return null;
    const paths = rec.paths.filter((p): p is string => typeof p === "string");
    if (!paths.length) continue;
    const kind =
      rec.kind === "create" || rec.kind === "remove" ? rec.kind : "modify";
    out.push({ paths, kind });
  }
  return out.length ? out : null;
}

/** Watch external changes through filtered native batches, with a plugin fallback.
 * Return teardown; browser demo is a no-op. */
export async function watchVault(
  root: string,
  onChange: (events: VaultWatchEvent[]) => void
): Promise<() => void> {
  if (!IN_TAURI || root.startsWith(DEMO_ROOT)) return () => {};

  // --- Native batching watcher (one message per window, .git filtered in Rust)
  try {
    const channel = new Channel<unknown>();
    channel.onmessage = (msg) => {
      const batch = decodeWatchBatch(msg);
      if (batch) onChange(batch);
    };
    const id = await invoke<number>("vault_watch", { root, onEvent: channel });
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      channel.onmessage = () => {};
      void invoke("vault_unwatch", { id }).catch(() => {});
    };
  } catch (e) {
    // Older native build without the command, or a start failure — fall back to
    // the plugin watcher so external-change detection still works.
    console.error("[mesa] native vault_watch unavailable, using plugin watch:", e);
  }

  // --- Fallback: tauri-plugin-fs `watch` (one IPC message per raw event) ------
  try {
    // Coalesce raw events into a batch with a coarse kind. The Tauri fs watcher
    // emits one event per path-change with a structured `type` describing the
    // nature of the change. We reduce this to create/modify/remove so the store
    // can decide how to react (add a file, refresh content, or delete it).
    const batch: VaultWatchEvent[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleFlush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        if (batch.length) {
          onChange(batch.splice(0));
        }
      }, 60);
    };
    const kindFromEvent = (event: {
      type?:
        | "any"
        | { create?: unknown }
        | { remove?: unknown }
        | { modify?: unknown }
        | string
        | object;
    }): VaultWatchEvent["kind"] => {
      const t = event?.type;
      if (typeof t === "string") return "modify"; // "any" | "other"
      if (t !== null && typeof t === "object") {
        if ("create" in t) return "create";
        if ("remove" in t) return "remove";
        if ("modify" in t) return "modify";
      }
      return "modify";
    };
    const stop = await watch(
      root,
      (event: { paths?: string[]; type?: unknown }) => {
        const paths = Array.isArray(event?.paths) ? event.paths : [];
        if (!paths.length) return;
        batch.push({
          paths,
          kind: kindFromEvent(event as never),
        });
        scheduleFlush();
      },
      { recursive: true, delayMs: 120 }
    );
    return () => {
      if (flushTimer) clearTimeout(flushTimer);
      stop();
    };
  } catch (e) {
    // Watcher setup failures remain visible to diagnostics without throwing.
    console.error("[mesa] watchVault failed to start:", e);
    return () => {};
  }
}

/** Outcome of a crash-recovery sweep, for status/logging. */
export interface WriteRecoveryResult {
  restored: string[];
  removed: string[];
}

/** Execute writeRecovery decisions using scan-discovered artifacts or a fallback walk.
 * The caller re-scans after restoration. Report recovery outcomes without throwing. */
export async function recoverWriteArtifacts(
  root: string,
  /** Stop before recovery mutates anything. Already-started directory listings
   * are allowed to settle, matching the vault-scan cancellation contract. */
  stopped?: () => boolean,
  discovered?: FoundArtifact[] | null
): Promise<WriteRecoveryResult> {
  const result: WriteRecoveryResult = { restored: [], removed: [] };
  if (!IN_TAURI || isDemo(root)) return result;
  try {
    const found: FoundArtifact[] = [];
    if (discovered) {
      found.push(...discovered);
    } else {
      await collectFilesMatching(root, isMesaWriteArtifactName, found, stopped);
    }
    // Discovery may be partial after a superseding vault open. Do not apply a
    // partial plan: recovery is best-effort, while mutating the wrong vault is
    // not. The next open performs a complete sweep.
    if (stopped?.() || !found.length) return result;
    const writeArtifacts = found
      .filter((artifact) => isMesaWriteArtifactName(artifact.name))
      .map((artifact) => joinPath(artifact.dir, artifact.name));
    for (let offset = 0; offset < writeArtifacts.length; offset += 256) {
      await authorizeWriteArtifacts(writeArtifacts.slice(offset, offset + 256));
    }
    await Promise.all(
      found.map(async (a) => {
        try {
          const s = await stat(joinPath(a.dir, a.name));
          a.mtime = s.mtime ? new Date(s.mtime).getTime() : undefined;
        } catch {
          /* leave mtime undefined — planner treats it as stale */
        }
        const parsed = parseWriteArtifactName(a.name);
        // Both labels hold original bytes, so both need to know whether the
        // file they belong to still exists.
        if (parsed && parsed.label !== "save") {
          a.targetExists = await safeExists(joinPath(a.dir, parsed.targetBase));
        }
      })
    );
    if (stopped?.()) return result;
    for (const action of planWriteRecovery(found, Date.now())) {
      const artifactAbs = joinPath(action.dir, action.artifactName);
      try {
        if (action.kind === "restore") {
          const targetAbs = joinPath(action.dir, action.targetName);
          await invoke("vault_recover_artifact", { root, path: artifactAbs, restore: true });
          result.restored.push(targetAbs);
        } else {
          await invoke("vault_recover_artifact", { root, path: artifactAbs, restore: false });
          result.removed.push(artifactAbs);
        }
      } catch {
        /* skip — a locked or vanished artifact must not abort the sweep */
      }
    }
  } catch (e) {
    console.error("[mesa] write-artifact recovery sweep failed:", e);
  }
  return result;
}

/** Collect matching artifact names with bounded level traversal in deterministic batch/input order. */
async function collectFilesMatching(
  dir: string,
  matches: (name: string) => boolean,
  out: { dir: string; name: string }[],
  stopped?: () => boolean
): Promise<void> {
  let level = [dir];
  while (level.length && !stopped?.()) {
    const next: string[] = [];
    for (let i = 0; i < level.length && !stopped?.(); i += WALK_BATCH) {
      const batch = await Promise.all(
        level.slice(i, i + WALK_BATCH).map(async (current) => {
          const directories: string[] = [];
          const files: { dir: string; name: string }[] = [];
          if (stopped?.()) return { directories, files };
          let entries;
          try {
            entries = await readDir(current);
          } catch {
            return { directories, files };
          }
          if (stopped?.()) return { directories, files };
          for (const e of entries) {
            if (!e.name) continue;
            if (e.isDirectory) {
              if (e.name.startsWith(".") || SKIPPED_DIRS.has(e.name)) continue;
              directories.push(joinPath(current, e.name));
            } else if (e.isFile && matches(e.name)) {
              files.push({ dir: current, name: e.name });
            }
          }
          return { directories, files };
        })
      );
      for (const found of batch) {
        next.push(...found.directories);
        out.push(...found.files);
      }
    }
    level = next;
  }
}

export async function removeFile(absPath: string): Promise<void> {
  if (isDemo(absPath)) {
    const rel = absPath.startsWith(DEMO_ROOT)
      ? absPath.slice(DEMO_ROOT.length + 1)
      : absPath;
    delete DEMO[rel];
    return;
  }
  if (IN_TAURI) {
    await invoke("vault_move_to_recovery", { path: absPath });
    return;
  }
  const parent = parentDir(absPath);
  const name = baseName(absPath);
  const recoveryDir = joinPath(parent, ".mesa-trash");
  const recoveryRel = await uniqueRel(parent, `.mesa-trash/${Date.now()}-${name}`);
  await ensureDir(recoveryDir);
  await rename(absPath, joinPath(parent, recoveryRel));
}

export async function removeVaultEntry(
  root: string,
  relPath: string,
  recursive = false
): Promise<void> {
  void recursive;
  const clean = relPath.replace(/^\/+|\/+$/g, "");
  if (!clean) return;
  if (root.startsWith(DEMO_ROOT)) {
    const prefix = clean + "/";
    for (const rel of Object.keys(DEMO)) {
      if (rel === clean || rel.startsWith(prefix)) delete DEMO[rel];
    }
    return;
  }
  if (IN_TAURI) {
    await invoke("vault_move_to_recovery", { path: joinPath(root, clean) });
    return;
  }
  const recoveryRel = await uniqueRel(root, `.mesa-trash/${Date.now()}/${clean}`);
  await ensureDir(parentDir(joinPath(root, recoveryRel)));
  await rename(joinPath(root, clean), joinPath(root, recoveryRel));
}

function inferRecoveryOriginalRel(trashRelPath: string): string | null {
  const parts = trashRelPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const trashIndex = parts.indexOf(".mesa-trash");
  if (trashIndex < 0) return null;
  const parentParts = parts.slice(0, trashIndex);
  const storedParts = parts.slice(trashIndex + 1);
  if (parentParts.length === 0) {
    if (storedParts.length < 2) return null;
    return storedParts.slice(1).join("/");
  }
  if (storedParts.length !== 1) return null;
  const restoredName = storedParts[0]
    .replace(/^\d+-remote--/, "")
    .replace(/^\d+-/, "");
  if (!restoredName) return null;
  return [...parentParts, restoredName].join("/");
}

export async function listRecoveryEntries(root: string): Promise<RecoveryEntry[]> {
  if (root.startsWith(DEMO_ROOT)) return [];
  if (IN_TAURI) {
    return invoke<RecoveryEntry[]>("vault_list_recovery", { root });
  }
  const found: RecoveryEntry[] = [];
  const walkTrash = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readDir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.name) continue;
      const abs = joinPath(dir, entry.name);
      const trashRelPath = toRel(root, abs);
      const originalRelPath = inferRecoveryOriginalRel(trashRelPath);
      if (entry.isDirectory) {
        if (originalRelPath) {
          found.push({
            trashRelPath,
            originalRelPath,
            name: baseName(originalRelPath),
            isDirectory: true,
          });
        } else {
          await walkTrash(abs);
        }
      } else if (entry.isFile) {
        if (!originalRelPath) continue;
        found.push({
          trashRelPath,
          originalRelPath,
          name: baseName(originalRelPath),
          isDirectory: false,
        });
      }
    }
  };
  const walkVault = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readDir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.name || !entry.isDirectory) continue;
      const abs = joinPath(dir, entry.name);
      if (entry.name === ".mesa-trash") {
        await walkTrash(abs);
      } else if (!entry.name.startsWith(".") && !SKIPPED_DIRS.has(entry.name)) {
        await walkVault(abs);
      }
    }
  };
  await walkVault(root);
  return found.sort((a, b) => a.originalRelPath.localeCompare(b.originalRelPath));
}

/** Purge one listed item; the native command enforces main-window and vault authority. */
export async function purgeRecoveryEntry(root: string, entry: RecoveryEntry): Promise<void> {
  const parts = entry.trashRelPath.split("/");
  const trash = parts.indexOf(".mesa-trash");
  if (trash < 0 || trash === parts.length - 1 || parts.some(p => !p || p === "." || p === ".." || p.includes("\\") || p.includes(":"))) {
    throw new Error("Invalid recovery item path.");
  }
  if (root.startsWith(DEMO_ROOT)) return;
  if (!IN_TAURI) throw new Error("Permanent recovery removal requires the desktop app.");
  await invoke("vault_purge_recovery", { root, trashRelPath: entry.trashRelPath });
}

export async function restoreRecoveryEntry(
  root: string,
  entry: RecoveryEntry
): Promise<VaultFile> {
  const targetRel = await uniqueRel(root, entry.originalRelPath);
  const targetAbs = joinPath(root, targetRel);
  await ensureDir(parentDir(targetAbs));
  if (IN_TAURI) await invoke("vault_restore_recovery", { root, trashRelPath: entry.trashRelPath, targetRelPath: targetRel });
  else await rename(joinPath(root, entry.trashRelPath), targetAbs);
  return toVaultFile(root, targetRel);
}

/** Resolve an absolute file path to a URL the webview can load (images, etc). */
export function urlForPath(absPath: string): string {
  if (isDemo(absPath)) return SPARK_SVG;
  return convertFileSrc(absPath);
}

// --- demo vault (browser preview, no Rust build required) -----------------
const SPARK_SVG =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='160' viewBox='0 0 240 160'>
      <defs><radialGradient id='g' cx='50%' cy='45%' r='60%'>
        <stop offset='0%' stop-color='#7ae6a8'/><stop offset='60%' stop-color='#58a6ff'/>
        <stop offset='100%' stop-color='#10141c'/></radialGradient></defs>
      <rect width='240' height='160' fill='#0d1017'/>
      <circle cx='120' cy='72' r='46' fill='url(#g)'/>
      <g stroke='#58a6ff' stroke-width='2' opacity='0.7'>
        <line x1='120' y1='72' x2='40' y2='30'/><line x1='120' y1='72' x2='205' y2='40'/>
        <line x1='120' y1='72' x2='60' y2='130'/><line x1='120' y1='72' x2='195' y2='125'/></g>
      <g fill='#cbe6ff'><circle cx='40' cy='30' r='6'/><circle cx='205' cy='40' r='6'/>
        <circle cx='60' cy='130' r='6'/><circle cx='195' cy='125' r='6'/></g>
    </svg>`
  );

const DEMO: Record<string, string> = {
  "Welcome.md": `# Welcome to Mesa

This demo vault shows the core Mesa workflow. The desktop app opens your own
folders directly and keeps notes as plain files on disk.

Start here:
- [[Graph View]] — the living map of the vault
- [[Workspace]] — snap, close, pop out, and re-dock views
- [[Overlay and Pi]] — Shift+Tab tools plus the Pi terminal
- [[Sync and Saved Webpages]] — LAN/Tailscale sync and local HTML pages
- [[Keystroke Flicker]] — watch nodes light up as you type
- [[Markdown Basics]]

![[spark.svg]]

Keyboard path:
- <kbd>j</kbd>/<kbd>k</kbd> move through notes
- <kbd>h</kbd>/<kbd>l</kbd> move focus
- <kbd>/</kbd> searches
- <kbd>Shift</kbd>+<kbd>Tab</kbd> opens the overlay
- <kbd>Cmd/Ctrl</kbd>+<kbd>Left Shift</kbd>+<kbd>Space</kbd> opens Pi
`,
  "Graph View.md": `# Graph View

The graph is more than dots and lines. Nodes can render an embedded image as a
thumbnail, links thicken with connection strength, and active notes *flicker*.
When animations are enabled, nodes subtly breathe, twinkle, and react to panning
without destabilizing the layout.

Related: [[Keystroke Flicker]], [[Hover Preview]], [[Workspace]], [[Project Mesa]].

<div style="padding:8px 10px;border-left:3px solid #58a6ff;background:#161b22;border-radius:6px">
  HTML renders inline too — this callout is raw &lt;div&gt; markup.
</div>
`,
  "Workspace.md": `# Workspace

Mesa is a constrained workspace for the current vault. Open a file, Preview,
Graph, Tasks, or Pi and the first view fills the empty workspace. Add another
view and Mesa splits the space only after something is already open.

Drag view headers to swap, snap, pop out, or dock views back in. Closing a view
lets the remaining content fill the available space.

Related: [[Graph View]], [[Overlay and Pi]].
`,
  "Overlay and Pi.md": `# Overlay and Pi

Press <kbd>Shift</kbd>+<kbd>Tab</kbd> for Mesa's overlay: calendar, search, Pi,
scratchpad, whiteboard, gallery, and overlay settings.

Pi is a terminal, not a chat panel. Press
<kbd>Cmd/Ctrl</kbd>+<kbd>Left Shift</kbd>+<kbd>Space</kbd> to open the dedicated
Pi overlay. Mesa gives Pi path-only context for the active workspace so tokens
are spent only when you use Pi.

Related: [[Workspace]], [[Sync and Saved Webpages]].
`,
  "Sync and Saved Webpages.md": `# Sync and Saved Webpages

Sync is designed for your own devices. Turn on Sync, set one sync key, receive
from a device, then add nearby Mesa devices when they appear on LAN or
Tailscale. Discovery shares device metadata only; vault data still needs the
sync key.

Saved HTML files open as local pages so sibling asset folders can load like they
would in a browser. Source mode is still available when you need to inspect the
captured file.
`,
  "Keystroke Flicker.md": `# Keystroke Flicker

When you edit a note, its node in the graph reacts to your typing: the more
frequent the keystrokes, the faster and brighter it flickers. It decays back to
calm a moment after you stop.

See it next to [[Graph View]].
`,
  "Markdown Basics.md": `# Markdown Basics

Mesa supports standard Markdown plus [[wiki links]].

- **bold**, *italic*, \`code\`
- Lists, quotes, tables
- Images: ![[spark.svg]]

Back to [[Welcome]].
`,
  "Ideas/Project Mesa.md": `# Project Mesa

A note-taking app where the graph is alive. Links: [[Graph View]],
[[Hover Preview]], [[Keystroke Flicker]], [[Workspace]].
`,
  "Ideas/Hover Preview.md": `# Hover Preview

Rest the pointer on any node for a moment and a preview card fades in with
the note's rendered Markdown — images and HTML included.

Connected to [[Graph View]] and [[Project Mesa]].

![[spark.svg]]
`,
  "assets/spark.svg": "<!-- demo image, served from memory -->",
};

function demoFiles(): VaultFile[] {
  return Object.keys(DEMO).map((rel) => {
    const name = baseName(rel);
    const ext = extOf(name);
    return {
      path: joinPath(DEMO_ROOT, rel),
      relPath: rel,
      name: stripExt(name),
      ext,
      isMarkdown: ext === "md" || ext === "markdown",
    };
  });
}
function demoRead(rel: string): string {
  return DEMO[rel] ?? "";
}
function demoWrite(rel: string, content: string): void {
  DEMO[rel] = content;
}
