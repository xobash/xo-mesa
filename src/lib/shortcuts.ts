type KeyLike = Pick<
  KeyboardEvent,
  "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey"
>;

type ShiftTabKeyLike = KeyLike &
  Partial<Pick<KeyboardEvent, "code" | "repeat" | "timeStamp" | "type">>;

type ClaimableEvent = Pick<KeyboardEvent, "preventDefault"> &
  Partial<Pick<KeyboardEvent, "stopImmediatePropagation" | "stopPropagation">>;

export type UndoRedoShortcutAction = "undo" | "redo";

let shiftTabTabDown = false;
let shiftTabChordClaimed = false;
let shiftTabLastClaimAt: number | null = null;

const STALE_SHIFT_TAB_KEYUP_MS = 40;

function isTabKey(e: ShiftTabKeyLike): boolean {
  return e.key === "Tab" || e.code === "Tab";
}

export function isPlainShiftTab(e: ShiftTabKeyLike): boolean {
  return isTabKey(e) && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
}

/** One discoverable keyboard gesture for moving a Mesa surface across the
 * app/native-window boundary. The same chord tears a focused surface out and
 * docks a detached surface back, so the action does not drift by host. */
export function isWindowTransferShortcut(e: KeyLike): boolean {
  return (
    e.key === "Enter" &&
    e.shiftKey &&
    (e.metaKey || e.ctrlKey) &&
    !e.altKey
  );
}

/** Return true only for the first valid keydown in one physical chord. */
export function claimPlainShiftTabToggle(e: ShiftTabKeyLike): boolean {
  // xterm's custom key handler can receive both phases. A shortcut is a
  // physical press, so a matching keyup must never become a second toggle.
  if (e.type && e.type !== "keydown") return false;
  if (!isPlainShiftTab(e)) return false;
  const eventTime = typeof e.timeStamp === "number" ? e.timeStamp : null;
  const staleClaim =
    !e.repeat &&
    shiftTabTabDown &&
    shiftTabChordClaimed &&
    eventTime != null &&
    shiftTabLastClaimAt != null &&
    eventTime - shiftTabLastClaimAt > STALE_SHIFT_TAB_KEYUP_MS;

  shiftTabTabDown = true;
  if (e.repeat || (shiftTabChordClaimed && !staleClaim)) return false;
  shiftTabChordClaimed = true;
  shiftTabLastClaimAt = eventTime;
  return true;
}

export function notePlainShiftTabKeyUp(e: ShiftTabKeyLike): void {
  if (isTabKey(e)) {
    shiftTabTabDown = false;
    shiftTabChordClaimed = false;
    shiftTabLastClaimAt = null;
  }
}

export function resetPlainShiftTabChord(): void {
  shiftTabTabDown = false;
  shiftTabChordClaimed = false;
  shiftTabLastClaimAt = null;
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
