import { RANGE_READ_MAX_BYTES, type RangeRead, type RangeReader } from "./byteSource";
import { bytesToHex } from "./hex";

/** Read-only hex view arithmetic: rows, scroll mapping and a bounded cache of
 *  file windows. No file access happens here. */

export const HEX_ROW_BYTES = 16;
export const HEX_ROW_HEIGHT = 20;
/** Tallest scroll spacer; larger row counts map scroll position proportionally
 *  so a multi-GB row count never exceeds browser element limits. */
export const HEX_MAX_SCROLL_PX = 4_000_000;

export interface HexRow {
  offset: string;
  hex: string;
  ascii: string;
}

/** Offset (at least 8 hex digits), spaced hex pairs, printable ASCII or ".". */
/** Eight-digit lowercase hex offset, as the gutter shows it. */
export function formatHexOffset(offset: number): string {
  return offset.toString(16).padStart(8, "0");
}

export function formatHexRow(offset: number, bytes: Uint8Array): HexRow {
  const pairs = bytesToHex(bytes).match(/../g) ?? [];
  let ascii = "";
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    ascii += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : ".";
  }
  const hex = pairs.slice(0, 8).join(" ") + (pairs.length > 8 ? "  " + pairs.slice(8).join(" ") : "");
  return { offset: formatHexOffset(offset), hex, ascii };
}

export interface HexWindow {
  start: number;
  end: number;
  /** Height of the scroll spacer. */
  spacerHeight: number;
  /** Top of the first rendered row inside the spacer. */
  top: number;
}

/** Rows to render for a scroll position. Above `HEX_MAX_SCROLL_PX` the spacer
 *  is capped and scroll position maps linearly onto the row range. */
export function hexWindow(rowCount: number, scrollTop: number, viewportHeight: number, rowHeight = HEX_ROW_HEIGHT, overscan = 8): HexWindow {
  if (rowCount <= 0 || viewportHeight <= 0) return { start: 0, end: 0, spacerHeight: Math.max(0, rowCount) * rowHeight, top: 0 };
  const natural = rowCount * rowHeight;
  const spacerHeight = Math.min(natural, HEX_MAX_SCROLL_PX);
  const visible = Math.ceil(viewportHeight / rowHeight);
  const maxScroll = Math.max(1, spacerHeight - viewportHeight);
  const fraction = Math.min(1, Math.max(0, scrollTop / maxScroll));
  const firstVisible = natural === spacerHeight
    ? Math.floor(Math.max(0, scrollTop) / rowHeight)
    : Math.round(fraction * Math.max(0, rowCount - visible));
  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(rowCount, firstVisible + visible + overscan);
  const top = natural === spacerHeight ? start * rowHeight : Math.max(0, scrollTop) - (firstVisible - start) * rowHeight;
  return { start, end, spacerHeight, top };
}

/** One window is one native range read; a multiple of the row size, so no
 *  row straddles two windows. */
export const HEX_WINDOW_BYTES = RANGE_READ_MAX_BYTES;
/** Windows kept (8 MiB in all); the least recently used one goes first. */
export const HEX_CACHE_WINDOWS = 8;

/**
 * A least-recently-used cache of 1 MiB windows at any offset. Concurrent
 * requests for one window share one read. A read that sees a new file
 * version drops every window and sets `changed`; a reply to a read issued
 * before that is dropped too.
 */
export class ByteWindowCache {
  private readonly windows = new Map<number, Uint8Array>();
  private readonly pending = new Map<number, Promise<void>>();
  private generation = 0;
  size: number;
  private stamp: string;
  /** True once a read saw a different file version than the first read. */
  changed = false;

  constructor(private readonly read: RangeReader, first: RangeRead) {
    this.size = first.size;
    this.stamp = first.stamp;
    if (first.bytes.length > 0) this.windows.set(0, first.bytes.subarray(0, HEX_WINDOW_BYTES));
  }

  get windowCount(): number {
    return this.windows.size;
  }

  private span(start: number, end: number): number[] {
    const first = Math.floor(Math.max(0, start) / HEX_WINDOW_BYTES);
    const last = Math.floor((Math.max(start + 1, Math.min(end, this.size)) - 1) / HEX_WINDOW_BYTES);
    const out: number[] = [];
    for (let index = first; index <= last && out.length < HEX_CACHE_WINDOWS; index++) out.push(index);
    return out;
  }

  private complete(index: number): boolean {
    const bytes = this.windows.get(index);
    const expected = Math.min(HEX_WINDOW_BYTES, this.size - index * HEX_WINDOW_BYTES);
    return bytes !== undefined && bytes.length >= expected;
  }

  /** True when every byte of `[start, end)` inside the file is cached. */
  has(start: number, end: number): boolean {
    if (start >= this.size) return true;
    return this.span(start, end).every((index) => this.complete(index));
  }

  /** Cached bytes from `start`, within one row's window; may be short. */
  slice(start: number, end: number): Uint8Array {
    const index = Math.floor(start / HEX_WINDOW_BYTES);
    const bytes = this.windows.get(index);
    if (!bytes) return new Uint8Array();
    const base = index * HEX_WINDOW_BYTES;
    return bytes.subarray(start - base, Math.min(end, base + HEX_WINDOW_BYTES) - base);
  }

  /** Loads the windows covering `[start, end)`. */
  async ensure(start: number, end: number): Promise<void> {
    if (start >= this.size) return;
    await Promise.all(this.span(start, end).map((index) => this.load(index)));
  }

  private load(index: number): Promise<void> {
    const cached = this.windows.get(index);
    if (cached && this.complete(index)) {
      this.windows.delete(index);
      this.windows.set(index, cached);
      return Promise.resolve();
    }
    const shared = this.pending.get(index);
    if (shared) return shared;
    const generation = this.generation;
    const job = this.read(index * HEX_WINDOW_BYTES, HEX_WINDOW_BYTES)
      .then((got) => this.store(index, generation, got))
      .finally(() => { if (this.pending.get(index) === job) this.pending.delete(index); });
    this.pending.set(index, job);
    return job;
  }

  private store(index: number, generation: number, got: RangeRead): void {
    if (got.stamp !== this.stamp) {
      // A reply to a read issued before the last change is stale.
      if (generation !== this.generation) return;
      this.windows.clear();
      this.pending.clear();
      this.generation++;
      this.stamp = got.stamp;
      this.size = got.size;
      this.changed = true;
    }
    this.windows.delete(index);
    this.windows.set(index, got.bytes);
    for (const oldest of this.windows.keys()) {
      if (this.windows.size <= HEX_CACHE_WINDOWS) break;
      this.windows.delete(oldest);
    }
  }
}
