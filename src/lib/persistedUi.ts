import { canonicalRoot } from "./vault";

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

export function initialRecents(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    return raw.flatMap((value: unknown) => {
      if (typeof value !== "string") return [];
      const root = canonicalRoot(value);
      if (!root || seen.has(root)) return [];
      seen.add(root);
      return [root];
    });
  } catch {
    return [];
  }
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
