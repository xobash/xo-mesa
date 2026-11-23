import { createDocxEditor, type DocxEditorInstance, type EditorCommand } from "@docx-editor.dev/core";
import "@docx-editor.dev/core/styles/editor.css";

// The only importer of the Word layout and editing engine. Loaded on demand
// (`import("./wordEngine")`) when a Word file opens, so the engine stays out
// of the entry chunk. No font sources are configured: text measures with the
// engine's built-in estimate and nothing is fetched.

export type WordCommand =
  | { type: "undo" } | { type: "redo" }
  | { type: "toggleMark"; mark: "bold" | "italic" | "underline" | "strike" }
  | { type: "setAlignment"; align: "left" | "center" | "right" | "justify" }
  | { type: "toggleList"; kind: "bullet" | "ordered" }
  | { type: "insertRow"; where: "above" | "below" }
  | { type: "insertColumn"; where: "left" | "right" };

export type WordImageMime = "image/png" | "image/jpeg" | "image/gif";

export interface WordFormatting {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  alignment: "left" | "center" | "right" | "both" | null;
  inTable: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

export interface WordSurface {
  /** Locks or unlocks editing; returns the engine's reason when it refuses. */
  setEditing(editing: boolean): string | null;
  /** Serialized package of the current document. */
  save(): Promise<Uint8Array>;
  run(command: WordCommand): string | null;
  insertImage(bytes: Uint8Array, mime: WordImageMime, widthPoints: number, heightPoints: number): Promise<string | null>;
  formatting(): WordFormatting;
  destroy(): void;
}

export interface WordSurfaceEvents {
  /** A committed document change (never a selection move). */
  onChange(): void;
  onSelection(): void;
}

function reasonOf(result: { ok: boolean; reason?: string }): string | null {
  return result.ok ? null : result.reason ?? "The editor refused this change.";
}

function collapseSelection(editor: DocxEditorInstance): void {
  const range = editor.getSelectionRange();
  if (range && "head" in range) editor.exec({ type: "setSelection", range: { anchor: range.head, head: range.head } });
}

/** Mounts a document in `container`, locked for viewing until `setEditing(true)`. */
export function mountWordSurface(container: HTMLElement, bytes: Uint8Array, events: WordSurfaceEvents): WordSurface {
  const editor = createDocxEditor({ container, document: bytes.slice(), mode: "edit" });
  const locked = editor.exec({ type: "setEditingMode", mode: "viewing" });
  if (!locked.ok) {
    editor.destroy();
    throw new Error(`The Word view could not be locked for reading: ${locked.reason}`);
  }
  const unsubscribe = [
    editor.on("change", (change) => { if (!change.source) events.onChange(); }),
    editor.on("selectionChange", () => events.onSelection()),
  ];
  return {
    setEditing: (editing) => reasonOf(editor.exec({ type: "setEditingMode", mode: editing ? "editing" : "viewing" })),
    save: async () => new Uint8Array(await editor.save()),
    run: (command) => reasonOf(editor.exec(command as EditorCommand)),
    insertImage: async (data, mime, widthPoints, heightPoints) => {
      collapseSelection(editor);
      return reasonOf(await editor.executeImageCommand({ type: "insertImage", data, mime, widthPoints, heightPoints }));
    },
    formatting: () => {
      const snapshot = editor.snapshot();
      const f = snapshot.formatting;
      return {
        bold: !!f?.bold, italic: !!f?.italic, underline: !!f?.underline, strike: !!f?.strike,
        alignment: f?.alignment ?? null, inTable: !!snapshot.table, canUndo: !!snapshot.canUndo, canRedo: !!snapshot.canRedo,
      };
    },
    destroy: () => {
      for (const off of unsubscribe) off();
      editor.destroy();
    },
  };
}
