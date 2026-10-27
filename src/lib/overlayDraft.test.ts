// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { overlayDraftKey, parseBoardDocument, readOverlayDraft, writeOverlayDraft } from "./overlayDraft";
beforeEach(() => localStorage.clear());
describe("editable overlay drafts", () => {
  it("isolates vaults and days and retains the original expected disk bytes", () => {
    const key = overlayDraftKey("/a", "Scratchpad/2026-09-14.md");
    expect(writeOverlayDraft(key, { version: 1, content: "new draft", baseline: "old disk", dirty: true }).ok).toBe(true);
    expect(readOverlayDraft(key)).toMatchObject({ content: "new draft", baseline: "old disk", dirty: true });
    expect(readOverlayDraft(overlayDraftKey("/b", "Scratchpad/2026-09-14.md"))).toBeNull();
    expect(readOverlayDraft(overlayDraftKey("/a", "Scratchpad/2026-09-15.md"))).toBeNull();
  });
  it("keeps empty edited drafts distinct from absent drafts", () => {
    writeOverlayDraft("draft", { version: 1, content: "", baseline: "disk", dirty: true });
    expect(readOverlayDraft("draft")?.dirty).toBe(true);
  });
  it("preserves editable strokes and migrates legacy rasters as backgrounds", () => {
    const board = { version: 1, strokes: [{ color: "red", points: [[1, 2], [3, 4]] }] };
    expect(parseBoardDocument(JSON.stringify(board))).toEqual(board);
    expect(parseBoardDocument("data:image/png;base64,AA==")).toEqual({ version: 1, background: "data:image/png;base64,AA==", strokes: [] });
    expect(() => parseBoardDocument('{"version":1,"strokes":[{"color":"red","points":[[null,2]]}]}')).toThrow();
  });
});
