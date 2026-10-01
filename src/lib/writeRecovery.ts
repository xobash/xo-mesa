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
 * - Original-holding artifacts are grouped by directory and target. If the
 *   target is missing, Mesa restores one deterministic candidate. A `rescue`
 *   has priority over a `backup`; the newest embedded timestamp and ID break
 *   ties. All other original-holding artifacts stay in place.
 * - A stale `backup` whose target exists is redundant (the commit is atomic;
 *   the target is either the old or the fully-verified new bytes) → removed.
 * - A stale `save` temp is always removed: its bytes were either committed via
 *   rename (in which case no artifact remains) or never committed.
 * - A `rescue` artifact is the original of a write whose rollback FAILED, so it
 *   may be the only surviving copy of the user's file. It is restored when the
 *   target is missing and otherwise LEFT IN PLACE — never removed, because the
 *   target it sits next to holds bytes Mesa could not verify.
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
  /** Whether the artifact's target file currently exists (originals only). */
  targetExists?: boolean;
}

export type RecoveryAction =
  | { kind: "restore"; dir: string; artifactName: string; targetName: string }
  | { kind: "remove"; dir: string; artifactName: string };

const SYNC_TMP_RE = /^\.mesa-sync-tmp-\d+-.+$/;
const RECOVERY_ARTIFACT_RE =
  /^\.(.+)\.mesa-(save|backup|rescue)-(\d+)-([a-z0-9]+)\.tmp$/;

interface OriginalArtifact extends FoundArtifact {
  label: "backup" | "rescue";
  targetName: string;
  timestamp: string;
  id: string;
  index: number;
}

interface IndexedAction {
  action: RecoveryAction;
  index: number;
}

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
  const actions: IndexedAction[] = [];
  const originalGroups = new Map<string, OriginalArtifact[]>();

  for (const [index, a] of artifacts.entries()) {
    // An unknown mtime is not evidence that an artifact is stale. A transient
    // stat failure can happen while another Mesa instance is actively saving;
    // touching that artifact could break its rollback path. Preserve it and
    // let a later complete sweep determine its age.
    const age = a.mtime === undefined ? -Infinity : now - a.mtime;
    const details = RECOVERY_ARTIFACT_RE.exec(a.name);
    if (details) {
      const label = details[2] as "save" | "backup" | "rescue";
      if (label === "backup" || label === "rescue") {
        const key = `${a.dir}\0${details[1]}`;
        const group = originalGroups.get(key) ?? [];
        group.push({
          ...a,
          label,
          targetName: details[1],
          timestamp: details[3],
          id: details[4],
          index,
        });
        originalGroups.set(key, group);
      } else if (age >= minAgeMs) {
        actions.push({
          action: { kind: "remove", dir: a.dir, artifactName: a.name },
          index,
        });
      }
      continue;
    }
    if (age >= minAgeMs && SYNC_TMP_RE.test(a.name)) {
      actions.push({
        action: { kind: "remove", dir: a.dir, artifactName: a.name },
        index,
      });
    }
  }

  for (const group of originalGroups.values()) {
    // If one original-holding artifact is fresh, a Mesa instance can still be
    // writing this target. Do not change any original-holding artifact in the
    // group during this sweep.
    if (
      group.some((artifact) => {
        const age =
          artifact.mtime === undefined ? -Infinity : now - artifact.mtime;
        return age < minAgeMs;
      })
    ) {
      continue;
    }

    const targetStates = new Set(group.map((artifact) => artifact.targetExists));
    if (targetStates.size !== 1) {
      // A changing or unreadable target produced an inconsistent discovery
      // snapshot. Keep every copy and let a later complete sweep decide.
      continue;
    }

    const [targetExists] = targetStates;
    if (targetExists === false) {
      const candidate = [...group].sort(compareRecoveryCandidates)[0];
      actions.push({
        action: {
          kind: "restore",
          dir: candidate.dir,
          artifactName: candidate.name,
          targetName: candidate.targetName,
        },
        index: Math.min(...group.map((artifact) => artifact.index)),
      });
      continue;
    }

    if (targetExists === true) {
      for (const artifact of group) {
        if (artifact.label === "rescue") continue;
        actions.push({
          action: {
            kind: "remove",
            dir: artifact.dir,
            artifactName: artifact.name,
          },
          index: artifact.index,
        });
      }
    }
  }

  return actions
    .sort((left, right) => left.index - right.index)
    .map(({ action }) => action);
}

function compareRecoveryCandidates(
  left: OriginalArtifact,
  right: OriginalArtifact
): number {
  const labelDifference =
    recoveryLabelRank(right.label) - recoveryLabelRank(left.label);
  if (labelDifference !== 0) return labelDifference;
  const timestampDifference = compareDecimalNewestFirst(
    left.timestamp,
    right.timestamp
  );
  if (timestampDifference !== 0) return timestampDifference;
  if (left.id !== right.id) return left.id < right.id ? 1 : -1;
  if (left.name === right.name) return 0;
  return left.name < right.name ? 1 : -1;
}

function recoveryLabelRank(label: "backup" | "rescue"): number {
  return label === "rescue" ? 1 : 0;
}

function compareDecimalNewestFirst(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+(?=\d)/, "");
  const normalizedRight = right.replace(/^0+(?=\d)/, "");
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedRight.length - normalizedLeft.length;
  }
  if (normalizedLeft === normalizedRight) return 0;
  return normalizedLeft < normalizedRight ? 1 : -1;
}
