import { readDir, stat } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import type { VaultFile } from "../types";
import { parseWriteArtifactName } from "./verifiedWrite";
import { isMesaWriteArtifactName, planWriteRecovery, type FoundArtifact } from "./writeRecovery";
import { forEachConcurrent } from "./concurrency";
import {
  IN_TAURI, SKIPPED_DIRS, WALK_BATCH, guardedRename, authorizeWriteArtifacts, ensureDir, isDemo,
  isWindowsShellName, safeExists, uniqueRel,
} from "./vault";
import { DEMO, DEMO_ROOT } from "./vaultDemo";
import { baseName, joinPath, parentDir, toRel, toVaultFile } from "./vaultPaths";

export interface RecoveryEntry {
  trashRelPath: string;
  originalRelPath: string;
  name: string;
  isDirectory: boolean;
}

/** Concurrent artifact stat requests during crash recovery. */
const RECOVERY_STAT_CONCURRENCY = 32;

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
      for (const artifact of discovered) found.push(artifact);
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
    await forEachConcurrent(found, RECOVERY_STAT_CONCURRENCY, async (a) => {
      try {
        const s = await stat(joinPath(a.dir, a.name));
        a.mtime = s.mtime ? new Date(s.mtime).getTime() : undefined;
      } catch {
        /* leave mtime undefined; the planner preserves an artifact of unknown age */
      }
      const parsed = parseWriteArtifactName(a.name);
      // Both labels hold original bytes, so both need to know whether the
      // file they belong to still exists.
      if (parsed && parsed.label !== "save") {
        a.targetExists = await safeExists(joinPath(a.dir, parsed.targetBase));
      }
    }, stopped);
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
              if (e.name.startsWith(".") || SKIPPED_DIRS.has(e.name) || isWindowsShellName(e.name)) continue;
              directories.push(joinPath(current, e.name));
            } else if (e.isFile && matches(e.name)) {
              files.push({ dir: current, name: e.name });
            }
          }
          return { directories, files };
        })
      );
      for (const found of batch) {
        for (const directory of found.directories) next.push(directory);
        for (const file of found.files) out.push(file);
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
  await guardedRename(absPath, joinPath(parent, recoveryRel));
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
  await guardedRename(joinPath(root, clean), joinPath(root, recoveryRel));
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
      } else if (!entry.name.startsWith(".") && !SKIPPED_DIRS.has(entry.name) && !isWindowsShellName(entry.name)) {
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
  else await guardedRename(joinPath(root, entry.trashRelPath), targetAbs);
  return toVaultFile(root, targetRel);
}
