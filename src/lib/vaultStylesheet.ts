import { invoke } from "@tauri-apps/api/core";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { IN_TAURI } from "./vault";

/** Text of a saved page's local stylesheet. Native reads refuse files larger than `maxBytes`. */
export async function readSavedStylesheet(path: string, maxBytes: number): Promise<string> {
  if (!IN_TAURI) return readTextFile(path);
  const bytes = await invoke<ArrayBuffer>("vault_read_bytes", { path, maxBytes, requireComplete: true });
  return new TextDecoder().decode(new Uint8Array(bytes));
}
