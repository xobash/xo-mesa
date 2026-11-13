import { readDir, stat } from "@tauri-apps/plugin-fs";
import type { VaultFile } from "../types";
import { forEachConcurrent } from "./concurrency";
import { extOf, joinPath, stripExt, toRel } from "./vaultPaths";

// Plugin-fs fallback walk, its path filter and the per-file metadata pass.

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
/** Deepest path the vault indexes (`MAX_REL_SEGMENTS` in `vault_names.rs`). */
export const MAX_VAULT_REL_SEGMENTS = 255;

export function isIndexableVaultRelPath(rel: string): boolean {
  if (!rel) return false;
  const segments = rel.split("/");
  // Same depth cap as the native scan, watcher and sync walks.
  if (segments.length > MAX_VAULT_REL_SEGMENTS) return false;
  for (const seg of segments) {
    if (!seg || seg.startsWith(".") || SKIPPED_DIRS.has(seg) || isWindowsShellName(seg)) return false;
  }
  return true;
}

/** List sibling directories in bounded level batches; final sorting makes traversal order irrelevant. */
export const WALK_BATCH = 16;

export async function walk(
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
