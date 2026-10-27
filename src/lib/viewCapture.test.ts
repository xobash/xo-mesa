// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { captureScale, contentBox, encodeViewMeta, intersect, sourceRect, union, viewCaptureRoot, VIEW_CAPTURE_MAX_SIDE } from "./viewCapture";

describe("view capture geometry", () => {
  it("clips and unions visible rectangles", () => {
    expect(intersect({ left: 0, top: 0, width: 10, height: 10 }, { left: 5, top: 5, width: 10, height: 10 }))
      .toEqual({ left: 5, top: 5, width: 5, height: 5 });
    expect(intersect({ left: 0, top: 0, width: 10, height: 10 }, { left: 10, top: 0, width: 5, height: 5 })).toBeNull();
    expect(union([{ left: 0, top: 10, width: 5, height: 5 }, { left: 20, top: 0, width: 5, height: 5 }]))
      .toEqual({ left: 0, top: 0, width: 25, height: 15 });
  });

  it("keeps device resolution but caps the long side", () => {
    expect(captureScale(800, 600, 2)).toBe(VIEW_CAPTURE_MAX_SIDE / 800);
    expect(captureScale(400, 300, 2)).toBe(2);
    expect(captureScale(400, 300, 0.5)).toBe(1);
    expect(captureScale(0, 0, 2)).toBe(0);
  });

  it("maps object-fit contain and cover content boxes", () => {
    const box = { left: 0, top: 0, width: 200, height: 100 };
    expect(contentBox(box, 100, 100, "contain")).toEqual({ left: 50, top: 0, width: 100, height: 100 });
    expect(contentBox(box, 100, 100, "cover")).toEqual({ left: 0, top: -50, width: 200, height: 200 });
    expect(contentBox(box, 50, 50, "scale-down")).toEqual({ left: 75, top: 25, width: 50, height: 50 });
    expect(contentBox(box, 100, 100, "fill")).toEqual(box);
  });

  it("maps a scrolled PDF page's visible strip to its bitmap pixels", () => {
    const drawn = { left: 0, top: -400, width: 500, height: 800 };
    const visible = { left: 0, top: 0, width: 500, height: 400 };
    expect(sourceRect(visible, drawn, 1000, 1600)).toEqual({ left: 0, top: 800, width: 1000, height: 800 });
  });
});

describe("view capture routing", () => {
  it("prefers the live document pane and never captures Pi itself", () => {
    document.body.innerHTML = '<div class="center-body"><div id="body"><div data-mesa-view-root="live-doc"></div></div></div>';
    expect(viewCaptureRoot(document, "doc")?.id).toBe("body");
    document.body.innerHTML = '<div class="center-body" id="center"></div>';
    expect(viewCaptureRoot(document, "graph")?.id).toBe("center");
    expect(viewCaptureRoot(document, "agent")).toBeNull();
  });

  it("encodes bounded metadata as a header-safe value", () => {
    const encoded = encodeViewMeta({ path: "Résumé/scan.pdf", view: "doc", width: 1, height: 1, layers: 1, notes: Array(20).fill("x".repeat(500)) });
    expect(encoded).toMatch(/^[\x21-\x7e]+$/);
    const meta = JSON.parse(decodeURIComponent(encoded));
    expect(meta.path).toBe("Résumé/scan.pdf");
    expect(meta.notes).toHaveLength(8);
    expect(meta.notes[0]).toHaveLength(300);
  });
});
