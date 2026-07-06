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
import { convertFileSrc } from "@tauri-apps/api/core";
import type { VaultFile } from "../types";
import {
  persistVerifiedBytes,
  parseWriteArtifactName,
  type VerifiedWriteFs,
} from "./verifiedWrite";
import {
  isMesaWriteArtifactName,
  planWriteRecovery,
  type FoundArtifact,
} from "./writeRecovery";
import {
  isAgentSnapshotName,
  latestAgentSnapshot,
  planAgentSnapshotPrune,
  type FoundAgentSnapshot,
} from "./agentBackup";

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
 * where the OS hands back backslash paths (`C:\Users\Xo\Vault`) from some entry
 * points and forward-slash paths from the folder dialog — without canonicalizing,
 * the recents list can't match its own entries and "remove vault" appears to do
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
/** Parent directory of an absolute path, forward-slash normalized, no
 *  trailing slash — pairs with `joinPath`/`baseName` for splitting a path. */
function dirName(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i < 0 ? "" : norm.slice(0, i);
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

/** Recursively list every file in the vault. */
export async function scanVault(root: string): Promise<VaultFile[]> {
  if (isDemo(root)) return demoFiles();
  const out: VaultFile[] = [];
  await walk(root, root, out);
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  // best-effort metadata for sidebar sorting (parallel, never fatal)
  try {
    await Promise.all(
      out.map(async (f) => {
        try {
          const s = await stat(f.path);
          f.size = s.size;
          f.mtime = s.mtime ? new Date(s.mtime).getTime() : undefined;
        } catch {
          /* leave undefined */
        }
      })
    );
  } catch {
    /* stat unavailable — sorting by name/links still works */
  }
  return out;
}

async function walk(dir: string, root: string, out: VaultFile[]): Promise<void> {
  let entries;
  try {
    entries = await readDir(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.name || e.name.startsWith(".")) continue;
    const full = joinPath(dir, e.name);
    if (e.isDirectory) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      await walk(full, root, out);
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
}

export async function readNote(file: VaultFile): Promise<string> {
  if (isDemo(file.path)) return demoRead(file.relPath);
  try {
    return await readTextFile(file.path);
  } catch {
    return "";
  }
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

export async function writeNote(file: VaultFile, content: string): Promise<void> {
  if (isDemo(file.path)) {
    demoWrite(file.relPath, content);
    return;
  }
  const bytes = new TextEncoder().encode(content);
  await persistVerifiedBytes(file.path, bytes, VAULT_FS);
}

export async function createNote(
  root: string,
  relPath: string,
  content = ""
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
    await persistVerifiedBytes(full, bytes, VAULT_FS);
  }
  return file;
}

/** Create or replace a text file in the vault, preserving its real file type. */
export async function writeVaultTextFile(
  root: string,
  relPath: string,
  content = ""
): Promise<VaultFile> {
  const full = joinPath(root, relPath);
  if (isDemo(root)) {
    demoWrite(relPath, content);
  } else {
    await ensureDir(parentDir(full));
    const bytes = new TextEncoder().encode(content);
    await persistVerifiedBytes(full, bytes, VAULT_FS);
  }
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
  await persistVerifiedBytes(destAbs, bytes, VAULT_FS);
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

/**
 * Import OS-dropped file paths into the vault: text/markdown to the root,
 * images & other binaries to `attachments/`, and `.zip` archives extracted
 * into a folder. Returns the VaultFiles created. No-op in the browser demo.
 */
export async function importDroppedPaths(
  root: string,
  paths: string[]
): Promise<VaultFile[]> {
  if (!IN_TAURI || isDemo(root)) return [];
  const created: VaultFile[] = [];
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
    } catch {
      /* skip unreadable / permission-denied entries */
    }
  }
  return created;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
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
    await persistVerifiedBytes(joinPath(root, rel), data, VAULT_FS);
    created.push(toVaultFile(root, rel));
    return;
  }
  await ensureDir(parentDir(full));
  await persistVerifiedBytes(full, data, VAULT_FS);
  created.push(toVaultFile(root, destRel));
}

async function importZip(
  root: string,
  srcPath: string,
  base: string,
  created: VaultFile[]
): Promise<void> {
  const { unzipSync } = await import("fflate");
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

/** Watch the vault for external changes (e.g. an AI agent writing files).
 * Returns an unwatch function. No-op in the browser demo. */
export async function watchVault(
  root: string,
  onChange: (events: VaultWatchEvent[]) => void
): Promise<() => void> {
  if (!IN_TAURI || root.startsWith(DEMO_ROOT)) return () => {};
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
 * Sweep the vault for write artifacts left behind by a crash or power loss
 * mid-save (`.name.ext.mesa-save/backup-…tmp`, `.mesa-sync-tmp-…`) and recover:
 * restore a backup whose target file is missing, remove everything else stale.
 * Decisions live in `writeRecovery.ts` (pure); this only walks and executes.
 * Runs at vault open, before the scan, so a restored file is scanned normally.
 * Never throws — recovery must not block opening a vault.
 */
export async function recoverWriteArtifacts(
  root: string
): Promise<WriteRecoveryResult> {
  const result: WriteRecoveryResult = { restored: [], removed: [] };
  if (!IN_TAURI || isDemo(root)) return result;
  try {
    const found: FoundArtifact[] = [];
    await collectArtifacts(root, found);
    if (!found.length) return result;
    await Promise.all(
      found.map(async (a) => {
        try {
          const s = await stat(joinPath(a.dir, a.name));
          a.mtime = s.mtime ? new Date(s.mtime).getTime() : undefined;
        } catch {
          /* leave mtime undefined — planner treats it as stale */
        }
        const parsed = parseWriteArtifactName(a.name);
        if (parsed?.label === "backup") {
          a.targetExists = await safeExists(joinPath(a.dir, parsed.targetBase));
        }
      })
    );
    for (const action of planWriteRecovery(found, Date.now())) {
      const artifactAbs = joinPath(action.dir, action.artifactName);
      try {
        if (action.kind === "restore") {
          const targetAbs = joinPath(action.dir, action.targetName);
          try {
            await rename(artifactAbs, targetAbs);
          } catch {
            // rename unavailable/failed — copy the bytes, then drop the artifact
            const bytes = await readFile(artifactAbs);
            await writeFile(targetAbs, bytes);
            await remove(artifactAbs);
          }
          result.restored.push(targetAbs);
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

async function collectArtifacts(dir: string, out: FoundArtifact[]): Promise<void> {
  let entries;
  try {
    entries = await readDir(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.name) continue;
    if (e.isDirectory) {
      // Same skip rules as the scan walk.
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      await collectArtifacts(joinPath(dir, e.name), out);
    } else if (e.isFile && isMesaWriteArtifactName(e.name)) {
      out.push({ dir, name: e.name });
    }
  }
}

/** Outcome of an agent-snapshot prune sweep, for status/logging. */
export interface AgentSnapshotPruneResult {
  removed: string[];
}

/**
 * Sweep the vault for stale Pi-write safety snapshots (dot-prefixed
 * `.name.ext.mesa-pi-snapshot-…bak` siblings — see `src/lib/agentBackup.ts`)
 * and remove everything past the retention window (`planAgentSnapshotPrune`).
 * Runs at vault open, alongside `recoverWriteArtifacts`. Never throws —
 * pruning must not block opening a vault.
 */
export async function pruneAgentSnapshots(
  root: string
): Promise<AgentSnapshotPruneResult> {
  const result: AgentSnapshotPruneResult = { removed: [] };
  if (!IN_TAURI || isDemo(root)) return result;
  try {
    const found: FoundAgentSnapshot[] = [];
    await collectAgentSnapshots(root, found);
    if (!found.length) return result;
    for (const action of planAgentSnapshotPrune(found, Date.now())) {
      const artifactAbs = joinPath(action.dir, action.name);
      try {
        await remove(artifactAbs);
        result.removed.push(artifactAbs);
      } catch {
        /* skip — a locked or vanished artifact must not abort the sweep */
      }
    }
  } catch (e) {
    console.error("[mesa] agent-snapshot prune sweep failed:", e);
  }
  return result;
}

async function collectAgentSnapshots(
  dir: string,
  out: FoundAgentSnapshot[]
): Promise<void> {
  let entries;
  try {
    entries = await readDir(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.name) continue;
    if (e.isDirectory) {
      // Same skip rules as the write-artifact and scan walks.
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      await collectAgentSnapshots(joinPath(dir, e.name), out);
    } else if (e.isFile && isAgentSnapshotName(e.name)) {
      out.push({ dir, name: e.name });
    }
  }
}

/**
 * Find the newest Pi-write safety snapshot for `absPath`, if one exists.
 * Read-only — does not touch the target file. Returns the snapshot's
 * absolute path, or null.
 */
export async function findLatestAgentSnapshot(
  absPath: string
): Promise<string | null> {
  if (!IN_TAURI) return null;
  const dir = dirName(absPath);
  const target = baseName(absPath);
  let entries;
  try {
    entries = await readDir(dir);
  } catch {
    return null;
  }
  const found: FoundAgentSnapshot[] = entries
    .filter((e): e is typeof e & { name: string } => Boolean(e.isFile && e.name && isAgentSnapshotName(e.name)))
    .map((e) => ({ dir, name: e.name }));
  const match = latestAgentSnapshot(found, dir, target);
  return match ? joinPath(match.dir, match.name) : null;
}

/**
 * Restore `absPath` from its newest Pi-write safety snapshot, if one exists.
 * The restore write itself goes through `persistVerifiedBytes` — the
 * *recovery* write gets Mesa's normal backup/atomic-rename/read-back
 * guarantees even though the original corrupting write (made by Pi's
 * external process) did not. Returns whether a snapshot was found and
 * restored; never throws.
 */
export async function restoreLatestAgentSnapshot(
  absPath: string
): Promise<boolean> {
  const snapshotAbs = await findLatestAgentSnapshot(absPath);
  if (!snapshotAbs) return false;
  const bytes = await readFile(snapshotAbs);
  await persistVerifiedBytes(absPath, bytes, VAULT_FS, {
    kind: "Pi-agent snapshot restore",
  });
  return true;
}

export async function removeFile(absPath: string): Promise<void> {
  if (isDemo(absPath)) {
    const rel = absPath.startsWith(DEMO_ROOT)
      ? absPath.slice(DEMO_ROOT.length + 1)
      : absPath;
    delete DEMO[rel];
    return;
  }
  try {
    await remove(absPath);
  } catch {
    /* ignore */
  }
}

export async function removeVaultEntry(
  root: string,
  relPath: string,
  recursive = false
): Promise<void> {
  const clean = relPath.replace(/^\/+|\/+$/g, "");
  if (!clean) return;
  if (root.startsWith(DEMO_ROOT)) {
    const prefix = clean + "/";
    for (const rel of Object.keys(DEMO)) {
      if (rel === clean || rel.startsWith(prefix)) delete DEMO[rel];
    }
    return;
  }
  await remove(joinPath(root, clean), { recursive });
}

/** Resolve an absolute file path to a URL the webview can load (images, etc). */
export function urlForPath(absPath: string): string {
  if (isDemo(absPath)) return demoAsset();
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
function demoAsset(): string {
  return SPARK_SVG; // the demo ships a single illustrative image
}
