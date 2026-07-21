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

export type VerifiedWriteStage = "Backup" | "Temporary" | "Final" | "Restore";

export interface VerifiedWriteOptions {
  kind?: string;
  validate?: (bytes: Uint8Array, stage: VerifiedWriteStage) => Promise<void>;
  /**
   * Optional optimistic-concurrency precondition checked from disk inside the
   * verified-write transaction before any backup/temp/target write occurs.
   * `null` requires a missing target; bytes require an exact existing match;
   * `undefined` preserves the normal unconditional-write behavior.
   */
  expectedCurrentBytes?: Uint8Array | null;
}

export type WriteArtifactLabel = "save" | "backup";

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

const ARTIFACT_RE = /^\.(.+)\.mesa-(save|backup)-\d+-[a-z0-9]+\.tmp$/;

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
  if (validate) {
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

    if (fs.rename) {
      try {
        await fs.rename(tempPath, filePath);
        tempConsumed = true;
      } catch {
        // Rename can fail across quirky filesystems; fall back to a rewrite.
        await fs.writeFile(filePath, snapshot);
      }
    } else {
      await fs.writeFile(filePath, snapshot);
    }
    await readBackVerifiedBytes(filePath, snapshot, fs, "Final", options);
  } catch (error) {
    if (backupWritten && original) {
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
      } catch {
        // Best effort restore; preserve the original failure below.
      }
    } else if (!hadOriginal) {
      await fs.remove(filePath).catch(() => undefined);
    }
    throw error;
  } finally {
    if (tempWritten && !tempConsumed) {
      await fs.remove(tempPath).catch(() => undefined);
    }
    if (backupWritten) {
      await fs.remove(backupPath).catch(() => undefined);
    }
  }
}
