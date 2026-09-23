import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  warmPdfThumb: vi.fn(() => Promise.resolve()),
  ensurePeek: vi.fn(),
  hideHoverPreview: vi.fn(),
  showHoverPreview: vi.fn(),
}));

const MOCK_FILES = [
  { relPath: "docs/report.pdf", path: "/vault/docs/report.pdf", ext: "pdf" },
  { relPath: "docs/note.md", path: "/vault/docs/note.md", ext: "md" },
  { relPath: "web/page.html", path: "/vault/web/page.html", ext: "html" },
];

vi.mock("../store", () => ({
  getStore: () => ({
    settings: { hoverDelayMs: 123 },
    files: MOCK_FILES,
    // The real store resolves a path through an identity-keyed index rather
    // than scanning `files`; mirror that here so the stub matches `AppState`.
    fileFor: (relPath: string) => MOCK_FILES.find((f) => f.relPath === relPath),
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
  it("prewarms PDF thumbnails as soon as the PDF renderer chunk resolves while the hover card still honors delay", async () => {
    previewEnter(
      { kind: "note", id: "docs/report.pdf" },
      { left: 10, top: 20, right: 50, bottom: 50 } as DOMRect
    );

    await vi.waitFor(() =>
      expect(mocks.warmPdfThumb).toHaveBeenCalledWith("/vault/docs/report.pdf")
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

  it("does not duplicate saved-HTML I/O before the card opens", () => {
    previewEnter(
      { kind: "note", id: "web/page.html" },
      { left: 10, top: 20, right: 50, bottom: 50 } as DOMRect
    );

    expect(mocks.ensurePeek).not.toHaveBeenCalled();
    expect(mocks.showHoverPreview).not.toHaveBeenCalled();
    vi.advanceTimersByTime(123);
    expect(mocks.showHoverPreview).toHaveBeenCalledTimes(1);
  });

  it("keeps the PDF prewarm but cancels card open when hover leaves before the delay", async () => {
    previewEnter(
      { kind: "note", id: "docs/report.pdf" },
      { left: 10, top: 20, right: 50, bottom: 50 } as DOMRect
    );
    previewLeave();
    vi.advanceTimersByTime(123);

    await vi.waitFor(() => expect(mocks.warmPdfThumb).toHaveBeenCalledTimes(1));
    expect(mocks.warmPdfThumb).toHaveBeenCalledTimes(1);
    expect(mocks.showHoverPreview).not.toHaveBeenCalled();
  });
});
