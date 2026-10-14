import { IN_TAURI } from "./vault";

export interface ConfirmActionOptions {
  title?: string;
  okLabel?: string;
  cancelLabel?: string;
  kind?: "info" | "warning" | "error";
}

/** Await user consent; unavailable or failed dialogs deny the action. */
export async function confirmAction(message: string, options: ConfirmActionOptions = {}): Promise<boolean> {
  try {
    if (!IN_TAURI) {
      // eslint-disable-next-line no-restricted-properties -- The browser demo uses its synchronous dialog.
      return typeof window !== "undefined" && window.confirm(message) === true;
    }
    const { confirm } = await import("@tauri-apps/plugin-dialog");
    return (await confirm(message, { title: options.title ?? "Mesa", kind: options.kind ?? "warning",
      okLabel: options.okLabel ?? "OK", cancelLabel: options.cancelLabel ?? "Cancel" })) === true;
  } catch (error) {
    console.warn("Confirmation unavailable:", error);
    // Denying silently would look like an ignored click; say why nothing happened.
    const { useAppStore } = await import("../store");
    useAppStore.setState({ status: `Confirmation dialog unavailable, so nothing was changed: ${String(error)}` });
    return false;
  }
}
