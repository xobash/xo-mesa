import { useEffect } from "react";
import { getStore } from "../store";
import { commandForEvent, hotkeyFromEvent, terminalOwnsChord } from "../lib/hotkeys";
import { blockedOnlyBrowserDefault } from "../lib/browserKeyGuard";

/** Run a palette command when its user-assigned chord is pressed. Capture
 * phase, so a user binding wins over the editor's own keymap; reserved Mesa
 * chords can never be assigned (lib/hotkeys.ts). The hotkey recorder in
 * Settings marks itself with `data-hotkey-recorder` and is left alone, and
 * off macOS the Pi terminal keeps the Ctrl chords readline uses. */
export function useCustomHotkeys(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.defaultPrevented && !blockedOnlyBrowserDefault(event)) || event.repeat || event.isComposing) return;
      const hotkeys = getStore().settings.hotkeys;
      if (!hotkeys || !Object.keys(hotkeys).length) return;
      const target = event.target as Element | null;
      if (target?.closest?.("[data-hotkey-recorder]")) return;
      if (target?.closest?.(".xterm") && terminalOwnsChord(hotkeyFromEvent(event) ?? "")) return;
      const id = commandForEvent(hotkeys, event);
      if (!id) return;
      event.preventDefault();
      event.stopPropagation();
      // The command list loads on first use; it is shared with the palette chunk.
      void import("./paletteCommands").then(({ PALETTE_COMMANDS }) => PALETTE_COMMANDS.find((item) => item.id === id)?.run());
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled]);
}
