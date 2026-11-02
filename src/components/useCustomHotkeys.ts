import { useEffect } from "react";
import { getStore } from "../store";
import { commandForEvent } from "../lib/hotkeys";

/** Run a palette command when its user-assigned chord is pressed. Capture
 * phase, so a user binding wins over the editor's own keymap; reserved Mesa
 * chords can never be assigned (lib/hotkeys.ts). The hotkey recorder in
 * Settings marks itself with `data-hotkey-recorder` and is left alone. */
export function useCustomHotkeys(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      const hotkeys = getStore().settings.hotkeys;
      if (!hotkeys || !Object.keys(hotkeys).length) return;
      if ((event.target as Element | null)?.closest?.("[data-hotkey-recorder]")) return;
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
