import { invoke } from "@tauri-apps/api/core";

export const VAULT_INDEX_STORAGE_VERSION = 5;
const namespaces = new Map<string, string>();
function desktop(): boolean { return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window; }
const opaque = (root: string) => /^vault:[0-9a-f]{64}$/.test(root);
/** Storage identity conveys no permission to open a root. */
export function vaultStorageId(root: string): string {
  if (!root || root.startsWith("mesa://") || opaque(root) || !desktop()) return root;
  const id = namespaces.get(root);
  if (!id) throw new Error("Private vault storage is not initialized");
  return id;
}
async function identify(root: string): Promise<string> {
  if (!root || root.startsWith("mesa://") || opaque(root)) return root;
  if (namespaces.has(root)) return namespaces.get(root)!;
  const id = await invoke<string>("vault_storage_id", { root });
  if (typeof id !== "string" || !opaque(id)) throw new Error("Invalid private vault storage identity");
  namespaces.set(root, id);
  return id;
}
let migration: Promise<void> | undefined;
/** Retain recovery bytes before removing legacy path-bearing keys/records. */
export async function initializeVaultStorage(root = ""): Promise<void> {
  if (!desktop() || root.startsWith("mesa://")) return;
  if (root) await identify(root);
  if (!migration) migration = migrateLegacyStorage().catch(error => { migration = undefined; throw error; });
  await migration;
}
async function migrateLegacyStorage(): Promise<void> {
  await discardLegacyIndexStorage();
  const history = await import("./textRevisionHistory");
  const roots = await history.legacyRevisionRoots();
  const drafts: Array<{ key: string; root: string; rel: string; value: string }> = [];
  for (let n = 0; n < localStorage.length; n++) {
    const key = localStorage.key(n);
    if (!key?.startsWith("mesa:overlay-draft:")) continue;
    const parts: unknown = JSON.parse(key.slice("mesa:overlay-draft:".length));
    if (!Array.isArray(parts) || typeof parts[0] !== "string" || typeof parts[1] !== "string" || opaque(parts[0])) continue;
    const value = localStorage.getItem(key);
    if (value !== null) { drafts.push({ key, root: parts[0], rel: parts[1], value }); roots.add(parts[0]); }
  }
  for (const root of roots) await identify(root);
  await history.migrateRevisionNamespaces(vaultStorageId);
  for (const draft of drafts) {
    const key = `mesa:overlay-draft:${JSON.stringify([vaultStorageId(draft.root), draft.rel])}`;
    const existing = localStorage.getItem(key);
    // Preserve a conflicting older copy as recovery data under an opaque key.
    if (existing !== null && existing !== draft.value) {
      localStorage.setItem(key.replace("mesa:overlay-draft:", "mesa:overlay-draft-recovery:"), draft.value);
    } else localStorage.setItem(key, draft.value);
    localStorage.removeItem(draft.key);
  }
  // These snapshots are disposable, unlike authored drafts/history.
  for (let n = localStorage.length - 1; n >= 0; n--) {
    const key = localStorage.key(n);
    if (key?.startsWith("mesa:graph-window:")) localStorage.removeItem(key);
  }
}

/** Store image metadata relative to its owning root; authored text is unchanged. */
export function privateImagePath(path: string | undefined, root: string): string | undefined {
  if (!path) return undefined;
  return path.startsWith(root.replace(/\\/g, "/").replace(/\/$/, "") + "/")
    ? "mesa-relative:" + path.slice(root.length + 1) : undefined;
}
export function restoreImagePath(path: string | undefined, root: string): string | undefined {
  return path?.startsWith("mesa-relative:") ? root.replace(/\/$/, "") + "/" + path.slice(14) : path;
}

/** Delete only obsolete disposable indexes; retain opaque-ID caches across starts. */
export async function discardLegacyIndexStorage(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { settled = true; reject(new Error("Index privacy migration timed out")); }, 2000);
    const complete = (error?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const request = indexedDB.open("mesa-vault-index");
    request.onerror = () => complete(request.error);
    request.onblocked = () => complete(new Error("Index privacy migration blocked"));
    request.onsuccess = () => {
      const db = request.result;
      const legacy = db.version < VAULT_INDEX_STORAGE_VERSION;
      db.close();
      if (settled) return;
      if (!legacy) { complete(); return; }
      const removal = indexedDB.deleteDatabase("mesa-vault-index");
      removal.onsuccess = () => complete(); removal.onerror = () => complete(removal.error);
      removal.onblocked = () => complete(new Error("Index privacy migration blocked"));
    };
  });
}
