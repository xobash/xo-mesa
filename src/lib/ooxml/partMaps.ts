import { readEntryBytes, type ZipContainer, type ZipEntryRecord } from "./zipContainer";

// Read-only part maps that decode on demand. A package's parts are inflated
// and CRC-checked when first read, never at open, so pictures and other parts
// Mesa never shows cost nothing and a save copies them as raw ZIP records.
// Iterating entries or values reads (and checks) every part.

abstract class OnDemandMap implements ReadonlyMap<string, Uint8Array> {
  abstract get(name: string): Uint8Array | undefined;
  abstract has(name: string): boolean;
  abstract keys(): MapIterator<string>;
  abstract get size(): number;

  *entries(): MapIterator<[string, Uint8Array]> {
    for (const name of this.keys()) yield [name, this.get(name)!];
  }

  *values(): MapIterator<Uint8Array> {
    for (const name of this.keys()) yield this.get(name)!;
  }

  forEach(callback: (value: Uint8Array, key: string, map: ReadonlyMap<string, Uint8Array>) => void, thisArg?: unknown): void {
    for (const [name, bytes] of this.entries()) callback.call(thisArg, bytes, name, this);
  }

  [Symbol.iterator](): MapIterator<[string, Uint8Array]> {
    return this.entries();
  }
}

/** File entries of a validated container, decoded (bounded inflate + CRC-32) on first read and cached. */
export class PackagePartMap extends OnDemandMap {
  private readonly byName = new Map<string, ZipEntryRecord>();
  private readonly decoded = new Map<string, Uint8Array>();

  constructor(private readonly container: ZipContainer) {
    super();
    for (const entry of container.entries) if (!entry.isDirectory) this.byName.set(entry.name, entry);
  }

  get size(): number {
    return this.byName.size;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  keys(): MapIterator<string> {
    return this.byName.keys();
  }

  /** Throws `OoxmlPackageError` ("corrupt", "zipBomb") when the part fails its checks. */
  get(name: string): Uint8Array | undefined {
    const hit = this.decoded.get(name);
    if (hit) return hit;
    const entry = this.byName.get(name);
    if (!entry) return undefined;
    const bytes = readEntryBytes(this.container, entry);
    this.decoded.set(name, bytes);
    return bytes;
  }

  /** Whether a part has been decoded (for tests and diagnostics). */
  isDecoded(name: string): boolean {
    return this.decoded.has(name);
  }
}

/** `base` with `changes` applied (`null` removes a part); reads fall through to `base` lazily. */
export class OverlayPartMap extends OnDemandMap {
  private readonly added: string[];

  constructor(private readonly base: ReadonlyMap<string, Uint8Array>, private readonly changes: ReadonlyMap<string, Uint8Array | null>) {
    super();
    this.added = [...changes].filter(([name, bytes]) => bytes !== null && !base.has(name)).map(([name]) => name);
  }

  get size(): number {
    let removed = 0;
    for (const [name, bytes] of this.changes) if (bytes === null && this.base.has(name)) removed++;
    return this.base.size - removed + this.added.length;
  }

  has(name: string): boolean {
    return this.changes.has(name) ? this.changes.get(name) !== null : this.base.has(name);
  }

  *keys(): MapIterator<string> {
    for (const name of this.base.keys()) if (this.changes.get(name) !== null) yield name;
    yield* this.added;
  }

  get(name: string): Uint8Array | undefined {
    if (!this.changes.has(name)) return this.base.get(name);
    return this.changes.get(name) ?? undefined;
  }
}
