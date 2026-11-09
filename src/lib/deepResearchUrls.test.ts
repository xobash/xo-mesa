import { describe, expect, it } from "vitest";
import { activityForNavigation } from "./deepResearchUrls";

// --- observed navigation (queries + sources the harness actually visited) ----
describe("activityForNavigation", () => {
  const searched = (url: string) => {
    const a = activityForNavigation(url, 1);
    return a?.kind === "search" ? a.message : null;
  };

  it("labels a search-engine navigation as an observed search with its query", () => {
    const a = activityForNavigation("https://duckduckgo.com/?q=sex+magick+history", 123);
    expect(a).toMatchObject({ kind: "search", observed: true, at: 123 });
    expect(a?.message).toContain("sex magick history");
  });

  it("extracts the query from common search engines", () => {
    expect(searched("https://duckduckgo.com/?q=aleister+crowley&ia=web")).toBe("Searched for “aleister crowley”");
    expect(searched("https://html.duckduckgo.com/html/?q=test")).toBe("Searched for “test”");
    expect(searched("https://www.google.com/search?q=epstein+timeline&hl=en")).toBe("Searched for “epstein timeline”");
    expect(searched("https://www.bing.com/search?q=abc")).toBe("Searched for “abc”");
    expect(searched("https://search.brave.com/search?q=abc")).toBe("Searched for “abc”");
    expect(searched("https://www.startpage.com/sp/search?query=abc")).toBe("Searched for “abc”");
  });

  it("treats ordinary pages, non-search engine paths and empty queries as sources", () => {
    expect(activityForNavigation("https://en.wikipedia.org/wiki/Aleister_Crowley", 1)?.kind).toBe("source");
    expect(activityForNavigation("https://google.com/maps?q=pizza", 1)?.kind).toBe("source"); // not /search
    expect(activityForNavigation("https://duckduckgo.com/", 1)?.kind).toBe("source"); // no query
  });

  it("labels an ordinary page navigation as an observed source", () => {
    const a = activityForNavigation("https://en.wikipedia.org/wiki/Thelema?utm_source=x", 5);
    expect(a).toMatchObject({ kind: "source", observed: true, at: 5 });
    expect(a?.sourceUrl).toBe("https://en.wikipedia.org/wiki/Thelema");
    expect(a?.message).toBe("Opened en.wikipedia.org/wiki/Thelema");
  });

  it("rejects non-web navigations and bad URLs", () => {
    expect(activityForNavigation("about:blank", 1)).toBeNull();
    expect(activityForNavigation("file:///etc/passwd", 1)).toBeNull();
    expect(activityForNavigation("javascript:alert(1)", 1)).toBeNull();
    expect(activityForNavigation("not a url", 1)).toBeNull();
    expect(activityForNavigation("", 1)).toBeNull();
  });
});
