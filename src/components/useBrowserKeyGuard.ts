import { useEffect } from "react";
import { getStore, useAppStore } from "../store";
import { installBrowserKeyGuard, saveNowStatus } from "../lib/browserKeyGuard";
import { IS_MAC } from "../lib/hotkeys";

/** Ctrl+S: flush pending text saves now and say so in the status bar. A
 * failure keeps the save issue's "Save failed" status and its Retry. */
export function saveNow(): void {
  const store = getStore();
  const paths = store.pendingTextSaves().map((snapshot) => snapshot.target.relPath);
  void store.flushSave().then(
    () => useAppStore.setState({ status: saveNowStatus(paths, getStore().dirtyBinaryPaths) }),
    (reason) => {
      if (!getStore().status.startsWith("Save failed")) useAppStore.setState({ status: `Save failed: ${String(reason)}` });
    }
  );
}

/** Keep browser shortcuts from saving, printing or reloading the page in
 * every Mesa window off macOS. Ctrl+P opens the palette only in main. */
export function useBrowserKeyGuard(mainWindow: boolean, enabled = !IS_MAC): void {
  useEffect(() => {
    if (!enabled) return;
    return installBrowserKeyGuard(window, {
      onSave: saveNow,
      onPalette: mainWindow ? () => getStore().setPalette(true) : undefined,
    });
  }, [mainWindow, enabled]);
}
