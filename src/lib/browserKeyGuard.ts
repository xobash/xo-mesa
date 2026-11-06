/** Browser shortcuts that would replace or leave Mesa's page.
 *
 * WebView2 (Windows) gives Ctrl+S, Ctrl+P, Ctrl+R, F5 and F7 browser actions:
 * Save page as, Print, Reload and caret browsing. A reload drops edits that
 * are still inside the autosave debounce, because `beforeunload` cannot wait.
 * The native settings (`src-tauri/src/webview_settings.rs`) turn those keys
 * off; this capture-phase guard is the second layer and also covers a
 * WebView2 runtime without the native setting. macOS never installs it. */

type KeyLike = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"> &
  Partial<Pick<KeyboardEvent, "getModifierState" | "target">>;

export type BrowserKeyAction = "save" | "palette" | "block";

/** Mesa's action for a browser-shortcut keydown on a Ctrl platform, or null
 * for any key the browser does not own. */
export function browserKeyAction(event: KeyLike): BrowserKeyAction | null {
  // AltGr reports Ctrl+Alt and types characters on many layouts.
  if (event.altKey || event.metaKey || event.getModifierState?.("AltGraph")) return null;
  const key = event.key;
  if (key === "F5" || key === "F7" || key === "BrowserRefresh") return "block";
  if (!event.ctrlKey) return null;
  const letter = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : key.toUpperCase();
  if (letter === "R") return "block";
  if (letter === "S" && !event.shiftKey) return "save";
  // The Pi terminal owns Ctrl+P (readline history); it only loses the print dialog.
  if (letter === "P") return inTerminal(event.target) ? "block" : "palette";
  return null;
}

function inTerminal(target: EventTarget | null | undefined): boolean {
  return !!(target as Element | null)?.closest?.(".xterm");
}

// Events whose only change is a cancelled browser default. Mesa's own
// handlers (user hotkeys) still run for them.
const browserDefaultOnly = new WeakSet<Event>();

/** True when only this guard cancelled the event's browser default. */
export function blockedOnlyBrowserDefault(event: Event): boolean {
  return browserDefaultOnly.has(event);
}

export interface BrowserKeyGuardOptions {
  /** Flush pending edits now (Ctrl+S). */
  onSave?: () => void;
  /** Open the command palette (Ctrl+P); without it Ctrl+P does nothing. */
  onPalette?: () => void;
}

/** Install the guard on `target` in the capture phase; returns the remover.
 * It never stops propagation, so the editor and the terminal still see keys. */
export function installBrowserKeyGuard(target: Window, options: BrowserKeyGuardOptions): () => void {
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    const action = browserKeyAction(event);
    if (!action) return;
    event.preventDefault();
    if (action === "palette" && options.onPalette) {
      if (!event.repeat) options.onPalette();
      return;
    }
    browserDefaultOnly.add(event);
    if (action === "save" && !event.repeat) options.onSave?.();
  };
  target.addEventListener("keydown", onKey, true);
  return () => target.removeEventListener("keydown", onKey, true);
}

/** Status after Ctrl+S flushed text saves, in the wording autosave uses.
 * PDF edits are not part of the text flush, so they are named. */
export function saveNowStatus(savedPaths: readonly string[], dirtyPdfs: readonly string[]): string {
  const text = savedPaths.length === 0 ? "All text is saved."
    : savedPaths.length === 1 ? `Saved ${savedPaths[0]}.` : `Saved ${savedPaths.length} notes.`;
  return dirtyPdfs.length ? `${text} PDF edits in ${dirtyPdfs.join(", ")} are not saved yet.` : text;
}
