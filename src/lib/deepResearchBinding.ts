/** Identity captured by a Deep Research run when it starts. */
export interface DeepResearchBinding {
  runId: string;
  vaultRoot: string | null;
  vaultGeneration: number;
}

/**
 * A run may publish results only while both its run identity and its vault
 * identity are still current. The generation check matters when a vault is
 * closed and reopened at the same path.
 */
export function isDeepResearchBindingCurrent(
  binding: DeepResearchBinding,
  runId: string,
  vaultRoot: string | null,
  vaultGeneration: number,
  activeVaultRoot: string | null,
  activeVaultGeneration: number
): boolean {
  return (
    binding.runId === runId &&
    binding.vaultRoot === vaultRoot &&
    binding.vaultGeneration === vaultGeneration &&
    activeVaultRoot === vaultRoot &&
    activeVaultGeneration === vaultGeneration
  );
}
