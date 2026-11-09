import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { isPlainShiftTab } from "../../lib/shortcuts";
import { trapDialogFocus } from "../Modal";

/** Overlay dialogs trap Tab but let plain Shift+Tab reach the overlay toggle. */
export function trapOverlayFocus(e: ReactKeyboardEvent<HTMLElement>): void {
  if (isPlainShiftTab(e)) return;
  trapDialogFocus(e.currentTarget, e);
}
