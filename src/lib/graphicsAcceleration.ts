import { invoke } from "@tauri-apps/api/core";
import { IN_TAURI } from "./vaultFs";

/** Native hardware acceleration preference (`src-tauri/src/graphics.rs`).
 *  It is read before the first webview, so it lives natively, not in
 *  Settings storage; a change applies from the next launch. */
export interface GraphicsState {
  /** Saved preference, used from the next launch. */
  saved: boolean;
  /** What this launch applied. */
  active: boolean;
  /** False where the platform offers no switch (macOS). */
  controllable: boolean;
}

export function normalizeGraphicsState(value: unknown): GraphicsState | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.saved !== "boolean" || typeof v.active !== "boolean" || typeof v.controllable !== "boolean") return null;
  return { saved: v.saved, active: v.active, controllable: v.controllable };
}

/** Current state, or null in the browser preview. */
export async function readGraphicsAcceleration(): Promise<GraphicsState | null> {
  if (!IN_TAURI) return null;
  return normalizeGraphicsState(await invoke("graphics_acceleration"));
}

/** Save for the next launch; resolves to the state native code confirmed. */
export async function saveGraphicsAcceleration(enabled: boolean): Promise<GraphicsState | null> {
  if (!IN_TAURI) return null;
  return normalizeGraphicsState(await invoke("graphics_acceleration", { enabled }));
}
