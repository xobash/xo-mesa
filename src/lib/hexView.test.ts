import { describe, expect, it, vi } from "vitest";
import { HEX_CACHE_WINDOWS, HEX_MAX_SCROLL_PX, HEX_ROW_HEIGHT, HEX_WINDOW_BYTES, ByteWindowCache, formatHexRow, hexWindow } from "./hexView";

describe("hex rows", () => {
  it("formats offset, spaced hex and printable ASCII", () => {
    const row = formatHexRow(0x30, new TextEncoder().encode("Hello\0world\n1234"));
    expect(row.offset).toBe("00000030");
    expect(row.hex).toBe("48 65 6c 6c 6f 00 77 6f  72 6c 64 0a 31 32 33 34");
    expect(row.ascii).toBe("Hello.world.1234");
  });
});

describe("hex scroll window", () => {
  it("renders only the rows on screen for a small file", () => {
    const win = hexWindow(1000, 200 * HEX_ROW_HEIGHT, 30 * HEX_ROW_HEIGHT);
    expect(win.end - win.start).toBeLessThanOrEqual(46);
    expect(win.start).toBe(192);
    expect(win.spacerHeight).toBe(1000 * HEX_ROW_HEIGHT);
  });

  it("caps the spacer for a multi-GB file and still reaches the last row", () => {
    const rows = Math.ceil((6 * 1024 ** 3) / 16);
    const viewport = 600;
    const top = hexWindow(rows, 0, viewport);
    expect(top.spacerHeight).toBe(HEX_MAX_SCROLL_PX);
    expect(top.start).toBe(0);
    const bottom = hexWindow(rows, HEX_MAX_SCROLL_PX - viewport, viewport);
    expect(bottom.end).toBe(rows);
    expect(bottom.end - bottom.start).toBeLessThan(60);
  });
});

describe("range window cache", () => {
  const W = HEX_WINDOW_BYTES;
  const byteAt = (at: number) => (at * 7 + Math.floor(at / 1048576)) & 0xff;
  function virtualFile(state: { size: number; stamp: string }) {
    return vi.fn(async (offset: number, len: number) => {
      const n = Math.max(0, Math.min(len, state.size - offset));
      return { bytes: new Uint8Array(n).map((_, i) => byteAt(offset + i)), size: state.size, stamp: state.stamp };
    });
  }

  it("reads one 1 MiB window at any offset of a multi-GB file and shares concurrent requests", async () => {
    const state = { size: 6 * 1024 ** 3 + 5, stamp: "a" };
    const read = virtualFile(state);
    const cache = new ByteWindowCache(read, await read(0, 64 * 1024));
    read.mockClear();
    const at = 5 * 1024 ** 3 + 123 * 16;
    expect(cache.has(at, at + 640)).toBe(false);
    await Promise.all([cache.ensure(at, at + 640), cache.ensure(at, at + 640)]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(Math.floor(at / W) * W, W);
    expect(cache.has(at, at + 640)).toBe(true);
    expect(Array.from(cache.slice(at, at + 4))).toEqual([0, 1, 2, 3].map((i) => byteAt(at + i)));
    const last = state.size - 5;
    await cache.ensure(last, state.size);
    expect(cache.slice(last, last + 16)).toHaveLength(5);
  });

  it("keeps at most eight windows and re-reads an evicted one", async () => {
    const state = { size: 64 * W, stamp: "a" };
    const read = virtualFile(state);
    const cache = new ByteWindowCache(read, await read(0, W));
    for (let i = 1; i <= 12; i++) await cache.ensure(i * W, i * W + 16);
    expect(cache.windowCount).toBe(HEX_CACHE_WINDOWS);
    read.mockClear();
    await cache.ensure(0, 16);
    expect(read).toHaveBeenCalledWith(0, W);
  });

  it("drops every cached window and says so when the file changed between reads", async () => {
    const state = { size: 4 * W, stamp: "a" };
    const read = virtualFile(state);
    const cache = new ByteWindowCache(read, await read(0, W));
    expect(cache.has(0, 16)).toBe(true);
    expect(cache.changed).toBe(false);
    state.size = 3 * W + 10;
    state.stamp = "b";
    await cache.ensure(2 * W, 2 * W + 16);
    expect(cache.changed).toBe(true);
    expect(cache.size).toBe(3 * W + 10);
    expect(cache.has(0, 16)).toBe(false);
    expect(cache.has(2 * W, 2 * W + 16)).toBe(true);
  });

  it("drops a response that was in flight when the file changed", async () => {
    const state = { size: 4 * W, stamp: "a" };
    const read = virtualFile(state);
    const cache = new ByteWindowCache(read, await read(0, 16));
    let release = () => {};
    read.mockImplementationOnce(async (_offset: number, len: number) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { bytes: new Uint8Array(len), size: 4 * W, stamp: "a" };
    });
    const stale = cache.ensure(W, W + 16);
    state.stamp = "b";
    await cache.ensure(2 * W, 2 * W + 16);
    release();
    await stale;
    expect(cache.changed).toBe(true);
    expect(cache.has(W, W + 16)).toBe(false);
    expect(cache.has(2 * W, 2 * W + 16)).toBe(true);
  });
});
