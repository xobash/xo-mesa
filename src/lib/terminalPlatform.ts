/** Windows conventions for the Pi terminal (xterm.js on a ConPTY).
 *
 * Copy writes the selection with the async Clipboard API, so it does not
 * depend on the webview firing `copy` on xterm's hidden textarea. Paste uses
 * the webview's native paste: when xterm skips the key, the browser pastes
 * into that textarea and xterm sends it (bracketed). That needs no
 * clipboard-read permission, which WebView2 would otherwise prompt for. */

type KeyLike = Pick<KeyboardEvent, "type" | "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

export type TerminalClipboardKey = "copy" | "paste" | null;

/** Clipboard meaning of a terminal keydown off macOS, or null when the key
 * goes to Pi. Ctrl+C copies only with a selection; without one it stays
 * SIGINT. macOS keeps Cmd+C / Cmd+V and sends every Ctrl chord to Pi. */
export function terminalClipboardKey(event: KeyLike, hasSelection: boolean, mac: boolean): TerminalClipboardKey {
  if (mac || event.type !== "keydown" || !event.ctrlKey || event.metaKey || event.altKey) return null;
  const letter = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : event.key.toUpperCase();
  if (letter === "V") return "paste";
  if (letter === "C" && !event.shiftKey && hasSelection) return "copy";
  return null;
}

/** Copy the terminal selection; clear it only once the clipboard holds it,
 * so a cleared selection always means a real copy. Returns the failure
 * message, or null on success. */
export async function copyTerminalSelection(
  term: { getSelection(): string; clearSelection(): void },
  clipboard: { writeText(text: string): Promise<void> } | undefined
): Promise<string | null> {
  const text = term.getSelection();
  if (!text) return null;
  if (!clipboard) return "Could not copy: this window has no clipboard access.";
  try {
    await clipboard.writeText(text);
  } catch (reason) {
    return `Could not copy the terminal selection: ${String(reason)}`;
  }
  term.clearSelection();
  return null;
}

/** xterm's `windowsPty` option for this webview, or undefined off Windows.
 *
 * xterm only compares the build number with 21376, where ConPTY started to
 * reflow on its own. Chromium's `platformVersion` major is 13 or more on
 * Windows 11 (builds 22000 and later) and 1-10 on Windows 10 (builds 19045
 * and earlier), so it decides that comparison without a native call. */
export async function windowsPtyOption(
  nav: { userAgent: string; userAgentData?: { getHighEntropyValues?: (hints: string[]) => Promise<{ platformVersion?: string }> } }
): Promise<{ backend: "conpty"; buildNumber?: number } | undefined> {
  if (!/Windows/.test(nav.userAgent)) return undefined;
  try {
    const values = await nav.userAgentData?.getHighEntropyValues?.(["platformVersion"]);
    const major = Number.parseInt(values?.platformVersion ?? "", 10);
    if (Number.isFinite(major) && major > 0) return { backend: "conpty", buildNumber: major >= 13 ? 22000 : 19045 };
  } catch {
    // Unknown version: xterm then assumes a current ConPTY.
  }
  return { backend: "conpty" };
}
