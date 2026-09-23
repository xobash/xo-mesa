import { hasVaultMetadata, loadVaultMetadata } from "./vault";
import type { VaultFile } from "../types";

/**
 * Hydrate fallback directory metadata after first paint, then publish one
 * array replacement. Native scans already include this metadata, so they take
 * the fast path and avoid per-file stat calls.
 */
export async function hydrateVaultMetadata<State extends { vaultPath: string | null; files: readonly VaultFile[] }>(
  root: string,
  files: readonly VaultFile[],
  isCurrentOpen: () => boolean,
  get: () => State,
  set: (partial: Partial<State>) => void
): Promise<void> {
  if (!files.length || hasVaultMetadata(files)) return;
  await loadVaultMetadata(files, () => !isCurrentOpen());
  if (!isCurrentOpen() || get().vaultPath !== root || get().files !== files) return;
  set({ files: [...files] } as unknown as Partial<State>);
}
