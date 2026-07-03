/**
 * Defensive snapshots for the one write path Mesa's own verified-write
 * machinery (`verifiedWrite.ts`) cannot see: writes made directly by the
 * embedded Pi agent's own tools.
 *
 * Pi runs as a real, unsandboxed native process (`src-tauri/src/terminal.rs`)
 * with the vault folder as its cwd, driven by whatever provider/model the
 * user configured in the terminal. When its `write`/`edit` tools touch a
 * file, the bytes hit disk straight from that external process — never
 * through `persistVerifiedBytes`, so none of Mesa's backup/atomic-rename/
 * read-back guarantees apply. A tool that mishandles a binary file, a
 * hand-rolled extraction script, or a model mistake can overwrite a vault
 * file with no recovery path at all — most visibly on PDFs, since binary
 * files are the least forgiving of a naive text-oriented write.
 *
 * `mesa-activity.ts` already intercepts every `write`/`edit` tool_call
 * *before* it runs (needed for the living-graph read/write signal). This
 * module adds a second, independent use of that same pre-execution moment:
 * copy the file's current on-disk bytes to a dot-prefixed sibling snapshot
 * first, so a corrupting write is always recoverable. The naming/parsing/
 * retention contract here is the tested reference; `mesa-activity.ts` mirrors
 * the same scheme inline (it is a standalone resource compiled into the Rust
 * binary via `include_str!` and cannot import this module at runtime) — the
 * same split already used for `activityOpForTool` in `agent.ts`.
 *
 * Scope on purpose: this is a safety net, not a lock. It never blocks or
 * slows Pi's tools (the snapshot copy is a best-effort side step taken
 * before the real write, exactly like the activity report already is) and it
 * never restores anything automatically — that stays a deliberate user or UI
 * action so Mesa never silently discards a Pi edit the user actually wanted.
 */

/** Keep at most this many snapshots per target file. */
export const AGENT_SNAPSHOT_KEEP_PER_FILE = 5;

/** Prune a snapshot once it is older than this, even if under the count cap. */
export const AGENT_SNAPSHOT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/** Split a forward- or back-slash path into directory + basename. Mirrors the
 *  private helper in `verifiedWrite.ts` so this module stays a standalone,
 *  dependency-free naming contract (the same reason it is re-declared rather
 *  than imported: `mesa-activity.ts` needs the identical logic without being
 *  able to import anything from `src/lib`). */
function splitPath(path: string): { dir: string; base: string } {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i < 0) return { dir: "", base: path };
  return { dir: path.slice(0, i + 1), base: path.slice(i + 1) };
}

// Deliberately distinct from `verifiedWrite.ts`'s `mesa-(save|backup)-…tmp`
// scheme (and from `.mesa-sync-tmp-…`) so `writeRecovery.ts`'s crash-recovery
// sweep — which assumes any stale sibling "backup" is redundant once the
// target exists — never touches these. A Pi-write snapshot's target existing
// says nothing about whether those bytes are trustworthy.
const SNAPSHOT_RE = /^\.(.+)\.mesa-pi-snapshot-(\d+)-[a-z0-9]+\.bak$/;

/** Build the sibling snapshot path for `filePath` at time `now`. Same
 *  directory as the target (dot-prefixed, so scan/watch/sync skip rules that
 *  already hide Mesa's own write artifacts hide this too). */
export function buildAgentSnapshotPath(
  filePath: string,
  now: number,
  rand: string = Math.random().toString(36).slice(2)
): string {
  const { dir, base } = splitPath(filePath);
  return `${dir}.${base}.mesa-pi-snapshot-${now}-${rand}.bak`;
}

export interface AgentSnapshotInfo {
  /** Basename of the file the snapshot was taken for. */
  targetBase: string;
  /** When the snapshot was taken (ms epoch, parsed from the filename). */
  timestamp: number;
}

/** Parse a basename produced by `buildAgentSnapshotPath`. Null for anything
 *  else, including Mesa's own save/backup/sync-temp artifact names. */
export function parseAgentSnapshotName(name: string): AgentSnapshotInfo | null {
  const m = SNAPSHOT_RE.exec(name);
  if (!m) return null;
  const timestamp = Number(m[2]);
  if (!Number.isFinite(timestamp)) return null;
  return { targetBase: m[1], timestamp };
}

export function isAgentSnapshotName(name: string): boolean {
  return SNAPSHOT_RE.test(name);
}

/** One snapshot artifact as seen by a directory walk. */
export interface FoundAgentSnapshot {
  /** Directory the artifact lives in (vault-relative or absolute, opaque). */
  dir: string;
  /** Basename, e.g. `.report.pdf.mesa-pi-snapshot-123-ab12.bak`. */
  name: string;
}

export type AgentSnapshotAction = { kind: "remove"; dir: string; name: string };

/**
 * Decide which stale snapshots to prune. Pure: no filesystem access.
 *
 * Groups artifacts by (dir, targetBase), newest first, and keeps at most
 * `keepPerFile`. Of those kept, also drops any older than `maxAgeMs` so a
 * lone ancient snapshot doesn't linger forever just because nothing newer
 * ever displaced it by count.
 */
export function planAgentSnapshotPrune(
  artifacts: FoundAgentSnapshot[],
  now: number,
  {
    keepPerFile = AGENT_SNAPSHOT_KEEP_PER_FILE,
    maxAgeMs = AGENT_SNAPSHOT_MAX_AGE_MS,
  }: { keepPerFile?: number; maxAgeMs?: number } = {}
): AgentSnapshotAction[] {
  const groups = new Map<
    string,
    { artifact: FoundAgentSnapshot; info: AgentSnapshotInfo }[]
  >();
  for (const artifact of artifacts) {
    const info = parseAgentSnapshotName(artifact.name);
    if (!info) continue;
    const key = `${artifact.dir}\0${info.targetBase}`;
    const list = groups.get(key);
    if (list) list.push({ artifact, info });
    else groups.set(key, [{ artifact, info }]);
  }

  const actions: AgentSnapshotAction[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => b.info.timestamp - a.info.timestamp);
    list.forEach(({ artifact, info }, index) => {
      const tooOld = now - info.timestamp > maxAgeMs;
      if (index >= keepPerFile || tooOld) {
        actions.push({ kind: "remove", dir: artifact.dir, name: artifact.name });
      }
    });
  }
  return actions;
}

/**
 * The newest snapshot for `targetBase` in `dir`, or null if none exists.
 * Used to offer (or perform) a restore after Pi's write corrupted a file.
 */
export function latestAgentSnapshot(
  artifacts: FoundAgentSnapshot[],
  dir: string,
  targetBase: string
): FoundAgentSnapshot | null {
  let best: { artifact: FoundAgentSnapshot; info: AgentSnapshotInfo } | null = null;
  for (const artifact of artifacts) {
    if (artifact.dir !== dir) continue;
    const info = parseAgentSnapshotName(artifact.name);
    if (!info || info.targetBase !== targetBase) continue;
    if (!best || info.timestamp > best.info.timestamp) best = { artifact, info };
  }
  return best?.artifact ?? null;
}
