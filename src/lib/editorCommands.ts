/** Commands the open note editor accepts from outside it (command palette,
 * template picker). The editor registers itself; callers never import
 * CodeMirror. Text inserted here takes the ordinary edit and save path. */
export interface EditorCommandTarget {
  /** Vault-relative path of the document the editor shows. */
  path: () => string | null;
  /** Open the in-note find and replace panel; false when no note is open. */
  openFind: () => boolean;
  /** Replace the selection with `text`; false when the note is not editable. */
  insertText: (text: string) => boolean;
}

const targets: EditorCommandTarget[] = [];

/** The most recently registered or focused editor wins. Returns the unregister function. */
export function registerEditorCommands(target: EditorCommandTarget): () => void {
  focusEditorCommands(target);
  return () => {
    const index = targets.indexOf(target);
    if (index >= 0) targets.splice(index, 1);
  };
}

export function focusEditorCommands(target: EditorCommandTarget): void {
  const index = targets.indexOf(target);
  if (index >= 0) targets.splice(index, 1);
  targets.push(target);
}

export function activeEditorCommands(): EditorCommandTarget | null {
  return targets[targets.length - 1] ?? null;
}
