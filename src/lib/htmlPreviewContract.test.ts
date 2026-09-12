import { describe, expect, it } from "vitest";
import previewCard from "../components/PreviewCard.tsx?raw";
import htmlView from "../components/HtmlView.tsx?raw";
import documentView from "../components/DocumentView.tsx?raw";

describe("saved HTML hover previews", () => {
  it("uses the real saved file natively and a prepared browser srcDoc", () => {
    expect(previewCard).toContain("IN_TAURI ? (");
    expect(previewCard).toContain("src={urlForPath(noteFile.path)}");
    expect(previewCard).toContain(
      "{ scripts: false, previewCodeStripped: true }"
    );
    expect(previewCard).toContain(
      'htmlPreview?.rel === noteFile.relPath ? htmlPreview.html : ""'
    );
    expect(previewCard).toContain('sandbox=""');
  });

  it("keeps native HTML out of the text cache and caps the browser fallback", () => {
    expect(previewCard).toContain(
      "const ensureContent = useAppStore((s) => s.ensureContent);"
    );
    expect(previewCard).toContain("if (isHtml && IN_TAURI) return;");
    expect(previewCard).toContain(
      "const load = isHtml ? ensureContent(noteId) : ensurePeek(noteId);"
    );
    expect(previewCard).toContain("HTML_PREVIEW_MAX_CHARS");
  });
});

describe("saved HTML full viewer", () => {
  it("keeps native rendered mode on the direct file iframe path", () => {
    expect(htmlView).toContain("if (directSrc && !source)");
    expect(htmlView).toContain("if (directSrc) {\n      setRenderedHtml(\"\");");
    expect(htmlView).toContain("src={directSrc}");
  });

  it("keeps saved page scripts off the broad asset origin", () => {
    expect(htmlView).toContain(
      'sandbox="allow-scripts allow-popups allow-forms allow-modals"'
    );
    expect(htmlView).not.toContain("allow-same-origin");
    expect(documentView).toContain(
      'sandbox="allow-scripts allow-popups allow-forms allow-modals"'
    );
    expect(documentView).not.toContain("allow-same-origin");
  });
});
