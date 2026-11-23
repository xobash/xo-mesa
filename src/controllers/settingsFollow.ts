import { isThemeId, isUiStyleId, THEME_KEY, UI_STYLE_KEY } from "../lib/persistedUi";
import { normalizeSettings, SETTINGS_KEY } from "../lib/settings";
import type { AppState } from "../storeTypes";
import type { Settings } from "../types";

type Store = { getState: () => AppState; setState: (patch: Partial<AppState>) => void };

// Sync credentials, peers and consent stay with the window that owns them.
const ownedKeys = (key: string) => key.startsWith("sync") || key === "peers" || key === "retiredSyncPeers";

const parse = (raw: string | null): Record<string, unknown> | null => {
  if (raw === null) return null;
  try { return normalizeSettings(JSON.parse(raw)) as unknown as Record<string, unknown>; } catch { return null; }
};
const same = (a: unknown, b: unknown) =>
  typeof a === "object" && a !== null ? JSON.stringify(a) === JSON.stringify(b) : Object.is(a, b);

/**
 * The settings another window changed, minus window-owned keys: keys whose
 * stored value differs between `oldRaw` and `newRaw`, and differs here. Only
 * the other window's own changes apply, so its stale copy of a key this
 * window changed since never reverts it. Without an old value, every key
 * that differs from `current` applies.
 */
export function settingsFromOtherWindow(current: Settings, newRaw: string, oldRaw: string | null = null): Partial<Settings> {
  const incoming = parse(newRaw);
  if (!incoming) return {};
  const previous = parse(oldRaw);
  const here = current as unknown as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (ownedKeys(key) || !(key in here)) continue;
    if (previous && same(previous[key], value)) continue;
    if (!same(value, here[key])) patch[key] = value;
  }
  return patch as Partial<Settings>;
}

/**
 * Follow theme, interface style and settings saved by another Mesa window
 * (the browser `storage` event fires only in the windows that did not write).
 * Applies in memory only, so nothing is written back.
 */
export function followOtherWindows(store: Store): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.newValue === null) return;
    if (event.key === THEME_KEY && isThemeId(event.newValue)) store.setState({ theme: event.newValue });
    else if (event.key === UI_STYLE_KEY && isUiStyleId(event.newValue)) store.setState({ uiStyle: event.newValue });
    else if (event.key === SETTINGS_KEY) {
      const patch = settingsFromOtherWindow(store.getState().settings, event.newValue, event.oldValue);
      if (Object.keys(patch).length > 0) store.setState({ settings: { ...store.getState().settings, ...patch } });
    }
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
