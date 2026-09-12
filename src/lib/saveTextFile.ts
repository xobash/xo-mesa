export interface TextFileSaveDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

export interface TextFileSaveApi {
  save(options: TextFileSaveDialogOptions): Promise<string | null>;
  writeTextFile(path: string, text: string): Promise<void>;
}

/** Save text through a user-selected path without touching the vault. */
export async function saveTextFile(
  text: string,
  options: TextFileSaveDialogOptions,
  api: TextFileSaveApi
): Promise<boolean> {
  const path = await api.save(options);
  if (!path) return false;
  await api.writeTextFile(path, text);
  return true;
}
