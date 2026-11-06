import type { SyncPeer } from "../types";
import type { SyncPhase, SyncReport } from "./sync";

/**
 * Sync problems that must stay visible outside the Sync modal. Background
 * auto-sync has no other surface, so a failure must not depend on the user
 * opening the modal to discover it.
 */
export interface SyncAttention {
  /** Short label for the status bar and tray; always starts with "Sync: ". */
  summary: string;
  /** Longer explanation for a tooltip or accessible name. */
  detail: string;
}

export interface SyncAttentionInput {
  syncEnabled: boolean;
  syncBusy: boolean;
  syncPhase: SyncPhase;
  syncStatus: string;
  syncReport: SyncReport | null;
  peers: readonly Pick<SyncPeer, "name" | "lastStatus" | "lastError">[];
}

/**
 * Returns the sync problem to show, or null when sync is healthy, off or busy.
 * Peer status is persisted, so a failed device stays flagged across restarts
 * until a later sync with it succeeds. A failure before any device was
 * contacted (missing key, local save failure) shows until the next attempt.
 */
export function syncAttention(input: SyncAttentionInput): SyncAttention | null {
  if (!input.syncEnabled || input.syncBusy) return null;
  const failed = input.peers.filter((peer) => peer.lastStatus === "error");
  if (failed.length === 1) {
    const [peer] = failed;
    return {
      summary: `Sync: failed with ${peer.name}`,
      detail: `Sync with ${peer.name} failed${peer.lastError ? `: ${peer.lastError}` : "."} Open Sync to retry.`,
    };
  }
  if (failed.length > 1) {
    return {
      summary: `Sync: failed with ${failed.length} devices`,
      detail: `Sync failed with ${failed.map((peer) => peer.name).join(", ")}. Open Sync to retry.`,
    };
  }
  if (input.syncPhase === "offline") {
    return {
      summary: "Sync: offline",
      detail: `${input.syncStatus || "Sync could not reach the device."} Open Sync to retry.`,
    };
  }
  if (input.syncPhase === "error") {
    return {
      summary: "Sync: stopped",
      detail: `${input.syncStatus || "Sync stopped."} Open Sync to fix it.`,
    };
  }
  const conflicts = input.syncPhase === "complete" ? input.syncReport?.conflicts ?? 0 : 0;
  if (conflicts > 0) {
    const copies = conflicts === 1 ? "1 conflict copy" : `${conflicts} conflict copies`;
    return {
      summary: `Sync: ${copies} to review`,
      detail: `The last sync kept ${copies} beside the originals. Open Sync to review them.`,
    };
  }
  return null;
}
