// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store";
import { markMesaPerf } from "../lib/mesaPerf";
import { DiagnosticsModal } from "./DiagnosticsModal";

describe("DiagnosticsModal", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    useAppStore.setState({
      diagnosticsOpen: true,
      vaultName: "Test Vault",
      files: [
        { path: "/v/a.md", relPath: "a.md", name: "a", ext: "md", isMarkdown: true },
        { path: "/v/b.txt", relPath: "b.txt", name: "b", ext: "txt", isMarkdown: false },
      ],
      notes: { "a.md": { relPath: "a.md", title: "a", rawLinks: [], tags: [], aliases: [] } },
      contentCache: { "a.md": "alpha" },
      indexingTextFiles: 1,
      unindexedTextFiles: 2,
      syncBusy: false,
      syncLog: [],
      syncProgress: null,
      textSaveState: { pending: 0, saving: 0, failed: 0 },
      loading: false,
      deepResearch: null,
    });
    delete (window as Window & { __MESA_PERF__?: unknown }).__MESA_PERF__;
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("renders local app health without exposing vault paths", () => {
    markMesaPerf("vault-ready", { files: 2 });
    act(() => root.render(<DiagnosticsModal />));
    expect(host.textContent).toContain("Test Vault");
    expect(host.textContent).toContain("2 files · 1 notes");
    expect(host.textContent).toContain("1 still indexing");
    expect(host.textContent).toContain("vault-ready");
    expect(host.textContent).not.toContain("/v/a.md");
  });

  it("summarizes active background work", () => {
    useAppStore.setState({ loading: true, syncBusy: true, indexingTextFiles: 3 });
    act(() => root.render(<DiagnosticsModal />));
    expect(host.textContent).toContain("3 active");
    expect(host.textContent).toContain("vault open");
    expect(host.textContent).toContain("indexing 3 files");
    expect(host.textContent).toContain("sync");
  });

  it("shows PDF workload pressure when a run is active", () => {
    (window as Window & { __MESA_PDF_PERF__?: unknown }).__MESA_PDF_PERF__ = {
      activeRunId: 1,
      runs: [{ id: 1, file: { relPath: "manual.pdf", ext: "pdf" }, startedAt: 0, events: [], counters: { pagesPlanned: 4, rasterBytes: 8192 } }],
    };
    act(() => root.render(<DiagnosticsModal />));
    expect(host.textContent).toContain("manual.pdf · 4 pages planned · ~8.0 KB raster memory");
  });

  it("refreshes while open and stops when closed", () => {
    vi.useFakeTimers();
    act(() => root.render(<DiagnosticsModal />));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(host.textContent).toContain("Diagnostics");
    useAppStore.setState({ diagnosticsOpen: false });
    act(() => { vi.advanceTimersByTime(2000); });
    vi.useRealTimers();
  });
});
