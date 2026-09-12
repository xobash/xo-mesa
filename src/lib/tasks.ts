import { documentRevision, indexedDocumentTasks } from "./documentWorkingSet";
import { parseTasks, DUE_RE, type TaskItem, type TaskKind, type TaskBucket } from "./taskParsing";
export { parseTasks, classifyTask, taskProject, type TaskItem, type TaskKind, type TaskBucket } from "./taskParsing";

/** The note metadata `collectVaultTasks` reads (structural — see `NoteMeta`). */
export interface TaskNoteMeta {
  title: string;
}

interface TaskMemoEntry {
  revision: unknown;
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
    const revision = documentRevision(cache, rel);
    if (revision == null) continue;
    const title = notes[rel].title;
    const kind: TaskKind = rel === personalRel ? "personal" : "agent";
    const hit = taskMemo.get(rel);
    const tasks =
      hit && hit.revision === revision && hit.title === title && hit.kind === kind
        ? hit.tasks
        : (indexedDocumentTasks(cache, rel) ?? parseTasks(rel, title, cache[rel])).map((t) => ({ ...t, rel, noteTitle: title, kind }));
    next.set(rel, { revision, title, kind, tasks });
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
  const m = /^(\s*[-*]\s+\[)([ xX])(\]\s+)(\S(?:.*\S)?)(\s*)$/.exec(current);
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
