import { initializeVaultStorage } from "./vaultStorage";
import { invoke } from "@tauri-apps/api/core";

export const LAST_VAULT_KEY = "mesa:lastVault";
export const THEME_KEY = "mesa:theme";
export const RECENTS_KEY = "mesa:recentVaults";
export const MAX_RECENTS = 8;

export const THEME_IDS = [
  "system",
  "void",
  "darkroom",
  "graphite",
  "midnight",
  "ember",
  "dusk",
  "fjord",
  "paper",
] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}

export interface RecentVault { id: string; label: string }
export interface RecentVaultState { entries: RecentVault[]; last: string | null }

export function initialRecents(): RecentVault[] { return []; }

/** Migrate only roots accepted by the native approval record, then erase legacy paths. */
export async function loadRecentVaults(): Promise<RecentVaultState> {
  await initializeVaultStorage();
  let state = await invoke<RecentVaultState>("vault_recents", { action: "list" });
  let legacy: unknown = [];
  try { legacy = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]"); } catch { /* Invalid legacy metadata is discarded after native load. */ }
  const last = localStorage.getItem(LAST_VAULT_KEY);
  const roots = Array.isArray(legacy) ? legacy.filter((r): r is string => typeof r === "string") : [];
  if (last) roots.unshift(last);
  for (const root of [...new Set(roots)].slice(0, MAX_RECENTS).reverse()) {
    try { state = await rememberRecentVaultNative(root); }
    catch (error) {
      if (!String(error).includes("vault folder has not been selected") && !String(error).includes("vault root is unavailable")) throw error;
    }
  }
  localStorage.removeItem(RECENTS_KEY);
  localStorage.removeItem(LAST_VAULT_KEY);
  return state;
}
export function rememberRecentVaultNative(root: string): Promise<RecentVaultState> {
  return invoke("vault_recents", { action: "remember", root });
}
export function forgetRecentVaultNative(id?: string): Promise<RecentVaultState> {
  return invoke("vault_recents", { action: id ? "forget" : "clear", id });
}
export function resolveRecentVault(id: string): Promise<string> {
  return invoke("vault_recent_resolve", { id });
}

export function initialTheme(): ThemeId {
  try {
    const value = localStorage.getItem(THEME_KEY);
    if (isThemeId(value)) return value;
  } catch {
    // Use the system default.
  }
  return "system";
}
