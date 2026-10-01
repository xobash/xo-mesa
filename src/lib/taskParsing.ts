/**
 * Vault-wide task extraction: every `- [ ]` / `- [x]` checkbox across all
 * notes, with optional due dates, bucketed into Overdue / Today / Upcoming /
 * No date / Done — the core of an Obsidian "Tasks"-style dashboard.
 */
export type TaskKind = "agent" | "personal";

export interface TaskItem {
  rel: string;
  noteTitle: string;
  line: number;
  text: string;
  checked: boolean;
  due: string | null; // YYYY-MM-DD
  /** Whether the task is for an AI agent or for the person. */
  kind: TaskKind;
}
export type TaskBucket = "overdue" | "today" | "upcoming" | "noDue" | "done";

// Require a non-whitespace body start. Otherwise a blank checkbox retries
// the greedy body scan for every separator space (quadratic UI-thread work).
const TASK_RE = /^\s*[-*]\s+\[([ xX])\]\s+(\S(?:.*\S)?)\s*$/;
// 📅 2026-07-01  |  @due(2026-07-01)  |  due: 2026-07-01
export const DUE_RE =
  /(?:📅\s*|@due\(|\bdue:\s*)(\d{4}-\d{2}-\d{2})\)?/;
// Mark a task as an agent's with #agent, @agent, or 🤖.
const AGENT_RE = /(?:#agent\b|@agent\b|🤖)/i;

/** Classify a task as agent-owned or personal from inline markers. */
export function classifyTask(text: string): TaskKind {
  return AGENT_RE.test(text) ? "agent" : "personal";
}

/**
 * The folder/project a task is inherited from — the parent directory of the note
 * it lives in, or "" at the vault root. Surfaced in the dashboard so you can see
 * which project a task came from at a glance.
 */
export function taskProject(rel: string): string {
  const norm = rel.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i < 0 ? "" : norm.slice(0, i);
}

export function parseTasks(
  rel: string,
  noteTitle: string,
  content: string
): TaskItem[] {
  const out: TaskItem[] = [];
  let inFence = false;
  const lines = content.split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = TASK_RE.exec(line);
    if (!m) continue;
    const dueMatch = DUE_RE.exec(m[2]);
    out.push({
      rel,
      noteTitle,
      line: lineIndex,
      text: m[2].trim(),
      checked: m[1].toLowerCase() === "x",
      due: dueMatch ? dueMatch[1] : null,
      kind: classifyTask(m[2]),
    });
  }
  return out;
}
