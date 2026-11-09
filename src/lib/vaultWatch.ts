import { watch } from "@tauri-apps/plugin-fs";
import { Channel, invoke } from "@tauri-apps/api/core";
import { IN_TAURI } from "./vault";
import { DEMO_ROOT } from "./vaultDemo";

/** Longest delay before the plugin-watch fallback delivers a batch. */
export const WATCH_FALLBACK_MAX_WAIT_MS = 500;

/** A file change observed by the filesystem watcher. */
export interface VaultWatchEvent {
  /** Paths affected by the change: vault-relative from the native watcher,
   *  absolute from the plugin fallback or when outside the root. */
  paths: string[];
  /** Coarse kind: "create" (file or folder appeared), "modify" (data/metadata
   *  changed), "remove" (file or folder deleted). Falls back to "modify" when
   *  the underlying event kind is ambiguous. "rescan" (paths: the root) means
   *  events were lost to an overflow or watcher error; the vault needs one
   *  full rescan. */
  kind: "create" | "modify" | "remove" | "rescan";
}

/** Validate a batch delivered by the native `vault_watch` channel before it
 * reaches `handleExternalChange`. The Rust side already filtered and coalesced,
 * but a shape mismatch (an older/newer native build) must degrade to "ignore",
 * never feed a malformed event into the store. Returns the well-formed events,
 * or `null` when the message is not a usable batch. */
export function decodeWatchBatch(msg: unknown): VaultWatchEvent[] | null {
  if (!Array.isArray(msg)) return null;
  const out: VaultWatchEvent[] = [];
  for (const item of msg) {
    if (!item || typeof item !== "object") return null;
    const rec = item as { paths?: unknown; kind?: unknown };
    if (!Array.isArray(rec.paths)) return null;
    const paths = rec.paths.filter((p): p is string => typeof p === "string");
    if (!paths.length) continue;
    const kind =
      rec.kind === "create" || rec.kind === "remove" || rec.kind === "rescan" ? rec.kind : "modify";
    out.push({ paths, kind });
  }
  return out.length ? out : null;
}

/** Watch external changes through filtered native batches, with a plugin fallback.
 * Return teardown; browser demo is a no-op. */
export async function watchVault(
  root: string,
  onChange: (events: VaultWatchEvent[]) => void
): Promise<() => void> {
  if (!IN_TAURI || root.startsWith(DEMO_ROOT)) return () => {};

  // --- Native batching watcher (one message per window, .git filtered in Rust)
  try {
    const channel = new Channel<unknown>();
    channel.onmessage = (msg) => {
      const batch = decodeWatchBatch(msg);
      if (batch) onChange(batch);
    };
    const id = await invoke<number>("vault_watch", { root, onEvent: channel });
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      channel.onmessage = () => {};
      void invoke("vault_unwatch", { id }).catch(() => {});
    };
  } catch (e) {
    // Older native build without the command, or a start failure — fall back to
    // the plugin watcher so external-change detection still works.
    console.error("[mesa] native vault_watch unavailable, using plugin watch:", e);
  }

  // --- Fallback: tauri-plugin-fs `watch` (one IPC message per raw event) ------
  try {
    // Coalesce raw events into a batch with a coarse kind. The Tauri fs watcher
    // emits one event per path-change with a structured `type` describing the
    // nature of the change. We reduce this to create/modify/remove so the store
    // can decide how to react (add a file, refresh content, or delete it).
    const batch: VaultWatchEvent[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let batchStartedAt = 0;
    // Trailing 60 ms quiet window, flushed at the latest after the max wait so
    // a continuous event stream cannot postpone delivery indefinitely.
    const scheduleFlush = () => {
      const now = Date.now();
      if (flushTimer) clearTimeout(flushTimer);
      else batchStartedAt = now;
      const wait = Math.max(0, Math.min(60, batchStartedAt + WATCH_FALLBACK_MAX_WAIT_MS - now));
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        if (batch.length) {
          onChange(batch.splice(0));
        }
      }, wait);
    };
    const kindFromEvent = (event: {
      type?:
        | "any"
        | { create?: unknown }
        | { remove?: unknown }
        | { modify?: unknown }
        | string
        | object;
    }): VaultWatchEvent["kind"] => {
      const t = event?.type;
      if (typeof t === "string") return "modify"; // "any" | "other"
      if (t !== null && typeof t === "object") {
        if ("create" in t) return "create";
        if ("remove" in t) return "remove";
        if ("modify" in t) return "modify";
      }
      return "modify";
    };
    const stop = await watch(
      root,
      (event: { paths?: string[]; type?: unknown; attrs?: unknown }) => {
        const paths = Array.isArray(event?.paths) ? event.paths : [];
        // A pathless or rescan-flagged event means events were lost.
        const attrs = event?.attrs as { flag?: unknown } | null | undefined;
        if (!paths.length || attrs?.flag === "rescan") {
          batch.push({ paths: [root], kind: "rescan" });
        }
        if (paths.length) {
          batch.push({
            paths,
            kind: kindFromEvent(event as never),
          });
        }
        scheduleFlush();
      },
      { recursive: true, delayMs: 120 }
    );
    return () => {
      if (flushTimer) clearTimeout(flushTimer);
      stop();
    };
  } catch (e) {
    // Watcher setup failures remain visible to diagnostics without throwing.
    console.error("[mesa] watchVault failed to start:", e);
    return () => {};
  }
}
