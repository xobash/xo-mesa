import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  warmPdfThumb: vi.fn(),
  ensurePeek: vi.fn(),
  hideHoverPreview: vi.fn(),
  showHoverPreview: vi.fn(),
}));

vi.mock("../store", () => ({
  getStore: () => ({
    settings: { hoverDelayMs: 123 },
    files: [
      { relPath: "docs/report.pdf", path: "/vault/docs/report.pdf", ext: "pdf" },
      { relPath: "docs/note.md", path: "/vault/docs/note.md", ext: "md" },
    ],
    ensurePeek: mocks.ensurePeek,
    showHoverPreview: mocks.showHoverPreview,
    hideHoverPreview: mocks.hideHoverPreview,
  }),
}));

vi.mock("../lib/pdfThumb", () => ({
  warmPdfThumb: mocks.warmPdfThumb,
}));

import { previewEnter, previewLeave } from "./previewTriggers";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { innerWidth: 1200, innerHeight: 800 });
});

afterEach(() => {
  previewLeave();
  mocks.warmPdfThumb.mockClear();
  mocks.ensurePeek.mockClear();
  mocks.showHoverPreview.mockClear();
  mocks.hideHoverPreview.mockClear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("previewEnter", () => {
  it("prewarms PDF thumbnails immediately while the hover card still honors delay", () => {
    previewEnter(
      { kind: "note", id: "docs/report.pdf" },
      { left: 10, top: 20, right: 50, bottom: 50 } as DOMRect
    );

    expect(mocks.warmPdfThumb).toHaveBeenCalledWith("/vault/docs/report.pdf");
    expect(mocks.warmPdfThumb).toHaveBeenCalledTimes(1);
    expect(mocks.showHoverPreview).not.toHaveBeenCalled();
    vi.advanceTimersByTime(123);

    expect(mocks.showHoverPreview).toHaveBeenCalledTimes(1);
  });

  it("prewarms textual file content immediately", () => {
    previewEnter(
      { kind: "note", id: "docs/note.md" },
      { left: 10, top: 20, right: 50, bottom: 50 } as DOMRect
    );

    expect(mocks.ensurePeek).toHaveBeenCalledWith("docs/note.md");
    expect(mocks.ensurePeek).toHaveBeenCalledTimes(1);
    expect(mocks.showHoverPreview).not.toHaveBeenCalled();
    vi.advanceTimersByTime(123);

    expect(mocks.showHoverPreview).toHaveBeenCalledTimes(1);
  });

  it("keeps an immediate prewarm but cancels card open when hover leaves before the delay", () => {
    previewEnter(
      { kind: "note", id: "docs/report.pdf" },
      { left: 10, top: 20, right: 50, bottom: 50 } as DOMRect
    );
    previewLeave();
    vi.advanceTimersByTime(123);

    expect(mocks.warmPdfThumb).toHaveBeenCalledTimes(1);
    expect(mocks.showHoverPreview).not.toHaveBeenCalled();
  });
});
