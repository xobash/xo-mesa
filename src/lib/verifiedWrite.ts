export interface VerifiedWriteFs {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Atomic replace (POSIX rename / MoveFileEx). Optional: when present, the
   *  final commit renames the verified temp file over the target instead of
   *  rewriting the target in place, so a crash mid-commit can never leave the
   *  target truncated. */
  rename?(oldPath: string, newPath: string): Promise<void>;
}

export type VerifiedWriteStage =
  | "Backup"
  | "Temporary"
  | "Final"
  | "Restore"
  | "Rescue";

/**
 * Stages holding bytes MESA AUTHORED, and therefore the only ones `validate`
 * judges. `Backup`, `Restore`, and `Rescue` hold the user's existing file: it
 * is already on disk, Mesa is only preserving it, and byte-for-byte equality
 * already proves the copy is faithful. Applying a format opinion there refuses
 * to save an edit because the ORIGINAL displeases the validator — which is
 * backwards, since the save is what would replace it. Real PDFs carrying more
 * than 4 KiB of debris after `%%EOF` parse and edit fine but fail Mesa's EOF
 * check, so this was reachable as "Backup PDF write verification failed."
 */
const AUTHORED_STAGES: ReadonlySet<VerifiedWriteStage> = new Set([
  "Temporary",
  "Final",
]);

export interface VerifiedWriteOptions {
  kind?: string;
  /** Judges candidate bytes only — see `AUTHORED_STAGES`. */
  validate?: (bytes: Uint8Array, stage: VerifiedWriteStage) => Promise<void>;
  /**
   * Optional optimistic-concurrency precondition checked from disk inside the
   * verified-write transaction before any backup/temp/target write occurs.
   * `null` requires a missing target; bytes require an exact existing match;
   * `undefined` preserves the normal unconditional-write behavior.
   */
  expectedCurrentBytes?: Uint8Array | null;
}

/**
 * `save` = candidate bytes in flight, `backup` = the original bytes for the
 * duration of one transaction, `rescue` = the original bytes of a transaction
 * whose rollback FAILED. A rescue artifact is the user's last surviving copy,
 * so unlike the other two it outlives the transaction and crash recovery never
 * deletes it while the target exists.
 */
export type WriteArtifactLabel = "save" | "backup" | "rescue";

/** Split a forward- or back-slash path into directory + basename. */
function splitPath(path: string): { dir: string; base: string } {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i < 0) return { dir: "", base: path };
  return { dir: path.slice(0, i + 1), base: path.slice(i + 1) };
}

/**
 * Sibling artifact path for an in-flight write. Dot-prefixed on purpose:
 * every layer that must never see Mesa's write machinery — `scanVault`'s walk,
 * the vault watcher's `registerExternalFile`, and the sync manifest on both
 * the TS and Rust sides — already skips dot-prefixed names. Same directory as
 * the target so the final rename cannot cross a filesystem boundary.
 */
export function buildWriteArtifactPath(
  path: string,
  label: WriteArtifactLabel
): string {
  const { dir, base } = splitPath(path);
  return `${dir}.${base}.mesa-${label}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.tmp`;
}

const ARTIFACT_RE = /^\.(.+)\.mesa-(save|backup|rescue)-\d+-[a-z0-9]+\.tmp$/;

export interface WriteArtifactInfo {
  /** Basename of the file the artifact was written for. */
  targetBase: string;
  label: WriteArtifactLabel;
}

/** Parse a basename produced by `buildWriteArtifactPath`. Null for anything else. */
export function parseWriteArtifactName(name: string): WriteArtifactInfo | null {
  const m = ARTIFACT_RE.exec(name);
  if (!m) return null;
  return { targetBase: m[1], label: m[2] as WriteArtifactLabel };
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return bytes.slice(0);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function readBackVerifiedBytes(
  path: string,
  expected: Uint8Array,
  fs: VerifiedWriteFs,
  stage: VerifiedWriteStage,
  { kind = "file", validate }: VerifiedWriteOptions
): Promise<Uint8Array> {
  const bytes = copyBytes(await fs.readFile(path));
  if (validate && AUTHORED_STAGES.has(stage)) {
    try {
      await validate(bytes, stage);
    } catch {
      throw new Error(`${stage} ${kind} write verification failed.`);
    }
  }
  if (!bytesEqual(bytes, expected)) {
    throw new Error(`${stage} ${kind} write verification failed.`);
  }
  return bytes;
}

/**
 * Make the original bytes outlive a transaction whose rollback failed.
 *
 * Preferred route is renaming the already-verified backup, because the same
 * condition that breaks a rollback is usually a full disk — where copying a
 * second 52 MB PDF would fail too. Falls back to a verified copy, and finally
 * to keeping the backup under its own name. Returns the surviving path; the
 * caller uses it to decide whether the backup may still be cleaned up.
 */
async function preserveOriginalBytes(
  filePath: string,
  original: Uint8Array,
  backupPath: string,
  fs: VerifiedWriteFs,
  options: VerifiedWriteOptions
): Promise<string> {
  const rescuePath = buildWriteArtifactPath(filePath, "rescue");
  if (fs.rename) {
    try {
      await fs.rename(backupPath, rescuePath);
      return rescuePath;
    } catch {
      // Fall through to a copy.
    }
  }
  try {
    await fs.writeFile(rescuePath, original);
    await readBackVerifiedBytes(rescuePath, original, fs, "Rescue", options);
    return rescuePath;
  } catch {
    // An unverified rescue copy must not be advertised as the survivor; drop
    // it and keep the backup, which was verified at the start of the write.
    await fs.remove(rescuePath).catch(() => undefined);
    return backupPath;
  }
}

/**
 * Persist bytes with read-back verification, atomic commit, and rollback.
 *
 * Mesa treats filesystem overwrites as untrusted until the path reads back with
 * the exact bytes it meant to write. The sequence is:
 *
 * 1. Existing target → write + verify a sibling backup of the original bytes.
 * 2. Write + verify (and validate) the candidate bytes to a sibling temp file.
 * 3. Commit: atomically rename the verified temp over the target when the fs
 *    supports rename; otherwise rewrite the target in place.
 * 4. Read the target back and verify it byte-for-byte one final time.
 * 5. Any failure → restore the original bytes from the backup (verified), or
 *    remove a failed brand-new file so no truncated debris is left behind.
 * 6. If that restore ALSO fails, the backup is the only remaining copy of the
 *    user's file — it is preserved as a `rescue` artifact and named in the
 *    thrown error instead of being cleaned up.
 *
 * With rename available there is no instant at which the target holds partial
 * bytes: it is either the old file or the fully-verified new file.
 */
export async function persistVerifiedBytes(
  filePath: string,
  snapshot: Uint8Array,
  fs: VerifiedWriteFs,
  options: VerifiedWriteOptions = {}
): Promise<void> {
  const tempPath = buildWriteArtifactPath(filePath, "save");
  const backupPath = buildWriteArtifactPath(filePath, "backup");
  const hadOriginal = await fs.exists(filePath);
  const original = hadOriginal ? copyBytes(await fs.readFile(filePath)) : null;
  let tempWritten = false;
  let tempConsumed = false;
  let backupWritten = false;
  let targetCommitAttempted = false;
  let preservedPath: string | null = null;

  try {
    if (options.expectedCurrentBytes === null && hadOriginal) {
      throw new Error(`Current ${options.kind ?? "file"} no longer matches the expected missing state.`);
    }
    if (options.expectedCurrentBytes instanceof Uint8Array) {
      if (!original || !bytesEqual(original, options.expectedCurrentBytes)) {
        throw new Error(`Current ${options.kind ?? "file"} bytes changed before the verified write.`);
      }
    }
    if (original) {
      await fs.writeFile(backupPath, original);
      backupWritten = true;
      await readBackVerifiedBytes(backupPath, original, fs, "Backup", options);
    }

    await fs.writeFile(tempPath, snapshot);
    tempWritten = true;
    await readBackVerifiedBytes(tempPath, snapshot, fs, "Temporary", options);

    // The precondition above protects the start of the transaction. Re-check
    // it immediately before commit as well: backup/temp verification may take
    // long enough for another process to rewrite the target in between.
    if (options.expectedCurrentBytes === null) {
      if (await fs.exists(filePath)) {
        throw new Error(`Current ${options.kind ?? "file"} no longer matches the expected missing state.`);
      }
    } else if (options.expectedCurrentBytes instanceof Uint8Array) {
      const current = await fs.readFile(filePath).catch(() => null);
      if (!current || !bytesEqual(current, options.expectedCurrentBytes)) {
        throw new Error(`Current ${options.kind ?? "file"} bytes changed before the verified write.`);
      }
    }

    if (fs.rename) {
      try {
        await fs.rename(tempPath, filePath);
        targetCommitAttempted = true;
        tempConsumed = true;
      } catch {
        // Rename can fail across quirky filesystems; fall back to a rewrite.
        // Recheck the optimistic precondition once more first because the
        // rename attempt itself may have raced with an external writer.
        if (options.expectedCurrentBytes === null) {
          if (await fs.exists(filePath)) {
            throw new Error(`Current ${options.kind ?? "file"} no longer matches the expected missing state.`);
          }
        } else if (options.expectedCurrentBytes instanceof Uint8Array) {
          const current = await fs.readFile(filePath).catch(() => null);
          if (!current || !bytesEqual(current, options.expectedCurrentBytes)) {
            throw new Error(`Current ${options.kind ?? "file"} bytes changed before the verified write.`);
          }
        }
        targetCommitAttempted = true;
        await fs.writeFile(filePath, snapshot);
      }
    } else {
      targetCommitAttempted = true;
      await fs.writeFile(filePath, snapshot);
    }
    await readBackVerifiedBytes(filePath, snapshot, fs, "Final", options);
  } catch (error) {
    if (targetCommitAttempted && backupWritten && original) {
      let restored = false;
      try {
        const backupRead = await readBackVerifiedBytes(
          backupPath,
          original,
          fs,
          "Backup",
          options
        );
        await fs.writeFile(filePath, backupRead);
        await readBackVerifiedBytes(filePath, original, fs, "Restore", options);
        restored = true;
      } catch {
        // Best effort restore; preserve the original failure below.
      }
      if (!restored) {
        // The target holds bytes we could not verify and the rollback could not
        // put the original back. Deleting the backup here is what turned a
        // failed save into permanent data loss, so keep it instead.
        preservedPath = await preserveOriginalBytes(
          filePath,
          original,
          backupPath,
          fs,
          options
        );
      }
    } else if (targetCommitAttempted && !hadOriginal) {
      await fs.remove(filePath).catch(() => undefined);
    }
    if (preservedPath) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${detail} The original ${options.kind ?? "file"} was preserved at ${preservedPath}.`
      );
    }
    throw error;
  } finally {
    if (tempWritten && !tempConsumed) {
      await fs.remove(tempPath).catch(() => undefined);
    }
    // A backup promoted to a rescue copy is already gone from this path; one
    // kept under its own name is the survivor and must not be removed.
    if (backupWritten && preservedPath !== backupPath) {
      await fs.remove(backupPath).catch(() => undefined);
    }
  }
}
