// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { ByteSource, memoryRangeReader, type RangeReader } from "./byteSource";
import { epubChapterMarkup, openEpub, resolveEpubPath } from "./epub";
import { savedHtmlFrameDocument } from "./html";

const text = (value: string) => new TextEncoder().encode(value);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const chapter = (body: string, head = "") => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>c</title>${head}</head><body>${body}</body></html>`;

const openBook = async (data: Uint8Array) => openEpub(await ByteSource.open(memoryRangeReader(data)));

function book(options: { nav?: boolean; extra?: Record<string, Uint8Array> } = {}): Uint8Array {
  const nav = options.nav !== false;
  const files: Record<string, Uint8Array> = {
    mimetype: text("application/epub+zip"),
    "META-INF/container.xml": text(`<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
    "OEBPS/content.opf": text(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Test Book</dc:title><dc:creator>A. Writer</dc:creator></metadata>
      <manifest>
        ${nav ? `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>` : ""}
        <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
        <item id="one" href="text/one.xhtml" media-type="application/xhtml+xml"/>
        <item id="two" href="text/two.xhtml" media-type="application/xhtml+xml"/>
        <item id="img" href="images/pic.png" media-type="image/png"/>
        <item id="css" href="style.css" media-type="text/css"/>
      </manifest>
      <spine toc="ncx"><itemref idref="two"/><itemref idref="one"/></spine></package>`),
    "OEBPS/nav.xhtml": text(chapter(`<nav epub:type="toc"><ol><li><a href="text/two.xhtml">Second first</a><ol><li><a href="text/one.xhtml#part">Nested one</a></li></ol></li></ol></nav>`)),
    "OEBPS/toc.ncx": text(`<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>
      <navPoint id="a"><navLabel><text>From NCX</text></navLabel><content src="text/one.xhtml"/>
        <navPoint id="b"><navLabel><text>Child</text></navLabel><content src="text/two.xhtml"/></navPoint></navPoint></navMap></ncx>`),
    "OEBPS/style.css": text(`p { color: blue; background: url("images/pic.png"); } h1 { background: url(https://tracker.example/x.png); }`),
    "OEBPS/images/pic.png": PNG,
    "OEBPS/text/one.xhtml": text(chapter(
      `<h1 id="part">One</h1>
       <script>window.parent.boom = 1</script>
       <p onclick="alert(1)">Text <a href="two.xhtml">next</a></p>
       <img src="../images/pic.png" alt="pic"/>
       <img src="https://tracker.example/pixel.gif" alt="remote"/>
       <img src="asset://localhost/etc/secret.png" alt="vault"/>
       <iframe src="https://example.com"></iframe>
       <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="../images/pic.png"/></svg>`,
      `<link rel="stylesheet" href="../style.css"/><link rel="stylesheet" href="https://cdn.example/remote.css"/>`
    )),
    "OEBPS/text/two.xhtml": text(chapter("<p>Two</p>")),
    ...options.extra,
  };
  return zipSync(files, { level: 0 });
}

describe("EPUB reader", () => {
  it("reads metadata, spine order and the nav table of contents", async () => {
    const opened = await openBook(book());
    expect(opened.title).toBe("Test Book");
    expect(opened.creator).toBe("A. Writer");
    expect(opened.spine).toEqual(["OEBPS/text/two.xhtml", "OEBPS/text/one.xhtml"]);
    expect(opened.toc).toEqual([
      { label: "Second first", depth: 0, spineIndex: 0 },
      { label: "Nested one", depth: 1, spineIndex: 1 },
    ]);
  });

  it("falls back to the NCX table of contents", async () => {
    expect((await openBook(book({ nav: false }))).toc).toEqual([
      { label: "From NCX", depth: 0, spineIndex: 1 },
      { label: "Child", depth: 1, spineIndex: 0 },
    ]);
  });

  it("renders a sanitized chapter with package images only and no remote or vault URLs", async () => {
    const opened = await openBook(book());
    const html = savedHtmlFrameDocument(await epubChapterMarkup(opened, 1));
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelector("script, iframe")).toBeNull();
    expect(doc.querySelector("[onclick]")).toBeNull();
    expect(doc.querySelector("a[href]")).toBeNull();
    // The frame's own CSP names asset: as a source; the content must not.
    expect(html.replace(/<meta[^>]*>/g, "")).not.toMatch(/tracker\.example|cdn\.example|asset:|example\.com/);
    const sources = Array.from(doc.querySelectorAll("img")).map((img) => img.getAttribute("src"));
    expect(sources.filter((src) => src?.startsWith("data:image/png;base64,"))).toHaveLength(2);
    expect(sources.filter((src) => src && !src.startsWith("data:image/png"))).toEqual([]);
    expect(html).toMatch(/url\("data:image\/png;base64,/);
    expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content")).toMatch(/script-src 'none'/);
    expect(doc.body.textContent).toContain("One");
  });

  it("opens a book and renders a chapter by reading only the entries it needs", async () => {
    const data = book({ extra: { "OEBPS/media/film.bin": new Uint8Array(24 * 1024 * 1024) } });
    const calls: number[] = [];
    const read = memoryRangeReader(data);
    const counted: RangeReader = (offset, len) => { calls.push(len); return read(offset, len); };
    const opened = await openEpub(await ByteSource.open(counted));
    const html = await epubChapterMarkup(opened, 1);
    expect(html).toContain("One");
    expect(html).toMatch(/data:image\/png;base64,/);
    expect(Math.max(...calls)).toBeLessThanOrEqual(1024 * 1024);
    expect(calls.reduce((n, len) => n + len, 0)).toBeLessThan(256 * 1024);
  });

  it("refuses a book without a package and paths that climb out of it", async () => {
    await expect(openBook(zipSync({ mimetype: text("application/epub+zip") }))).rejects.toThrow(/missing META-INF\/container.xml/);
    expect(resolveEpubPath("OEBPS/text/one.xhtml", "../../../etc/passwd")).toBeNull();
    expect(resolveEpubPath("OEBPS/text/one.xhtml", "/abs.png")).toBeNull();
    expect(resolveEpubPath("OEBPS/text/one.xhtml", "https://x/y.png")).toBeNull();
    expect(resolveEpubPath("OEBPS/text/one.xhtml", "../images/a%20b.png#x")).toBe("OEBPS/images/a b.png");
  });
});
