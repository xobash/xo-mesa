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
  /** Native vault scopes need exact grants for dot-prefixed sibling artifacts. */
  authorizeArtifacts?(paths: string[]): Promise<void>;
  /** Flush file bytes and the containing directory before relying on a write. */
  flush?(path: string): Promise<void>;
  /** Native single-transaction path. It owns staging, durable publication,
   * rescue, and the expected-disk-state check within one command. */
  atomicWrite?(path: string, data: Uint8Array, expectedCurrentBytes?: Uint8Array | null): Promise<void>;
}

type VerifiedWriteStage =
  | "Backup"
  | "Temporary"
  | "Final"
  | "Restore"
  | "Rescue";

/** Apply format validation only to authored candidate bytes; verify preserved originals by byte equality. */
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

/** Create dot-prefixed siblings on the target filesystem; scan, watch, and sync must exclude them. */
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

/** Promote the verified backup to rescue, falling back to a verified copy or retaining the backup.
 * Do not begin in-place replacement unless crash recovery will preserve the original. */
async function preserveOriginalBytes(
  filePath: string,
  original: Uint8Array,
  backupPath: string,
  fs: VerifiedWriteFs,
  options: VerifiedWriteOptions
): Promise<string> {
  const rescuePath = buildWriteArtifactPath(filePath, "rescue");
  await fs.authorizeArtifacts?.([rescuePath]);
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

/** Persist expected bytes through verified staging, commit, and read-back.
 * Native writes use their transaction adapter; compatibility rollback retains rescue bytes on failure.
 * See docs/vault-safety.md for atomicity and recovery limits. */
export async function persistVerifiedBytes(
  filePath: string,
  snapshot: Uint8Array,
  fs: VerifiedWriteFs,
  options: VerifiedWriteOptions = {}
): Promise<void> {
  if (fs.atomicWrite) {
    if (options.validate) {
      try {
        await options.validate(snapshot, "Temporary");
      } catch {
        throw new Error(`Temporary ${options.kind ?? "file"} write verification failed.`);
      }
    }
    await fs.atomicWrite(filePath, snapshot, options.expectedCurrentBytes);
    return;
  }
  const tempPath = buildWriteArtifactPath(filePath, "save");
  const backupPath = buildWriteArtifactPath(filePath, "backup");
  await fs.authorizeArtifacts?.([tempPath, backupPath]);
  const hadOriginal = await fs.exists(filePath);
  const original = hadOriginal ? copyBytes(await fs.readFile(filePath)) : null;
  let tempWritten = false;
  let tempConsumed = false;
  let backupWritten = false;
  let targetCommitAttempted = false;
  let preservedPath: string | null = null;
  let fallbackRescuePath: string | null = null;

  const prepareNonAtomicOverwrite = async (): Promise<void> => {
    if (!backupWritten || !original) return;
    const rescuePath = await preserveOriginalBytes(
      filePath,
      original,
      backupPath,
      fs,
      options
    );
    if (rescuePath === backupPath) {
      // Recovery removes stale backups when the target exists because an
      // atomic commit cannot leave a partial target. An in-place fallback can.
      // Do not enter that crash window unless recovery can identify the
      // original as a rescue and keep it beside an unverified target.
      throw new Error(
        `Could not preserve the original ${options.kind ?? "file"} before the non-atomic write fallback.`
      );
    }
    fallbackRescuePath = rescuePath;
  };

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
      await fs.flush?.(backupPath);
    }

    await fs.writeFile(tempPath, snapshot);
    tempWritten = true;
    await readBackVerifiedBytes(tempPath, snapshot, fs, "Temporary", options);
    await fs.flush?.(tempPath);

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
        await prepareNonAtomicOverwrite();
        targetCommitAttempted = true;
        await fs.writeFile(filePath, snapshot);
      }
    } else {
      await prepareNonAtomicOverwrite();
      targetCommitAttempted = true;
      await fs.writeFile(filePath, snapshot);
    }
    await readBackVerifiedBytes(filePath, snapshot, fs, "Final", options);
    await fs.flush?.(filePath);
  } catch (error) {
    if (targetCommitAttempted && backupWritten && original) {
      let restored = false;
      try {
        const rollbackPath = fallbackRescuePath ?? backupPath;
        const backupRead = await readBackVerifiedBytes(
          rollbackPath,
          original,
          fs,
          "Backup",
          options
        );
        await fs.writeFile(filePath, backupRead);
        await readBackVerifiedBytes(filePath, original, fs, "Restore", options);
        await fs.flush?.(filePath);
        restored = true;
      } catch {
        // Best effort restore; preserve the original failure below.
      }
      if (!restored) {
        // The target holds bytes we could not verify and the rollback could not
        // put the original back. Deleting the backup here is what turned a
        // failed save into permanent data loss, so keep it instead.
        preservedPath =
          fallbackRescuePath ??
          (await preserveOriginalBytes(
            filePath,
            original,
            backupPath,
            fs,
            options
          ));
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
    if (fallbackRescuePath && preservedPath !== fallbackRescuePath) {
      await fs.remove(fallbackRescuePath).catch(() => undefined);
    }
  }
}
