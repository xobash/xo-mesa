import { describe, expect, it } from "vitest";
import {
  archiveWebPage,
  prepareArchivedHtml,
  queueAcceptedResearchSources,
  researchArchiveRelPaths,
} from "./webArchive";

describe("web archive", () => {
  it("records the final URL and adds a base so fetched HTML reopens correctly", async () => {
    let writtenHtml = "";
    const result = await archiveWebPage(
      "https://example.com/start",
      {
        fetchPage: async () => ({
          finalUrl: "https://example.com/articles/final",
          contentType: "text/html",
          body: "<!doctype html><html><head><title>Final</title></head><body><img src=\"hero.jpg\"></body></html>",
        }),
        writeText: async (_relPath, html) => {
          writtenHtml = html;
        },
      },
      { now: new Date("2026-07-27T12:34:56Z") }
    );

    expect(result).toMatchObject({
      finalUrl: "https://example.com/articles/final",
      relPath: "Web Archives/2026-07-27T12-34-56-example-com-start.html",
      linkRecord: false,
    });
    expect(writtenHtml).toContain(
      "<!-- saved from url=(0034)https://example.com/articles/final -->"
    );
    expect(writtenHtml).toContain('<base href="https://example.com/articles/final">');
  });

  it("preserves an existing base element", () => {
    const html = prepareArchivedHtml(
      '<html><head><base href="https://cdn.example/"></head></html>',
      "https://example.com/page"
    );
    expect(html.match(/<base\b/gi)).toHaveLength(1);
    expect(html).toContain("saved from url=");
  });

  it("writes an escaped local link record when fetching fails", async () => {
    let writtenHtml = "";
    const result = await archiveWebPage("https://example.com/?q=<unsafe>", {
      fetchPage: async () => {
        throw new Error("<network failed>");
      },
      writeText: async (_relPath, html) => {
        writtenHtml = html;
      },
    });

    expect(result.linkRecord).toBe(true);
    expect(result.warning).toBe("<network failed>");
    expect(writtenHtml).toContain("https://example.com/?q=&lt;unsafe&gt;");
    expect(writtenHtml).toContain("&lt;network failed&gt;");
    expect(writtenHtml).not.toContain("<network failed>");
  });

  it("does not hide a vault write failure", async () => {
    await expect(
      archiveWebPage("https://example.com", {
        fetchPage: async () => ({
          finalUrl: "https://example.com",
          contentType: "text/html",
          body: "<p>ok</p>",
        }),
        writeText: async () => {
          throw new Error("verified write failed");
        },
      })
    ).rejects.toThrow("verified write failed");
  });

  it("allocates a distinct readable path to every accepted source", () => {
    expect(
      researchArchiveRelPaths(
        [
          "https://example.com/a",
          "https://example.com/a?edition=2",
          "https://other.test/report",
        ],
        Date.parse("2026-07-27T12:34:56Z")
      )
    ).toEqual([
      "Web Archives/2026-07-27T12-34-56-example-com-a.html",
      "Web Archives/2026-07-27T12-34-57-example-com-a.html",
      "Web Archives/2026-07-27T12-34-58-other-test-report.html",
    ]);
  });

  it("queues only the final accepted sources, not every visited page", () => {
    expect(
      queueAcceptedResearchSources(
        [
          { url: "https://search.test/results", status: "reading" },
          { url: "https://used.test/report", title: "Observed title", status: "reading" },
        ],
        [
          { url: "https://used.test/report", title: "Validated report" },
          { url: "https://also-used.test/source", title: "Second source" },
        ]
      )
    ).toEqual([
      { url: "https://search.test/results", status: "reading" },
      {
        url: "https://used.test/report",
        title: "Validated report",
        status: "done",
        archiveStatus: "saving",
        archiveRelPath: undefined,
        archiveKind: undefined,
        archiveError: undefined,
      },
      {
        url: "https://also-used.test/source",
        title: "Second source",
        status: "done",
        archiveStatus: "saving",
      },
    ]);
  });
});
