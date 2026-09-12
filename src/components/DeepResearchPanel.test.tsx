// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepResearchPanel } from "./DeepResearchPanel";
import { DeepResearchPhaseChip } from "./DeepResearchPhaseChip";
import { useAppStore } from "../store";
import { DEFAULT_DEEP_RESEARCH_LIMITS, buildResearchContext, buildResearchPrompt, type DeepResearchResult } from "../lib/deepResearch";
import type { DeepResearchEvent } from "../lib/deepResearchRun";

const boundary = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  invoke: vi.fn(async (name: string, _args?: unknown) => name === "terminal_snapshot" ? { data: "retained Pi tool transcript" } : undefined),
  copy: vi.fn(async (_value: string) => undefined),
  save: vi.fn(async () => "/tmp/research-qa.md" as string | null),
  writeText: vi.fn(async () => undefined),
  restart: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/core", async (original) => ({ ...await original<object>(), invoke: boundary.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: boundary.save }));
vi.mock("@tauri-apps/plugin-fs", async (original) => ({ ...await original<object>(), writeTextFile: boundary.writeText }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "test" }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
    boundary.handlers.set(name, callback);
    return () => boundary.handlers.delete(name);
  }),
}));
vi.mock("../lib/vault", async (original) => ({ ...await original<object>(), IN_TAURI: true }));
vi.mock("../lib/piSessionBridge", () => ({
  getPiSessionSnapshot: () => ({ sessionId: "pi-test" }),
  requestSharedPiRestart: boundary.restart,
}));
vi.mock("../lib/webArchive", async (original) => ({
  ...await original<object>(), archiveWebPage: vi.fn(async () => { throw new Error("Test boundary: no archive I/O"); }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const initial = useAppStore.getState();
let host: HTMLDivElement;
let root: Root;
const depth = { rounds: 1, subQuestions: 2, maxSources: 8, maxGeneratedNotes: 2 };
function result(): DeepResearchResult {
  const context = buildResearchContext({ query: "test", activePath: null, selectedPaths: [], files: [], notes: {}, content: {}, limits: DEFAULT_DEEP_RESEARCH_LIMITS });
  const prompt = buildResearchPrompt({ runId: "test", query: "test", folder: "Research", context, depth });
  return JSON.parse(prompt.match(/```json\n([\s\S]+?)\n```/)![1]);
}
async function start() {
  await act(async () => {
    const pending = useAppStore.getState().startDeepResearch("test question", { depth, piSurfaceAvailable: true });
    await vi.advanceTimersByTimeAsync(200);
    await pending;
  });
}
async function emit(event: Omit<DeepResearchEvent, "runId">) {
  await act(async () => {
    boundary.handlers.get("mesa://deep-research")?.({ payload: { runId: useAppStore.getState().deepResearch!.runId, ...event } });
    await Promise.resolve();
  });
}
function button(text: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll("button")].find((element) => element.textContent === text);
}
function replies() { return boundary.invoke.mock.calls.filter(([name]) => name === "deep_research_respond").map(([, args]) => args as { status: string; message: string }); }

beforeEach(async () => {
  vi.useFakeTimers();
  boundary.handlers.clear(); boundary.invoke.mockClear(); boundary.copy.mockClear(); boundary.restart.mockClear(); boundary.save.mockClear(); boundary.writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: boundary.copy } });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  useAppStore.setState({ ...initial, vaultPath: "/test-vault", files: [], notes: {}, contentCache: {}, deepResearch: null });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<><DeepResearchPhaseChip /><DeepResearchPanel /></>));
});
afterEach(async () => {
  await act(async () => { await useAppStore.getState().cancelDeepResearch(); root.unmount(); });
  host.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("Deep Research validation and visible recovery", () => {
  it("shows and copies diagnostics during an active rejected run, then accepts a corrected finish without typing another prompt", async () => {
    await start();
    expect(button("Copy troubleshooting kit")).toBeUndefined();
    const bad = result(); bad.report.markdown = bad.report.markdown.replace("### Sub-question 1", "### Short unrelated topic");
    await emit({ kind: "finish", requestId: "first", result: bad });
    expect(replies()[0].status).toBe("rejected");
    expect(useAppStore.getState().deepResearch?.changeSet).toBeNull();
    expect(host.textContent).toContain("Correcting rejected report");
    expect(button("Copy troubleshooting kit")).toBeDefined();
    await emit({ kind: "progress", phase: "synthesizing", draftMarkdown: "A newer partial correction" });
    await act(async () => {
      button("Copy troubleshooting kit")!.click();
      await vi.waitFor(() => expect(boundary.copy).toHaveBeenCalled());
    });
    expect(boundary.copy.mock.calls[0][0]).toContain("Short unrelated topic");
    expect(boundary.copy.mock.calls[0][0]).toContain("retained Pi tool transcript");
    expect(boundary.copy.mock.calls[0][0]).toContain("missing findings subsection");
    await act(async () => boundary.handlers.get("mesa://browse")!({ payload: "https://example.com/page" }));
    const staleHandler = boundary.handlers.get("mesa://deep-research")!;
    await emit({ kind: "finish", requestId: "second", result: result() });
    expect(replies()[1].status).toBe("accepted");
    expect(useAppStore.getState().deepResearch?.phase).toBe("review");
    expect(host.textContent).toContain("Review proposed changes");
    await act(async () => staleHandler({ payload: { kind: "progress", runId: useAppStore.getState().deepResearch!.runId, phase: "synthesizing", message: "late progress" } }));
    expect(useAppStore.getState().deepResearch?.phase).toBe("review");
    // Initial launch body + Enter only; rejection travels back as a tool result.
    expect(boundary.invoke.mock.calls.filter(([name]) => name === "terminal_write")).toHaveLength(2);
  });

  it("shows actual turn end immediately, clears it on provider retry, and does not mistake a live slow session for failure", async () => {
    await start();
    await emit({ kind: "agent-end", reason: "Pi ended its turn without an accepted report." });
    expect(host.textContent).toContain("Pi turn ended — report not accepted");
    expect(host.textContent).not.toContain("Working…");
    expect(button("Copy troubleshooting kit")).toBeDefined();
    await emit({ kind: "agent-start" });
    expect(useAppStore.getState().deepResearch?.piTurnEnded).toBeUndefined();
    expect(button("Copy troubleshooting kit")).toBeUndefined();
    await act(async () => vi.advanceTimersByTimeAsync(6 * 60 * 1000 + 100));
    expect(useAppStore.getState().deepResearch?.phase).toBe("researching");
    expect(button("Copy troubleshooting kit")).toBeDefined();
    await act(async () => button("Cancel")!.click());
    expect(useAppStore.getState().deepResearch?.phase).toBe("cancelled");
  });

  it("sends one focused repair prompt when a rejected finish is followed by a real turn end", async () => {
    await start();
    const bad = result(); bad.report.markdown = "# Incomplete draft";
    await emit({ kind: "finish", requestId: "first", result: bad });
    await emit({ kind: "agent-end", reason: "Pi ended its turn without an accepted report." });
    await vi.waitFor(() => {
      const writes = boundary.invoke.mock.calls.filter(([name]) => name === "terminal_write");
      expect(writes).toHaveLength(4);
    });
    const writes = boundary.invoke.mock.calls
      .filter(([name]) => name === "terminal_write")
      .map(([, args]) => args as { input: string });
    expect(writes[2].input).toContain("Continue the same run now");
    expect(writes[2].input).toContain("exact Mesa-observed source URL list");
  });

  it("allows diagnostics in a detached read-only presentation using the run's captured PTY", async () => {
    await start();
    await emit({ kind: "agent-end", reason: "Pi ended without finish" });
    const remote = { ...useAppStore.getState().deepResearch!, piSessionId: "captured-research-session" };
    await act(async () => root.render(<DeepResearchPanel runOverride={remote} readOnly />));
    expect(button("Cancel")).toBeUndefined();
    expect(button("Copy troubleshooting kit")).toBeDefined();
    await act(async () => {
      button("Copy troubleshooting kit")!.click();
      await vi.waitFor(() => expect(boundary.copy).toHaveBeenCalled());
    });
    expect(boundary.invoke).toHaveBeenCalledWith("terminal_snapshot", { sessionId: "captured-research-session" });
    expect(boundary.copy.mock.calls[0][0]).toContain("retained Pi tool transcript");
  });

  it("uses the native save fallback when clipboard access fails and does not write on dialog cancellation", async () => {
    await start();
    await emit({ kind: "agent-end", reason: "No accepted finish" });
    boundary.copy.mockRejectedValueOnce(new Error("Clipboard denied"));
    await act(async () => {
      button("Copy troubleshooting kit")!.click();
      await vi.waitFor(() => expect(boundary.writeText).toHaveBeenCalled());
    });
    expect(boundary.save).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Saved to file");
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    boundary.copy.mockRejectedValueOnce(new Error("Clipboard denied"));
    boundary.save.mockResolvedValueOnce(null);
    await act(async () => {
      button("Copy troubleshooting kit")!.click();
      await vi.waitFor(() => expect(boundary.save).toHaveBeenCalledTimes(2));
    });
    expect(host.textContent).toContain("Copy failed");
    expect(boundary.writeText).toHaveBeenCalledTimes(1);
  });

  it("stops after three rejected submissions and retains the rejected report and exact issues", async () => {
    await start();
    const bad = result(); bad.report.markdown = "# Incomplete draft";
    await emit({ kind: "finish", requestId: "one", result: bad });
    await emit({ kind: "finish", requestId: "two", result: bad });
    await emit({ kind: "finish", requestId: "three", result: bad });
    expect(replies().map((reply) => reply.status)).toEqual(["rejected", "rejected", "stopped"]);
    expect(useAppStore.getState().deepResearch?.phase).toBe("error");
    expect(useAppStore.getState().deepResearch?.reportDraft).toBe("# Incomplete draft");
    expect(button("Copy troubleshooting kit")).toBeDefined();
    expect(host.textContent).toContain("missing Findings section");
    expect(useAppStore.getState().deepResearch?.changeSet).toBeNull();
  });
});
