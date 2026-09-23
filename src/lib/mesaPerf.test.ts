// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMesaPerfTimeline, markMesaPerf, observeMesaLongTasks } from "./mesaPerf";

describe("local Mesa timing marks", () => {
  beforeEach(() => {
    delete (window as Window & { __MESA_PERF__?: unknown }).__MESA_PERF__;
  });

  it("keeps marks local and bounded", () => {
    for (let i = 0; i < 300; i++) markMesaPerf(`mark-${i}`);
    const timeline = (window as Window & { __MESA_PERF__?: { events: Array<{ name: string }> } }).__MESA_PERF__;
    expect(timeline?.events).toHaveLength(256);
    expect(timeline?.events[0].name).toBe("mark-44");
    expect(timeline?.events[255].name).toBe("mark-299");
  });

  it("falls back when performance is unavailable", () => {
    const original = globalThis.performance;
    vi.stubGlobal("performance", undefined);
    expect(() => markMesaPerf("fallback")).not.toThrow();
    expect((window as Window & { __MESA_PERF__?: { events: Array<{ name: string }> } }).__MESA_PERF__?.events[0].name).toBe("fallback");
    vi.stubGlobal("performance", original);
  });

  it("exposes the local timeline without creating network side effects", () => {
    markMesaPerf("vault-ready", { files: 2 });
    const timeline = getMesaPerfTimeline();
    expect(timeline.events).toEqual([
      expect.objectContaining({ name: "vault-ready", detail: { files: 2 } }),
    ]);
  });

  it("records browser long tasks locally when supported", () => {
    const disconnect = vi.fn();
    const observe = vi.fn();
    let active: FakeObserver | undefined;
    class FakeObserver {
      constructor(private readonly callback: PerformanceObserverCallback) { active = this; }
      observe = observe;
      disconnect = disconnect;
      emit() { this.callback({ getEntries: () => [{ name: "self", duration: 123.4 }] } as PerformanceObserverEntryList, this as unknown as PerformanceObserver); }
    }
    vi.stubGlobal("PerformanceObserver", FakeObserver);
    const stop = observeMesaLongTasks();
    active?.emit();
    expect(observe).toHaveBeenCalledWith({ type: "longtask", buffered: true });
    expect(getMesaPerfTimeline().events).toContainEqual(expect.objectContaining({ name: "long-task" }));
    stop?.();
    expect(disconnect).toHaveBeenCalled();
  });
});
