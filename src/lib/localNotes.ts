/**
 * Writes for the overlay surfaces that are NOT vault files.
 *
 * Almost everything the user types in Mesa lands in the vault through
 * `persistVerifiedBytes` (`verifiedWrite.ts`): verified backup, atomic rename,
 * byte-for-byte read-back. Two overlay surfaces are deliberately outside that —
 * the Scratchpad and the Whiteboard are browser-storage scratch space, not
 * notes. They do not sync, do not appear in search or the graph, and do not get
 * write recovery.
 *
 * That is a legitimate choice for scratch space. Losing it *silently* is not,
 * and `localStorage.setItem` fails silently in exactly the case that matters:
 * a full quota. This module makes the failure a value the caller must handle.
 *
 * It also bounds a single entry. Every Mesa key shares one origin quota, so an
 * unbounded whiteboard PNG could crowd out `mesa:settings`, `mesa:theme` and
 * `mesa:recentVaults` — losing the user's vault list to a doodle. A refused
 * oversized write keeps the previous value intact instead.
 *
 * Pure and dependency-free (`storage` is injectable) so the rules are testable
 * without a DOM.
 */

/** UTF-16 code units, which is what browsers actually bill against the quota —
 *  a 2-byte-per-character accounting, not UTF-8. */
export function localNoteBytes(value: string): number {
  return value.length * 2;
}

/**
 * Per-entry ceiling. Well above any real scratchpad or line-art whiteboard
 * (a 640x460 board of strokes serializes to tens of kB), and far below the
 * ~5 MB origin quota, so one surface can never consume the budget the app's
 * own settings depend on.
 */
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

/**
 * True for the "you are out of room" family.
 *
 * The engines Mesa ships on disagree on how they say it, and Mesa runs on all
 * three: WebView2/Chromium (Windows) throws `QuotaExceededError` with legacy
 * code 22, WKWebView/WebKit (macOS) throws `QuotaExceededError` and older
 * builds `QUOTA_EXCEEDED_ERR`, and WebKitGTK/Gecko-derived paths (Linux) use
 * `NS_ERROR_DOM_QUOTA_REACHED` with code 1014. Matching on only one of them is
 * how a "your board is full" notice becomes correct on one OS and absent on
 * another.
 */
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

/**
 * Write one overlay entry, reporting what happened instead of swallowing it.
 *
 * The size check runs BEFORE the write: discovering the ceiling by filling the
 * quota would already have evicted nothing (browsers reject rather than evict),
 * but it would leave the origin one keystroke away from failing every other
 * `mesa:` write too.
 */
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
