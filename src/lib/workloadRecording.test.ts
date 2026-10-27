// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { summarizeInputFrames, startWorkloadRecording, stopWorkloadRecording, getWorkloadRecording, summarizeWorkloadRecording, exportWorkloadRecording } from "./workloadRecording";
let frames: Map<number, FrameRequestCallback>;
let input: HTMLTextAreaElement;
beforeEach(() => {
  vi.useFakeTimers(); frames = new Map(); let id = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frames.set(++id, cb); return id; });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => frames.delete(key));
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  input = document.createElement("textarea"); document.body.append(input);
});
afterEach(() => { stopWorkloadRecording(); input.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function frame() { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(performance.now())); }
it("keeps absent measurements unknown and computes ordered percentile bounds", () => {
  expect(summarizeInputFrames([])).toEqual({ count: 0, p50Ms: null, p95Ms: null, maxMs: null });
  const context = { sync: true, index: false, pdf: false, detachedWindows: null };
  expect(summarizeInputFrames([100, 10, 30, 20].map(latencyMs => ({ latencyMs, context })))).toEqual({ count: 4, p50Ms: 20, p95Ms: 100, maxMs: 100 });
});
it("captures workload at input time and reports absent workloads as untested", () => {
  let context = { sync: true, index: false, pdf: true, detachedWindows: 1 };
  startWorkloadRecording(false, () => context);
  input.value = "private content must not be recorded";
  input.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, data: "private" }));
  context = { sync: false, index: true, pdf: false, detachedWindows: 0 };
  frame(); frame(); stopWorkloadRecording();
  const summary = summarizeWorkloadRecording(getWorkloadRecording()!);
  expect(summary.sync.count).toBe(1); expect(summary.pdf.count).toBe(1); expect(summary.detached.count).toBe(1);
  expect(summary.index.p95Ms).toBeNull();
  expect(exportWorkloadRecording()).not.toContain("private");
});
it("stopping cancels pending input frames and detaches the listener", () => {
  startWorkloadRecording(false, () => ({ sync: false, index: false, pdf: false, detachedWindows: null }));
  input.dispatchEvent(new InputEvent("beforeinput", { bubbles: true }));
  stopWorkloadRecording(); frame(); frame();
  input.dispatchEvent(new InputEvent("beforeinput", { bubbles: true }));
  expect(getWorkloadRecording()?.inputs).toHaveLength(0);
  expect(getWorkloadRecording()?.droppedInputs).toBe(1); expect(frames.size).toBe(0);
});
it("does not interpret background-window input as painted latency", () => {
  startWorkloadRecording(false, () => ({ sync: false, index: false, pdf: false, detachedWindows: null }));
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  input.dispatchEvent(new InputEvent("beforeinput", { bubbles: true }));
  expect(getWorkloadRecording()?.hiddenInputs).toBe(1); expect(frames.size).toBe(0);
});
