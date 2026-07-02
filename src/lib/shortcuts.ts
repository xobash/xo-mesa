type KeyLike = Pick<
  KeyboardEvent,
  "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey"
>;

type ClaimableEvent = Pick<KeyboardEvent, "preventDefault"> &
  Partial<Pick<KeyboardEvent, "stopImmediatePropagation" | "stopPropagation">>;

export type UndoRedoShortcutAction = "undo" | "redo";

export function isPlainShiftTab(e: KeyLike): boolean {
  return e.key === "Tab" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
}

export function isTextEntryTarget(el: Element | null): boolean {
  const target = el as HTMLElement | null;
  return (
    !!target &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable ||
      !!target.closest(".cm-editor") ||
      !!target.closest(".xterm"))
  );
}

export function undoRedoShortcutAction(e: KeyLike): UndoRedoShortcutAction | null {
  const key = e.key.toLowerCase();
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  if (key === "z") return e.shiftKey ? "redo" : "undo";
  if (key === "y") return "redo";
  return null;
}

export function claimKeyboardShortcut(e: ClaimableEvent): void {
  e.preventDefault();
  e.stopImmediatePropagation?.();
  e.stopPropagation?.();
}
