import { privateImagePath, restoreImagePath } from "./vaultStorage";
import type { NoteMeta, Settings, VaultFile } from "../types";

const PREFIX = "mesa:graph-window:";

export interface GraphWindowBootstrap {
  vaultPath: string;
  vaultName: string;
  files: VaultFile[];
  notes: Record<string, NoteMeta>;
  settings: Partial<Settings>;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function saveGraphWindowBootstrap(
  id: string,
  snapshot: GraphWindowBootstrap,
  storage: StorageLike = localStorage
): boolean {
  try {
    storage.setItem(PREFIX + id, JSON.stringify({ ...snapshot, vaultPath: "", files: snapshot.files.map(file => ({ ...file, path: file.relPath })), notes: Object.fromEntries(Object.entries(snapshot.notes).map(([rel, note]) => [rel, { ...note, firstImagePath: privateImagePath(note.firstImagePath, snapshot.vaultPath) }])) }));
    return true;
  } catch {
    return false;
  }
}

export function consumeGraphWindowBootstrap(
  id: string,
  storage: StorageLike = localStorage,
  root?: string
): GraphWindowBootstrap | null {
  const key = PREFIX + id;
  try {
    const raw = storage.getItem(key);
    storage.removeItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as GraphWindowBootstrap;
    if (!root || !Array.isArray(value.files) || !value.notes) return null;
    return { ...value, vaultPath: root, files: value.files.map(file => ({ ...file, path: root.replace(/\/$/, "") + "/" + file.relPath })), notes: Object.fromEntries(Object.entries(value.notes).map(([rel, note]) => [rel, { ...note, firstImagePath: restoreImagePath(note.firstImagePath, root) }])) };
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      /* ignore unavailable storage */
    }
    return null;
  }
}

export function discardGraphWindowBootstrap(
  id: string,
  storage: StorageLike = localStorage
): void {
  try {
    storage.removeItem(PREFIX + id);
  } catch {
    /* ignore unavailable storage */
  }
}
