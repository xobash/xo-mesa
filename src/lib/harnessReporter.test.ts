import { describe, expect, it, vi } from "vitest";
import reporter from "../../src-tauri/resources/harness-reporter.js?raw";

describe("native harness reporter", () => {
  it("waits for a page token, rotates it, and omits it from fallback URLs", async () => {
    const frames: string[] = [];
    const posts: string[] = [];
    const timers: Array<() => void> = [];
    const page = {
      top: null as unknown,
      fetch: vi.fn((_url: string, options: { body: string }) => {
        posts.push(options.body);
        return posts.length === 1
          ? Promise.resolve({})
          : Promise.reject(new Error("mixed content"));
      }),
      addEventListener: vi.fn(),
    } as Record<string, unknown>;
    page.top = page;
    const host = {
      appendChild(frame: { src: string; parentNode?: unknown }) {
        frames.push(frame.src);
        frame.parentNode = { removeChild: vi.fn() };
      },
    };
    const document = {
      documentElement: host,
      body: { innerText: "Visible page" },
      title: "Example",
      readyState: "complete",
      querySelectorAll: () => [],
      addEventListener: vi.fn(),
      createElement: () => ({ setAttribute: vi.fn(), style: {}, src: "" }),
    };
    const run = new Function(
      "window", "document", "location", "MutationObserver",
      "setTimeout", "clearTimeout", "setInterval", reporter.replace("__MESA_PORT__", "8765"),
    );
    run(
      page, document, { href: "https://example.com/" },
      class { observe() {} },
      (callback: () => void) => { timers.push(callback); return timers.length; },
      () => {}, () => {},
    );
    const flush = async () => {
      while (timers.length) timers.shift()!();
      await Promise.resolve();
    };

    flush();
    expect(posts).toHaveLength(0);
    const setToken = page.__mesaHarnessSetToken as (value: string) => void;
    const first = "a".repeat(64);
    setToken(first);
    await flush();
    expect(JSON.parse(posts[posts.length - 1]).token).toBe(first);

    const second = "b".repeat(64);
    setToken(second);
    await flush();
    expect(JSON.parse(posts[posts.length - 1]).token).toBe(second);
    expect(frames[frames.length - 1]).toContain("mesa-snap://snap/#");
    expect(decodeURIComponent(frames[frames.length - 1])).not.toContain(second);
  });
});
