import { readTextFile } from "@tauri-apps/plugin-fs";
import { IN_TAURI } from "./vault";
import { readVaultBytes } from "./vaultByteRead";

/** Text of a saved page's local stylesheet. Native reads refuse files larger than `maxBytes`. */
export async function readSavedStylesheet(path: string, maxBytes: number): Promise<string> {
  if (!IN_TAURI) return readTextFile(path);
  return new TextDecoder().decode(await readVaultBytes(path, maxBytes, true));
}
