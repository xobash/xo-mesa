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

const TASK_RE = /^\s*[-*]\s+\[([ xX])\]\s+(.*\S)\s*$/;
// 📅 2026-07-01  |  @due(2026-07-01)  |  due: 2026-07-01
const DUE_RE =
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

/** The note metadata `collectVaultTasks` reads (structural — see `NoteMeta`). */
export interface TaskNoteMeta {
  title: string;
}

interface TaskMemoEntry {
  src: string;
  title: string;
  kind: TaskKind;
  tasks: TaskItem[];
}

/**
 * Per-note memo for `collectVaultTasks`. Rebuilt each call from the entries
 * still present, so notes deleted from the vault stop retaining their content.
 */
let taskMemo = new Map<string, TaskMemoEntry>();

/**
 * Every task in the vault, tagged personal (it lives in the user's tasks note)
 * or agent, in note order.
 *
 * The dashboard re-runs this whenever the content cache changes identity, which
 * is every debounced editor save — so a naive pass re-split and re-scanned the
 * WHOLE vault (measured: 15.2 ms at 2,000 notes / 8.6 MiB, 39.5 ms at 5,000)
 * at up to 2 Hz while typing, to recompute a result that differs in one note.
 * Each note's parse is therefore memoised on its exact content string, title,
 * and tag, so a save re-parses only the note that changed.
 *
 * Returned `TaskItem`s are SHARED across calls and must be treated read-only
 * (`groupTasks`/`bucketTask` only read; the dashboard filters into new arrays).
 */
export function collectVaultTasks(
  notes: Record<string, TaskNoteMeta>,
  cache: Record<string, string>,
  personalRel: string
): TaskItem[] {
  const next = new Map<string, TaskMemoEntry>();
  const out: TaskItem[] = [];
  for (const rel of Object.keys(notes)) {
    const src = cache[rel];
    if (src == null) continue;
    const title = notes[rel].title;
    const kind: TaskKind = rel === personalRel ? "personal" : "agent";
    const hit = taskMemo.get(rel);
    const tasks =
      hit && hit.src === src && hit.title === title && hit.kind === kind
        ? hit.tasks
        : parseTasks(rel, title, src).map((t) => ({ ...t, kind }));
    next.set(rel, { src, title, kind, tasks });
    for (const t of tasks) out.push(t);
  }
  taskMemo = next;
  return out;
}

/** Drop the memo — for tests, and whenever a vault is closed. */
export function resetVaultTaskMemo(): void {
  taskMemo = new Map();
}

export interface TaskLinePatch {
  checked?: boolean;
  due?: string | null;
}

function stripDue(text: string): string {
  return text
    .replace(DUE_RE, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function updateTaskLine(
  content: string,
  lineIndex: number,
  patch: TaskLinePatch
): string {
  const lines = content.split("\n");
  const current = lines[lineIndex];
  if (current == null) return content;
  const m = /^(\s*[-*]\s+\[)([ xX])(\]\s+)(.*\S)(\s*)$/.exec(current);
  if (!m) return content;
  const existingDue = DUE_RE.exec(m[4])?.[1] ?? null;
  const checked = patch.checked ?? m[2].toLowerCase() === "x";
  const due = patch.due === undefined ? existingDue : patch.due;
  const body = stripDue(m[4]);
  lines[lineIndex] =
    `${m[1]}${checked ? "x" : " "}${m[3]}${body}${due ? ` 📅 ${due}` : ""}${m[5]}`;
  return lines.join("\n");
}

export function bucketTask(t: TaskItem, todayISO: string): TaskBucket {
  if (t.checked) return "done";
  if (!t.due) return "noDue";
  if (t.due < todayISO) return "overdue";
  if (t.due === todayISO) return "today";
  return "upcoming";
}

export interface TaskGroups {
  overdue: TaskItem[];
  today: TaskItem[];
  upcoming: TaskItem[];
  noDue: TaskItem[];
  done: TaskItem[];
}

/** Group + sort tasks for the dashboard (dated buckets sorted by due date). */
export function groupTasks(tasks: TaskItem[], todayISO: string): TaskGroups {
  const g: TaskGroups = {
    overdue: [],
    today: [],
    upcoming: [],
    noDue: [],
    done: [],
  };
  for (const t of tasks) g[bucketTask(t, todayISO)].push(t);
  const byDue = (a: TaskItem, b: TaskItem) =>
    (a.due ?? "").localeCompare(b.due ?? "");
  g.overdue.sort(byDue);
  g.today.sort(byDue);
  g.upcoming.sort(byDue);
  return g;
}
