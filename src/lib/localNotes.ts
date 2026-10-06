/** Bounded browser-storage staging for overlay drafts before explicit vault saves.
 * Storage failures are returned to the caller; refused writes preserve the previous value. */

/** UTF-16 code units, which is what browsers actually bill against the quota —
 *  a 2-byte-per-character accounting, not UTF-8. */
export function localNoteBytes(value: string): number {
  return value.length * 2;
}

/** Per-entry byte ceiling for browser-local overlay staging. */
export const LOCAL_NOTE_MAX_BYTES = 2 * 1024 * 1024;

export type LocalNoteWrite =
  | { ok: true }
  /** Too large for one entry, or the origin quota is full. Nothing was written
   *  and any previous value is still intact. */
  | { ok: false; reason: "too-large" | "quota"; bytes: number }
  /** No storage at all — private mode, a sandboxed webview, storage disabled. */
  | { ok: false; reason: "unavailable"; bytes: number };

/** Minimal slice of the Storage interface, so tests need no DOM. */
export interface LocalNoteStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Recognize quota errors by standard names and legacy WebKit/Gecko codes. */
export function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; code?: unknown };
  const name = typeof e.name === "string" ? e.name : "";
  if (
    name === "QuotaExceededError" ||
    name === "QUOTA_EXCEEDED_ERR" ||
    name === "NS_ERROR_DOM_QUOTA_REACHED"
  ) {
    return true;
  }
  return e.code === 22 || e.code === 1014;
}

function defaultStore(): LocalNoteStore | null {
  try {
    // Touching `localStorage` itself throws when storage is disabled, so the
    // access is inside the guard, not just the call.
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readLocalNote(key: string, store?: LocalNoteStore | null): string {
  const target = store === undefined ? defaultStore() : store;
  if (!target) return "";
  try {
    return target.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** Check size before writing and return an explicit result for refusal or storage failure. */
export function writeLocalNote(
  key: string,
  value: string,
  store?: LocalNoteStore | null
): LocalNoteWrite {
  const bytes = localNoteBytes(value);
  const target = store === undefined ? defaultStore() : store;
  if (!target) return { ok: false, reason: "unavailable", bytes };
  if (bytes > LOCAL_NOTE_MAX_BYTES) return { ok: false, reason: "too-large", bytes };
  try {
    target.setItem(key, value);
    return { ok: true };
  } catch (err) {
    if (isQuotaError(err)) return { ok: false, reason: "quota", bytes };
    return { ok: false, reason: "unavailable", bytes };
  }
}

/** What to show the user. Short, specific, and honest about where the content
 *  lives — a user who thinks this is a vault note deserves to learn otherwise
 *  at the moment it fails, not later. */
export function localNoteWriteMessage(result: LocalNoteWrite): string {
  if (result.ok) return "";
  if (result.reason === "too-large") {
    return "Too large to keep — this surface is browser scratch space, not a vault file. Clear it or move the content into a note.";
  }
  if (result.reason === "quota") {
    return "Out of browser storage — this change wasn't kept. Clear the whiteboard or an old scratchpad day, or move the content into a note.";
  }
  return "Browser storage is unavailable, so this change won't be kept between launches.";
}
