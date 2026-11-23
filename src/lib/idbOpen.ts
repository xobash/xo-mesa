/**
 * Open a disposable IndexedDB cache with a time limit. A connection that
 * opens after the limit, a block or an error is closed at once, and an open
 * connection closes when another tab upgrades the database, so no caller
 * holds a handle nothing will close.
 */
export function openIdbWithTimeout(
  name: string,
  version: number,
  upgrade: (db: IDBDatabase, transaction: IDBTransaction) => void,
  label: string,
  timeoutMs = 2000
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error(`${label} unavailable`)); return; }
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); reject(error);
    };
    const request = indexedDB.open(name, version);
    const timer = setTimeout(() => fail(new Error(`${label} timed out`)), timeoutMs);
    // The version-change transaction lets an upgrade amend an existing store.
    request.onupgradeneeded = () => upgrade(request.result, request.transaction!);
    request.onblocked = () => fail(new Error(`${label} blocked`));
    request.onerror = () => fail(request.error);
    request.onsuccess = () => {
      const db = request.result;
      if (settled) { db.close(); return; }
      settled = true; clearTimeout(timer);
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}
