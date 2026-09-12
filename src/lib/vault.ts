import { readBoundedText } from "./boundedText";
import { open } from "@tauri-apps/plugin-dialog";
import {
  readDir,
  readTextFile,
  readFile,
  writeFile,
  remove,
  rename,
  mkdir,
  exists,
  stat,
  watch,
  // plugin-dialog owns the plain `open` name above.
  open as openFsFile,
} from "@tauri-apps/plugin-fs";
import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { VaultFile } from "../types";
import {
  buildWriteArtifactPath,
  persistVerifiedBytes,
  parseWriteArtifactName,
  bytesEqual,
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

/** The one fs adapter every verified vault write goes through. `rename` makes
 *  the final commit atomic (temp → target), so a crash can never leave a
 *  half-written file where a note or PDF used to be. */
const VAULT_FS: VerifiedWriteFs = { readFile, writeFile, remove, exists, rename };

/** Are we running inside the Tauri shell (vs. a plain browser preview)? */
export const IN_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const DEMO_ROOT = "mesa://demo";

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
/**
 * Whether Mesa's note-TEXT pipeline may read and write this file.
 *
 * The one definition of that decision. `selectFile` already used exactly this
 * test to decide whether to load a file's content into the editor cache; every
 * other stage of the text pipeline (`ensureContent`, `flushSave`, `writeNote`)
 * now asks the same question, so the read side and the write side can never
 * disagree about what a file is.
 *
 * Why it matters: the text pipeline round-trips through a JS string
 * (`readTextFile` → `contentCache` → `TextEncoder`). For a PDF, an image, or
 * any other binary that round-trip is destructive — and when there is no cached
 * text at all (the normal state for a binary, which is never read as text), the
 * "current content" of the active file reads as the empty string, so a flush
 * would replace the file with zero bytes. Binary files are edited only through
 * their own byte-level paths (`pdfSave.ts` → `persistVerifiedBytes`).
 */
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

/**
 * The text a crash-safety flush (blur / hide / quit) is allowed to write for
 * `file`, or `null` when the flush must be skipped entirely.
 *
 * A flush exists to persist a debounced *edit*, so it may only ever write text
 * Mesa actually holds for that file. Two cases must never reach the disk:
 *   - a file the text pipeline may not touch at all (see `isTextualVaultFile`)
 *   - a file with no cached text, i.e. nothing was ever loaded or edited — for
 *     example a note whose opening read is still in flight. Treating that as ""
 *     would flush an empty document over the real file.
 * An empty *cached* string is a real edit (the user cleared the note) and is
 * written normally.
 */
export function flushableNoteText(
  file: { ext: string; isMarkdown?: boolean },
  cachedContent: string | undefined
): string | null {
  if (cachedContent === undefined) return null;
  if (!isTextualVaultFile(file)) return null;
  return cachedContent;
}

/**
 * Whether an externally modified file's CACHED text must be re-read from disk.
 *
 * The mirror of `flushableNoteText` on the read side: any file whose text Mesa
 * is holding has to be refreshed when that file changes underneath it, or the
 * cache becomes a lie. The watcher refreshed markdown only, which was survivable
 * while markdown was the only thing cached at vault open — but the content cache
 * now covers every textual file the budget allows (`planTextCache`), so a `.txt`,
 * `.py`, `.json` or `.html` edited by another tool, a synced device, or an agent
 * kept its stale text for the whole session. That is not just a display problem:
 * search matched text no longer on disk, `selectFile` served the stale copy
 * synchronously (it only reads when the entry is `undefined`), and saving that
 * copy wrote it straight back over the newer file.
 *
 * A file with NO cache entry returns false on purpose — nothing is stale, and
 * the lazy read in `ensureContent` already produces current text. Re-reading it
 * here would also pull in files the vault-open budget deliberately skipped.
 */
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

/**
 * Canonical form of a vault root path: forward slashes, no trailing slash.
 *
 * Every place Mesa remembers or compares a vault path must use this so the same
 * folder is never stored under two spellings. This matters most on Windows,
 * where the OS hands back backslash paths from some entry points and
 * forward-slash paths from the folder dialog — without canonicalizing, the
 * recents list can't match its own entries and "remove vault" appears to do
 * nothing.
 */
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
    title: "Open vault folder",
  });
  if (typeof result === "string") return canonicalRoot(result);
  return null;
}

/**
 * Prove that a remembered vault root is still a reachable directory before
 * replacing the current workspace. Network/removable roots can disappear
 * between launches; an unavailable root must never be interpreted as an empty
 * vault merely because both directory walkers failed.
 */
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

/**
 * Fill in `size`/`mtime`/`createdAt` for already-listed files, mutating them in place.
 *
 * There is no bulk metadata call: this is one `stat` IPC round-trip PER FILE,
 * and on the measured 4,165-file vault it is **93% of `scanVault`** (1,476 ms
 * of 1,593 ms; the directory walk over 166 directories is only 117 ms). Stats
 * run in parallel at a fixed width so file count cannot turn directly into
 * in-flight memory. Mutating in place is deliberate — `PdfView` subscribes to
 * a file's primitive `mtime` rather than to object identity. The graph also
 * uses the creation timestamp when it replays a timelapse.
 */
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

/**
 * Recursively list every file in the vault.
 *
 * `metadata: false` returns the listing WITHOUT `size`/`mtime`, leaving the
 * expensive per-file stat pass to the caller. `openVault` uses it to keep those
 * 4,165 round-trips off the path to the first frame; every other caller wants
 * the metadata inline and gets it by default.
 */
/**
 * One-IPC listing via the native walker (`vaultscan.rs`), or null when it is
 * unavailable — an older shell, a non-Tauri host, or any failure at all.
 *
 * Only `rel`/`size`/`mtime`/`created` cross the bridge; every derived field is computed
 * here with the SAME helpers the `readDir` walk uses, so the two paths cannot
 * produce different `name`/`ext`/`isMarkdown`/`path` values. The Rust walk's
 * filter rules are pinned against this file by `vaultScanContract.test.ts` and
 * by `vaultscan.rs`'s own parity test.
 */
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
  } catch {
    // Command missing or walk failed — the readDir path below still works.
    return null;
  }
}

/**
 * Every file in the vault.
 *
 * Prefers the native one-round-trip walker: the `readDir`-per-directory walk
 * plus one `stat` PER FILE measured 1,593 ms on the 4,165-file reference vault
 * (1,476 ms of it the stat pass alone), against ~20 ms for the same walk done
 * natively — the gap is IPC round-trip count, not disk. That pass is in front
 * of the first paint whenever the sidebar sorts by `modified` or `size`.
 *
 * `metadata: false` is now only a hint: the native path always returns size and
 * mtime because they are free once the walk has the dirent. It still suppresses
 * the expensive per-file `stat` pass on the fallback path.
 *
 * `onArtifacts` receives the crash-recovery write artifacts the SAME walk found,
 * or `null` when this scan could not answer (browser demo, or a shell without
 * the native command) and `recoverWriteArtifacts` must do its own walk. That
 * walk was 153 `read_dir` IPC round-trips on the reference vault — 96% of the
 * whole pre-paint round-trip budget — to find nothing in the normal case; see
 * `vaultscan.rs`. It is a callback rather than a second return value so every
 * existing caller keeps the plain `VaultFile[]` contract.
 */
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

/**
 * Whether `scanVault` would index this vault-relative path — the ONE definition
 * of what Mesa considers part of a vault.
 *
 * `walk` skips every dot-prefixed entry (files and directories alike) plus
 * `node_modules` and `.git`, so anything under them can never appear in `files`.
 * The watcher needs the same answer: it only checked the BASENAME for a leading
 * dot, so `.git/index` looked like an ordinary file called `index`. It was then
 * missing from `files`, `registerExternalFile` refused it (it applies these
 * rules), and the fallback ran `refreshMissingExternalFiles` — a full
 * `scanVault` — for that one path, and again for the next one. A `git commit`
 * inside a vault emits dozens of such events in a single 60 ms watch batch, so
 * an ordinary git operation could put the app into back-to-back whole-vault
 * rescans (4,165 readDir + 4,165 stat IPC round-trips each, on a vault this
 * size). Answering the question up front removes the work rather than bounding
 * it.
 */
export function isIndexableVaultRelPath(rel: string): boolean {
  if (!rel) return false;
  for (const seg of rel.split("/")) {
    if (!seg || seg.startsWith(".") || SKIPPED_DIRS.has(seg)) return false;
  }
  return true;
}

/**
 * Every `readDir` is an IPC round-trip, so walking one directory at a time made
 * vault-open latency scale with the directory COUNT. Sibling directories are
 * listed a level at a time in bounded batches instead; `scanVault` sorts by
 * `relPath` afterwards, so traversal order never reaches the result.
 */
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
  return readBoundedText(await openFsFile(file.path, { read: true }), maxBytes);
}

export async function readNote(file: VaultFile): Promise<string> {
  return (await readNoteResult(file)).text;
}

/**
 * Files per `vault_read_text` round-trip.
 *
 * This is the only thing bounding the response buffer and the decode burst, so
 * it trades round-trips against peak memory rather than against throughput —
 * the real read parallelism is chosen natively (`available_parallelism()`), not
 * by this number. 128 keeps a batch of ordinary notes in the low megabytes
 * while turning the reference vault's ~2,400 reads into ~20 round-trips, and it
 * matches `SEARCH_CORPUS_BATCH` so one chunk read produces exactly one store
 * commit during background hydration.
 */
export const VAULT_TEXT_CHUNK = 128;

/**
 * Network-mounted vaults have much higher per-request latency than local
 * folders. Keep their native read pressure deliberately small. This is a
 * conservative path-shape hint: UNC roots and macOS mounted volumes are the
 * only forms Mesa can identify without probing or writing to the filesystem.
 */
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

/** In-flight per-file reads when the native bulk command is unavailable. Only
 *  the fallback needs a bound; the native path's parallelism is chosen in Rust. */
const FALLBACK_READ_CONCURRENCY = 16;

/**
 * Decode one `vault_read_text` response body.
 *
 * Frame (little-endian): `u32 count`, then per file `u32 len` followed by `len`
 * bytes, where `len === 0xffffffff` means that file could not be read.
 *
 * Decoding is non-fatal, matching `plugin:fs|read_text_file`'s JS half exactly:
 * both hand raw bytes to a default `TextDecoder`, so invalid UTF-8 becomes
 * U+FFFD identically on the native and fallback paths. `vaultReadContract.test.ts`
 * pins this against the Rust encoder.
 *
 * Returns `null` for a file that failed, which callers map to the same `""`
 * `readNote` has always returned for an unreadable file.
 */
export function decodeTextChunk(
  /** Whatever `invoke` handed back. The custom-protocol IPC yields an
   *  `ArrayBuffer`, but Tauri silently falls back to `postMessage` if that
   *  protocol is ever blocked, and there a byte array arrives as a plain array
   *  of numbers. `plugin-fs`'s own readers handle both; so must this one, or a
   *  fallback shell would decode garbage instead of degrading. */
  body: ArrayBuffer | Uint8Array | number[]
): (string | null)[] {
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
  const out: (string | null)[] = [];
  let at = 4;
  for (let i = 0; i < count; i++) {
    need(at, 4);
    const len = view.getUint32(at, true);
    at += 4;
    if (len === TEXT_READ_FAILED) {
      out.push(null);
      continue;
    }
    need(at, len);
    out.push(decoder.decode(bytes.subarray(at, at + len)));
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
): Promise<(string | null)[] | null> {
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
    const texts = decodeTextChunk(body);
    // A short frame would silently shift every file's text onto the wrong path.
    // Refusing it costs one fallback batch; trusting it corrupts the cache.
    if (texts.length !== rels.length) return null;
    return texts;
  } catch {
    return null;
  }
}

async function readSearchTextFallback(file: VaultFile): Promise<string | null> {
  if (file.isMarkdown || isDemo(file.path)) return readNote(file);
  if (typeof file.size === "number") {
    if (file.size > MAX_TEXT_CACHE_FILE_BYTES) return null;
  } else if (IN_TAURI) {
    try {
      const info = await stat(file.path);
      if (typeof info.size === "number" && info.size > MAX_TEXT_CACHE_FILE_BYTES) {
        return null;
      }
    } catch {
      return null;
    }
  }
  try {
    return await readTextFile(file.path);
  } catch {
    return null;
  }
}

export async function readVaultTextOptional(
  root: string,
  files: readonly VaultFile[]
): Promise<(string | null)[]> {
  if (!files.length) return [];
  if (!isDemo(root)) {
    const texts = await readVaultTextNative(
      root,
      files.map((f) => f.relPath),
      isLikelyRemoteVaultPath(root) ? 2 : 0
    );
    if (texts) return texts;
  }
  const out = new Array<string | null>(files.length);
  await forEachConcurrent(files, FALLBACK_READ_CONCURRENCY, async (file, i) => {
    out[i] = await readSearchTextFallback(file);
  });
  return out;
}

/**
 * Read a batch of vault files in ONE round-trip, in the given order.
 *
 * Per-file reads were ~2,400 invokes per vault open on the reference vault.
 * Every Tauri invoke goes over the custom-protocol IPC, and on Windows that is
 * a WebView2 `WebResourceRequested` raised on the UI thread whose response wry
 * delivers by posting a window message and forcing `RDW_INTERNALPAINT` — so the
 * round-trip count is charged to the same thread that delivers keystrokes and
 * paints. The search-corpus half of those reads runs while the user is already
 * typing. See `vaultread.rs` for the source references.
 *
 * Result semantics match `readNote` exactly, including that an unreadable file
 * yields `""` rather than throwing: the callers cache that empty string today
 * and changing it would alter what search and the note graph see.
 */
export async function readVaultText(
  root: string,
  files: readonly VaultFile[]
): Promise<string[]> {
  return (await readVaultTextOptional(root, files)).map((text) => text ?? "");
}

/** Decode a byte-capped peek to text, dropping any trailing partial UTF-8
 *  sequence (a cut multi-byte char decodes to U+FFFD at the very end). */
export function decodePeekBytes(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return text.replace(/�+$/, "");
}

/**
 * Read at most `maxBytes` from the head of a file. Hover previews only ever
 * show the first few KB, so reading a whole multi-MB note just to render a
 * 1200-char excerpt is what made preview cards feel slow. Falls back to a
 * whole-file read when the streaming handle isn't available (browser demo,
 * older shells). Never used for editing — the editor always reads the full
 * file — so a truncated peek can never be written back to disk.
 */
export async function peekNote(file: VaultFile, maxBytes = 16384): Promise<string> {
  if (isDemo(file.path)) return demoRead(file.relPath);
  try {
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

/**
 * Write TEXT content to a vault file.
 *
 * Fails closed on anything the text pipeline may not represent
 * (`isTextualVaultFile`): encoding a JS string over a PDF/image/archive
 * destroys it, and this is the last checkpoint every text write passes
 * through, so no present or future caller can reach the disk with a
 * text-encoded overwrite of a binary file. Binary editing has its own
 * byte-level path (`pdfSave.ts` → `persistVerifiedBytes`).
 */
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

/**
 * Byte-preserving rename for ANY vault file. The text pipeline must never be
 * part of a rename: reading a binary through the text cache yields `""` (by
 * design, see `ensureContent`), so a rename built on read-text → write-text →
 * remove-original would replace a PDF with an empty file and delete the real
 * bytes. An OS `rename` moves the bytes atomically without decoding them —
 * it is the same primitive the verified-write pipeline trusts for its own
 * commit step. Refuses to overwrite an existing target: a rename is never
 * overwrite authority.
 */
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
  const srcAbs = joinPath(root, srcRel);
  const destAbs = joinPath(root, destRel);
  const caseOnlyRename = srcRel !== destRel && srcRel.toLowerCase() === destRel.toLowerCase();
  if ((await exists(destAbs)) && !caseOnlyRename) {
    throw new Error(`"${destRel}" already exists.`);
  }
  await ensureDir(parentDir(destAbs));
  if (caseOnlyRename) {
    const tempRel = await uniqueRel(root, `${srcRel}.mesa-rename-${Date.now()}.tmp`);
    const tempAbs = joinPath(root, tempRel);
    await rename(srcAbs, tempAbs);
    try {
      await rename(tempAbs, destAbs);
    } catch (error) {
      await rename(tempAbs, srcAbs).catch(() => undefined);
      throw error;
    }
  } else {
    await rename(srcAbs, destAbs);
  }
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
  try {
    await mkdir(absDir, { recursive: true });
  } catch {
    /* already exists */
  }
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

export interface DroppedImportFailure {
  /** Basename only: enough to identify the source without exposing its path. */
  name: string;
  message: string;
}

export interface DroppedImportResult {
  created: VaultFile[];
  failures: DroppedImportFailure[];
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
  paths: string[]
): Promise<DroppedImportResult> {
  if (!IN_TAURI || isDemo(root)) return { created: [], failures: [] };
  const created: VaultFile[] = [];
  const failures: DroppedImportFailure[] = [];
  for (const p of paths) {
    const norm = p.replace(/\\/g, "/");
    const base = norm.split("/").pop() || norm;
    const ext = extOf(base);
    try {
      if (ext === "zip") {
        await importZip(root, norm, base, created);
      } else {
        const data = await readFile(norm);
        const destRel = TEXT_EXT.test(base) ? base : `attachments/${base}`;
        await placeFile(root, destRel, data, created);
      }
    } catch (error) {
      failures.push({ name: base, message: String(error) });
    }
  }
  return { created, failures };
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
  created: VaultFile[]
): Promise<void> {
  const { unzipSync } = await import("./zipCodec");
  const data = await readFile(srcPath);
  const folder = base.replace(/\.zip$/i, "");
  const entries = unzipSync(data);
  for (const name of Object.keys(entries)) {
    if (name.endsWith("/")) continue; // directory entry
    if (name.startsWith("__MACOSX/")) continue; // macOS zip cruft
    await placeFile(root, `${folder}/${name}`, entries[name], created);
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

/** Watch the vault for external changes (e.g. an AI agent writing files).
 * Returns an unwatch function. No-op in the browser demo.
 *
 * Prefers Mesa's native `vault_watch` command (src-tauri/src/vaultwatch.rs),
 * which filters `.git`/dot churn and coalesces a whole debounce window into ONE
 * IPC message. The plugin `watch` path below is the fallback: it emits one IPC
 * message per raw event, and on Windows every one of those is a WebView2
 * UI-thread `eval` plus a forced repaint (see `vaultwatch.rs`), so a git
 * checkout or device sync inside the vault stalls input for its duration. */
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
    // Surface watcher setup failures — a silent catch here previously hid the
    // missing `watch` cargo feature for a long time. Never throw.
    console.error("[mesa] watchVault failed to start:", e);
    return () => {};
  }
}

/** Outcome of a crash-recovery sweep, for status/logging. */
export interface WriteRecoveryResult {
  restored: string[];
  removed: string[];
}

/**
 * Create a file only if no entry exists at `path`.
 *
 * Both routes use the filesystem's create-new operation. The second route is
 * a compatibility fallback for a platform that rejects `writeFile` with its
 * create-new option. Neither route can overwrite a file that appears after
 * recovery discovery.
 */
async function writeRecoveryFileCreateNew(
  path: string,
  bytes: Uint8Array
): Promise<void> {
  let writeError: unknown;
  try {
    await writeFile(path, bytes, { createNew: true });
    return;
  } catch (error) {
    writeError = error;
  }

  // If the first route created the target or another process won the race,
  // keep that file unchanged. The fallback is only for a still-missing path.
  if (await safeExists(path)) throw writeError;

  const handle = await openFsFile(path, { write: true, createNew: true });
  try {
    const written = await handle.write(bytes);
    if (written !== bytes.byteLength) {
      throw new Error("Recovery wrote an incomplete file.");
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Create a new recovery file and verify all bytes before it is trusted. */
async function writeRecoveryFileCreateNewVerified(
  path: string,
  bytes: Uint8Array
): Promise<void> {
  await writeRecoveryFileCreateNew(path, bytes);
  const written = await readFile(path);
  if (!bytesEqual(written, bytes)) {
    throw new Error("Recovery file verification failed.");
  }
}

/**
 * Make a verified rescue copy before recovery writes a missing target.
 *
 * A crash can stop a create-new write before all bytes reach the target. The
 * rescue copy makes the next sweep preserve the original bytes if that occurs.
 */
async function makeRecoveryRescue(
  targetPath: string,
  bytes: Uint8Array
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    // Keep unverified bytes under the disposable `save` label. Only a verified
    // staging file can become a rescue, so a failed copy cannot be selected as
    // an original during the next recovery sweep.
    const stagingPath = buildWriteArtifactPath(targetPath, "save");
    const rescuePath = buildWriteArtifactPath(targetPath, "rescue");
    try {
      await writeRecoveryFileCreateNewVerified(stagingPath, bytes);
      if (await safeExists(rescuePath)) {
        throw new Error("Recovery rescue path already exists.");
      }
      await rename(stagingPath, rescuePath);
      const rescued = await readFile(rescuePath);
      if (!bytesEqual(rescued, bytes)) {
        throw new Error("Recovery rescue verification failed.");
      }
      return rescuePath;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("Recovery could not create a rescue copy.");
}

/**
 * Sweep the vault for write artifacts left behind by a crash or power loss
 * mid-save (`.name.ext.mesa-save/backup-…tmp`, `.mesa-sync-tmp-…`) and recover:
 * restore one original-holding artifact when its target is missing, and remove
 * stale disposable artifacts. Decisions live in `writeRecovery.ts` (pure);
 * this function only walks and executes.
 *
 * Runs at vault open. `discovered` is the artifact list `vault_scan` collected
 * during the listing walk; pass `null`/omit it to make this do its own walk
 * (browser demo, or a shell without the native command). Because the native
 * list now arrives WITH the scan rather than before it, `openVault` re-scans
 * after a restore so a restored file is still scanned normally — one extra
 * round-trip in the rare crashed case, against 153 on every open.
 *
 * Never throws — recovery must not block opening a vault.
 */
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
          const bytes = await readFile(artifactAbs);
          const parsed = parseWriteArtifactName(action.artifactName);
          if (!parsed || parsed.label === "save") continue;

          // A rescue already has the preservation semantics that recovery
          // needs. A backup gets a verified rescue sibling before Mesa creates
          // the target, so a crash during the create cannot strand the bytes.
          const recoveryRescue =
            parsed.label === "backup"
              ? await makeRecoveryRescue(targetAbs, bytes)
              : null;

          await writeRecoveryFileCreateNewVerified(targetAbs, bytes);
          result.restored.push(targetAbs);

          // The target passed the final byte-for-byte read-back. It is now safe
          // to remove the selected artifact and its temporary rescue copy.
          await remove(artifactAbs);
          if (recoveryRescue) {
            await remove(recoveryRescue);
          }
        } else {
          await remove(artifactAbs);
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

/**
 * Collect `{dir, name}` entries for files whose basename passes `matches`,
 * using the same bounded, level-at-a-time directory walk and skip rules as the
 * visible vault scan. Every `readDir` is an IPC round-trip; serial recursion
 * made recovery add another directory-count-scaled pass before `scanVault`.
 * Results from each batch are appended in level/input order, independent of
 * which sibling listing settles first.
 */
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
  const restoredName = storedParts[0].replace(/^\d+-/, "");
  if (!restoredName) return null;
  return [...parentParts, restoredName].join("/");
}

export async function listRecoveryEntries(root: string): Promise<RecoveryEntry[]> {
  if (root.startsWith(DEMO_ROOT)) return [];
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

export async function restoreRecoveryEntry(
  root: string,
  entry: RecoveryEntry
): Promise<VaultFile> {
  const targetRel = await uniqueRel(root, entry.originalRelPath);
  const targetAbs = joinPath(root, targetRel);
  await ensureDir(parentDir(targetAbs));
  await rename(joinPath(root, entry.trashRelPath), targetAbs);
  return toVaultFile(root, targetRel);
}

/** Resolve an absolute file path to a URL the webview can load (images, etc). */
export function urlForPath(absPath: string): string {
  if (isDemo(absPath)) return demoAsset(absPath);
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

// Static instead of base64-in-JavaScript so the browser fixture stays out of
// Mesa's production startup chunk. Vite serves/copies this local public asset.
const DEMO_PDF_URI = "/mesa-pdf-tour.pdf";

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
  "Mesa PDF Tour.pdf": "",
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
function demoAsset(absPath: string): string {
  if (/\.pdf$/i.test(absPath)) return DEMO_PDF_URI;
  return SPARK_SVG;
}
