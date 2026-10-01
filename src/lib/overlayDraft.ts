import { readLocalNote, writeLocalNote, type LocalNoteWrite } from "./localNotes";

export interface OverlayDraft {
  version: 1;
  content: string;
  /** undefined means the disk baseline has not yet been read. */
  baseline?: string | null;
  dirty: boolean;
}

export function overlayDraftKey(root: string | null, rel: string): string {
  return `mesa:overlay-draft:${JSON.stringify([root, rel])}`;
}

const unsavedMemory = new Map<string, OverlayDraft>();

export function readOverlayDraft(key: string): OverlayDraft | null {
  const retained = unsavedMemory.get(key);
  if (retained) return retained;
  try {
    const value = JSON.parse(readLocalNote(key));
    if (value?.version !== 1 || typeof value.content !== "string" || typeof value.dirty !== "boolean") return null;
    if (value.baseline !== undefined && value.baseline !== null && typeof value.baseline !== "string") return null;
    return value;
  } catch { return null; }
}

export function writeOverlayDraft(key: string, draft: OverlayDraft): LocalNoteWrite {
  const result = writeLocalNote(key, JSON.stringify(draft));
  if (result.ok) unsavedMemory.delete(key);
  else unsavedMemory.set(key, draft);
  return result;
}

export interface BoardStroke { color: string; points: Array<[number, number]> }
export interface BoardDocument { version: 1; background?: string; strokes: BoardStroke[] }
export function parseBoardDocument(content: string): BoardDocument {
  if (!content) return { version: 1, strokes: [] };
  // Legacy local raster drafts remain available as an editable background.
  if (content.startsWith("data:image/")) return { version: 1, background: content, strokes: [] };
  const value = JSON.parse(content);
  if (value?.version !== 1 || !Array.isArray(value.strokes) ||
      (value.background !== undefined && (typeof value.background !== "string" || !value.background.startsWith("data:image/"))) ||
      !value.strokes.every((stroke: BoardStroke) => typeof stroke?.color === "string" && Array.isArray(stroke.points) &&
        stroke.points.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)))) {
    throw new Error("This board document is invalid. Its original bytes have been preserved.");
  }
  return value;
}
