import { parseWriteArtifactName } from "./verifiedWrite";

/**
 * Crash recovery for Mesa's verified-write machinery.
 *
 * A verified write leaves two dot-prefixed sibling artifacts while in flight:
 * `.name.ext.mesa-save-…tmp` (candidate bytes) and `.name.ext.mesa-backup-…tmp`
 * (the original bytes). On a clean save both are removed. If Mesa crashes or
 * loses power mid-save, this module decides — purely, so it is unit-testable —
 * what to do with whatever was left behind when the vault is next opened.
 *
 * Rules:
 * - Artifacts younger than `minAgeMs` are left alone: another Mesa instance
 *   (or this one) may be mid-save right now.
 * - A stale `backup` whose target file is missing is restored to the target —
 *   that is the user's original file and must never be thrown away.
 * - A stale `backup` whose target exists is redundant (the commit is atomic;
 *   the target is either the old or the fully-verified new bytes) → removed.
 * - A stale `save` temp is always removed: its bytes were either committed via
 *   rename (in which case no artifact remains) or never committed.
 * - Stale sync temps (`.mesa-sync-tmp-…`, written by the Rust side) → removed.
 */

/** One dot-prefixed artifact found in a vault directory. */
export interface FoundArtifact {
  /** Directory the artifact lives in (vault-relative or absolute, opaque). */
  dir: string;
  /** Basename, e.g. `.note.md.mesa-backup-123-ab.tmp`. */
  name: string;
  /** Last-modified time in ms, undefined when stat failed. */
  mtime?: number;
  /** Whether the artifact's target file currently exists (backups only). */
  targetExists?: boolean;
}

export type RecoveryAction =
  | { kind: "restore"; dir: string; artifactName: string; targetName: string }
  | { kind: "remove"; dir: string; artifactName: string };

const SYNC_TMP_RE = /^\.mesa-sync-tmp-\d+-.+$/;

/** Minimum artifact age before recovery touches it. */
export const RECOVERY_MIN_AGE_MS = 60_000;

/** Is this basename any Mesa write artifact (save/backup/sync temp)? */
export function isMesaWriteArtifactName(name: string): boolean {
  return parseWriteArtifactName(name) !== null || SYNC_TMP_RE.test(name);
}

/**
 * Decide recovery actions for the artifacts found in a vault.
 * Pure: no filesystem access, fully driven by the inputs.
 */
export function planWriteRecovery(
  artifacts: FoundArtifact[],
  now: number,
  minAgeMs: number = RECOVERY_MIN_AGE_MS
): RecoveryAction[] {
  const actions: RecoveryAction[] = [];
  for (const a of artifacts) {
    // Unknown mtime → treat as old enough; leaving unreadable debris forever
    // is worse than the tiny mid-save race a missing stat implies.
    const age = a.mtime === undefined ? Infinity : now - a.mtime;
    if (age < minAgeMs) continue;

    const parsed = parseWriteArtifactName(a.name);
    if (parsed) {
      if (parsed.label === "backup" && a.targetExists === false) {
        actions.push({
          kind: "restore",
          dir: a.dir,
          artifactName: a.name,
          targetName: parsed.targetBase,
        });
      } else {
        actions.push({ kind: "remove", dir: a.dir, artifactName: a.name });
      }
      continue;
    }
    if (SYNC_TMP_RE.test(a.name)) {
      actions.push({ kind: "remove", dir: a.dir, artifactName: a.name });
    }
  }
  return actions;
}
