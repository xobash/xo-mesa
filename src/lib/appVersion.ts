import { IN_TAURI } from "./vaultFs";

/** The running Mesa version, or "dev" in the browser demo or when the shell
 *  cannot report it. Never throws. */
export async function appVersion(): Promise<string> {
  if (!IN_TAURI) return "dev";
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return "dev";
  }
}
