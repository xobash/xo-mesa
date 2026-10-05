import type { NoteMeta, VaultFile } from "../types";

export interface ProposedOp {
  kind: "create" | "update";
  relPath: string;
  title: string;
  content: string;
  /** For updates: the exact bytes the file must still have at apply time. */
  expectedBytes?: string;
  /** New [[links]] this op introduces (for preview/dedup display). */
  addedLinks?: string[];
}

export interface ApplyStep {
  kind: "create" | "update";
  relPath: string;
  title: string;
  content: string;
  /** Update-only version check: bytes the file must still hold at apply time. */
  expectedBytes?: string;
  /** Snapshot of the file's bytes before the op (for rollback of updates). */
  originalContent?: string;
}

export interface RollbackStep {
  kind: "remove" | "restore";
  relPath: string;
  /** Restore-only: the bytes to put back. */
  content?: string;
}

export type ApplyPlan =
  | { ok: true; steps: ApplyStep[]; rollback: RollbackStep[] }
  | { ok: false; error: string; failedRelPath?: string };

function isSafeRelPath(rel: string): boolean {
  if (!rel || rel.includes("\\")) return false;
  const parts = rel.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) return false;
  return !rel.startsWith("/") && !/^[A-Za-z]:/.test(rel);
}

/** Validate the reviewed change set against the current in-memory vault snapshot. */
export function buildApplyPlan(input: {
  ops: ProposedOp[];
  existingContent: Record<string, string>;
  files: VaultFile[];
  notes: Record<string, NoteMeta>;
}): ApplyPlan {
  const known = new Set(input.files.map((file) => file.relPath));
  const steps: ApplyStep[] = [];
  const rollback: RollbackStep[] = [];
  for (const op of [...input.ops.filter((o) => o.kind === "create"), ...input.ops.filter((o) => o.kind === "update")]) {
    if (!isSafeRelPath(op.relPath)) return { ok: false, error: `Refusing unsafe vault path: ${op.relPath}`, failedRelPath: op.relPath };
    if (op.kind === "create") {
      steps.push({ kind: "create", relPath: op.relPath, title: op.title, content: op.content });
      rollback.unshift({ kind: "remove", relPath: op.relPath });
      continue;
    }
    if (!known.has(op.relPath) || !input.notes[op.relPath]) return { ok: false, error: `Note no longer exists: ${op.relPath}`, failedRelPath: op.relPath };
    const current = input.existingContent[op.relPath] ?? "";
    if (op.expectedBytes === undefined) return { ok: false, error: `Update is missing its version precondition: ${op.relPath}`, failedRelPath: op.relPath };
    if (current !== op.expectedBytes) return { ok: false, error: `"${op.relPath}" changed on disk since the proposal was made — review again.`, failedRelPath: op.relPath };
    steps.push({ kind: "update", relPath: op.relPath, title: op.title, content: op.content, expectedBytes: op.expectedBytes, originalContent: current });
    rollback.unshift({ kind: "restore", relPath: op.relPath, content: current });
  }
  return { ok: true, steps, rollback };
}
