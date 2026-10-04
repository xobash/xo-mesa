import { readRendererHeapBytes } from "./resourcePlateau";
import { sampleProcessTreeResources, type ProcessTreeRateSample } from "./processResources";

export interface WorkloadContext { sync: boolean; index: boolean; pdf: boolean; detachedWindows: number | null }
export interface InputFrameSample { latencyMs: number; context: WorkloadContext }
export interface WorkloadRecording {
  version: 1;
  environment: "native" | "browser";
  running: boolean;
  durationMs: number;
  hiddenInputs: number;
  droppedInputs: number;
  inputs: InputFrameSample[];
  resources: Array<{ atMs: number; heapBytes: number | null; process: ProcessTreeRateSample | null; context: WorkloadContext }>;
}
const MAX_INPUTS = 6000;
const MAX_DURATION_MS = 10 * 60_000;
let recording: WorkloadRecording | null = null;
let stopCurrent: (() => void) | null = null;

export function summarizeInputFrames(inputs: readonly InputFrameSample[]) {
  const values = inputs.map(input => input.latencyMs).filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  return { count: values.length, p50Ms: values.length ? values[Math.floor((values.length - 1) * .5)] : null,
    p95Ms: values.length ? values[Math.ceil((values.length - 1) * .95)] : null,
    maxMs: values.length ? values[values.length - 1] : null };
}
export function getWorkloadRecording(): WorkloadRecording | null { return recording; }
export function stopWorkloadRecording(): void { stopCurrent?.(); }
export function summarizeWorkloadRecording(session: WorkloadRecording) {
  return {
    all: summarizeInputFrames(session.inputs),
    sync: summarizeInputFrames(session.inputs.filter(input => input.context.sync)),
    index: summarizeInputFrames(session.inputs.filter(input => input.context.index)),
    pdf: summarizeInputFrames(session.inputs.filter(input => input.context.pdf)),
    detached: summarizeInputFrames(session.inputs.filter(input => (input.context.detachedWindows ?? 0) > 0)),
  };
}
export function exportWorkloadRecording(): string {
  if (!recording) throw new Error("Record a workload first.");
  return JSON.stringify({ ...recording, measurement: "Input event timestamp to second animation frame; a paint-opportunity proxy, not OS input-to-photon latency.",
    coverage: "Renderer heap is optional and window-local. Process RSS includes identified descendants only; shared GPU/WebKit coverage is not established. No whole-app plateau claim.",
    summary: summarizeWorkloadRecording(recording) }, null, 2);
}

/** Explicit, temporary local measurement. Never records text, paths or keys. */
export function startWorkloadRecording(native: boolean, context: () => WorkloadContext): void {
  stopCurrent?.();
  const session: WorkloadRecording = { version: 1, environment: native ? "native" : "browser", running: true,
    durationMs: 0, hiddenInputs: 0, droppedInputs: 0, inputs: [], resources: [] };
  recording = session;
  const started = performance.now();
  const frames = new Set<number>();
  let sampling = false;
  const schedule = (callback: () => void) => {
    const id = requestAnimationFrame(() => { frames.delete(id); callback(); }); frames.add(id);
  };
  const onInput = (event: Event) => {
    if (!(event.target instanceof HTMLElement) || (!event.target.isContentEditable && !event.target.matches("textarea,input"))) return;
    if (document.visibilityState !== "visible") { session.hiddenInputs++; return; }
    if (session.inputs.length + frames.size >= MAX_INPUTS) { session.droppedInputs++; return; }
    const now = performance.now();
    const at = event.timeStamp > 0 && event.timeStamp <= now ? event.timeStamp : now;
    const activity = context();
    schedule(() => schedule(() => {
      if (document.visibilityState !== "visible") { session.hiddenInputs++; return; }
      session.inputs.push({ latencyMs: performance.now() - at, context: activity });
    }));
  };
  const sample = async () => {
    session.durationMs = performance.now() - started;
    if (session.durationMs >= MAX_DURATION_MS) { stopCurrent?.(); return; }
    if (sampling) return;
    sampling = true;
    const activity = context();
    const heapBytes = readRendererHeapBytes();
    try {
      const process = native ? await sampleProcessTreeResources().catch(() => null) : null;
      if (session.running) session.resources.push({ atMs: performance.now() - started, heapBytes, process, context: activity });
    } finally { sampling = false; }
  };
  document.addEventListener("beforeinput", onInput, true);
  const timer = window.setInterval(() => void sample(), 1000);
  stopCurrent = () => {
    session.running = false; session.durationMs = performance.now() - started;
    document.removeEventListener("beforeinput", onInput, true); clearInterval(timer);
    session.droppedInputs += frames.size;
    for (const frame of frames) cancelAnimationFrame(frame);
    frames.clear(); stopCurrent = null;
  };
  void sample();
}
