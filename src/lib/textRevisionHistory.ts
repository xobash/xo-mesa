export interface TextRevision {
  id: string;
  root: string;
  relPath: string;
  savedAt: number;
  content: string;
}

const STORAGE_KEY = "mesa:textRevisionHistory:v1";
const MAX_PER_FILE = 20;
const MAX_TOTAL_CHARS = 2_000_000;

function readAll(): TextRevision[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is TextRevision =>
        typeof entry?.id === "string" &&
        typeof entry.root === "string" &&
        typeof entry.relPath === "string" &&
        typeof entry.savedAt === "number" &&
        typeof entry.content === "string"
    );
  } catch {
    return [];
  }
}

function writeAll(entries: TextRevision[]): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    return true;
  } catch {
    // Revision history is a convenience copy, never part of the verified vault
    // transaction. Quota/private-mode failures must not retroactively turn a
    // byte-verified disk save into a failed save state.
    return false;
  }
}

function trim(entries: TextRevision[]): TextRevision[] {
  const newest = [...entries].sort(compareNewestFirst);
  const perFile = new Map<string, number>();
  const kept: TextRevision[] = [];
  let chars = 0;
  for (const entry of newest) {
    const key = `${entry.root}\0${entry.relPath}`;
    const count = perFile.get(key) ?? 0;
    if (count >= MAX_PER_FILE) continue;
    if (kept.length > 0 && chars + entry.content.length > MAX_TOTAL_CHARS) continue;
    kept.push(entry);
    perFile.set(key, count + 1);
    chars += entry.content.length;
  }
  return kept.sort(compareNewestFirst);
}

function compareNewestFirst(a: TextRevision, b: TextRevision): number {
  if (a.savedAt !== b.savedAt) return b.savedAt - a.savedAt;
  return b.id.localeCompare(a.id);
}

export function recordTextRevision(
  root: string,
  relPath: string,
  content: string,
  now = Date.now()
): TextRevision | null {
  if (!root || !relPath || !content) return null;
  const entries = readAll();
  const last = entries.find((entry) => entry.root === root && entry.relPath === relPath);
  if (last?.content === content) return null;
  const revision: TextRevision = {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    root,
    relPath,
    savedAt: now,
    content,
  };
  return writeAll(trim([revision, ...entries])) ? revision : null;
}

export function listTextRevisions(root: string, relPath: string): TextRevision[] {
  return readAll().filter((entry) => entry.root === root && entry.relPath === relPath);
}

export function clearTextRevisionsForTests(): void {
  if (typeof localStorage !== "undefined") localStorage.removeItem(STORAGE_KEY);
}
