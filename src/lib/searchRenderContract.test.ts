import { describe, expect, it } from "vitest";
import searchSurface from "../components/SearchSurface.tsx?raw";

describe("search result render isolation", () => {
  it("memoizes rows so input-only state changes do not reconcile 100 results", () => {
    expect(searchSurface).toContain("const SearchResultItem = memo(");
    expect(searchSurface).toContain("<SearchResultItem");
    expect(searchSurface).toContain("onSelect={selectResult}");
    expect(searchSurface).toContain("onOpen={openActive}");
    expect(searchSurface).toContain("const openActive = useCallback(");
    expect(searchSurface).toContain("const selectResult = useCallback(");
  });

  it("keeps the preview target stable while the active result is unchanged", () => {
    expect(searchSurface).toContain("const previewTarget = useMemo(");
    expect(searchSurface).toContain("[active?.rel]");
    expect(searchSurface).toContain("<PreviewCard target={previewTarget}");
  });

  it("keeps an old completed pass visible but inert until its generation is current", () => {
    expect(searchSurface).toContain("const resultsCurrent =");
    expect(searchSurface).toContain("resultSet.query === q");
    expect(searchSurface).toContain("resultSet.files === files");
    expect(searchSurface).toContain("resultSet.cache === cache");
    expect(searchSurface).toContain("interactive={resultsCurrent}");
    expect(searchSurface).toContain("aria-disabled={!interactive}");
    expect(searchSurface).toContain("aria-busy={!resultsCurrent}");
    expect(searchSurface).toContain(
      "const active = resultsCurrent ? results[selClamped] : undefined;"
    );
  });

  it("retains every result in the DOM while culling offscreen row paint", () => {
    expect(searchSurface).not.toContain("results.slice(");
  });

  it("does not restart a scan for metadata-only file publications", () => {
    expect(searchSurface).toContain('from "zustand/react/shallow"');
    expect(searchSurface).toContain("useAppStore(useShallow((s) => s.files))");
  });
});
