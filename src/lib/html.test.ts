import { describe, expect, it } from "vitest";
import {
  hydrateSavedHtml,
  localSavedHtmlAssetPath,
  rewriteCssAssetUrls,
  rewriteSavedHtml,
  rewriteSavedHtmlUrl,
  savedFromUrl,
  stripSavedHtmlPreviewCode,
} from "./html";

const asset = (path: string) => `asset://localhost${path}`;

describe("saved webpage HTML rewriting", () => {
  it("reads the original browser URL from saved-page comments", () => {
    expect(
      savedFromUrl(
        "<!-- saved from url=(0050)https://www.anthropic.com/news/fable-mythos-access -->"
      )
    ).toBe("https://www.anthropic.com/news/fable-mythos-access");
  });

  it("rewrites local sibling assets through the app asset protocol", () => {
    expect(
      rewriteSavedHtmlUrl(
        "./Page_files/app.css",
        "/vault/web/Page.html",
        asset,
        "https://example.com/articles/page"
      )
    ).toBe("asset://localhost/vault/web/Page_files/app.css");
  });

  it("strips inline and external scripts for markup-only previews", () => {
    expect(
      stripSavedHtmlPreviewCode(
        '<style>@font-face{font-family:x;src:url(/missing.woff2)}p{color:red}</style><p onclick="alert(1)">before</p><script>alert(1)</script><script src="app.js"></script><img onerror=fail><p>after</p>'
      )
    ).toBe('<style>p{color:red}</style><p>before</p><img><p>after</p>');
  });

  it("rewrites root-relative URLs against the original site", () => {
    expect(
      rewriteSavedHtmlUrl(
        "/_next/static/app.js",
        "/vault/web/Page.html",
        asset,
        "https://example.com/articles/page"
      )
    ).toBe("https://example.com/_next/static/app.js");
  });

  it("leaves hashes, data URLs, and existing protocol URLs alone", () => {
    expect(rewriteSavedHtmlUrl("#main", "/vault/Page.html", asset, null)).toBe("#main");
    expect(rewriteSavedHtmlUrl("data:image/png;base64,abc", "/vault/Page.html", asset, null)).toBe(
      "data:image/png;base64,abc"
    );
    expect(rewriteSavedHtmlUrl("asset://localhost/vault/app.css", "/vault/Page.html", asset, null)).toBe(
      "asset://localhost/vault/app.css"
    );
  });

  it("rewrites href, src, poster, action, and srcset attributes", () => {
    const html = rewriteSavedHtml(
      [
        "<!-- saved from url=(0024)https://site.test/news/a -->",
        "<html><head><link href=\"./A_files/main.css\"></head>",
        "<body>",
        "<img src='./A_files/hero.png' srcset='./A_files/small.png 1x, ./A_files/big.png 2x'>",
        "<video poster=\"./A_files/poster.jpg\"></video>",
        "<form action='/signup'></form>",
        "</body></html>",
      ].join(""),
      "/vault/web/A.html",
      asset
    );

    expect(html).toContain('<base href="asset://localhost/vault/web/">');
    expect(html).toContain('href="asset://localhost/vault/web/A_files/main.css"');
    expect(html).toContain("src='asset://localhost/vault/web/A_files/hero.png'");
    expect(html).toContain(
      "srcset='asset://localhost/vault/web/A_files/small.png 1x, asset://localhost/vault/web/A_files/big.png 2x'"
    );
    expect(html).toContain('poster="asset://localhost/vault/web/A_files/poster.jpg"');
    expect(html).toContain("action='https://site.test/signup'");
  });

  it("resolves local saved assets relative to their owning file", () => {
    expect(
      localSavedHtmlAssetPath(
        "./Page_files/app.css",
        "/vault/web/Page.html"
      )
    ).toBe("/vault/web/Page_files/app.css");
    expect(
      localSavedHtmlAssetPath("../shared/app.css", "/vault/web/Page_files/app.css")
    ).toBe("/vault/web/shared/app.css");
    expect(localSavedHtmlAssetPath("/_next/app.css", "/vault/web/Page.html")).toBeNull();
    expect(localSavedHtmlAssetPath("https://site.test/app.css", "/vault/web/Page.html")).toBeNull();
  });

  it("rewrites CSS url() references relative to the stylesheet path", () => {
    const css = rewriteCssAssetUrls(
      [
        "@font-face{src:url('../fonts/site.woff2') format('woff2')}",
        ".hero{background-image:url(\"./hero.png\")}",
        ".icon{mask:url(/icons/mask.svg)}",
      ].join("\n"),
      "/vault/web/Page_files/css/app.css",
      asset,
      "https://example.com/news/page"
    );

    expect(css).toContain(
      "url('asset://localhost/vault/web/Page_files/fonts/site.woff2')"
    );
    expect(css).toContain(
      'url("asset://localhost/vault/web/Page_files/css/hero.png")'
    );
    expect(css).toContain("url(https://example.com/icons/mask.svg)");
  });

  it("inlines local saved stylesheets before srcDoc rendering", async () => {
    const html = await hydrateSavedHtml(
      [
        "<!-- saved from url=(0028)https://example.com/news/a -->",
        '<html><head><link rel="stylesheet" href="./A_files/app.css"></head>',
        '<body><script src="./A_files/app.js"></script></body></html>',
      ].join(""),
      "/vault/web/A.html",
      asset,
      async (path) => {
        if (path.endsWith("app.css")) return ".hero{background:url('./hero.png')}";
        if (path.endsWith("app.js")) return "window.__mesaSavedPage = true;";
        throw new Error("missing");
      }
    );

    expect(html).toContain('<style data-mesa-href="./A_files/app.css">');
    expect(html).toContain(
      "background:url('asset://localhost/vault/web/A_files/hero.png')"
    );
    expect(html).toContain('data-mesa-src="./A_files/app.js"');
    expect(html).not.toContain('<link rel="stylesheet" href="./A_files/app.css">');
  });

  it("removes scripts without reading them for markup-only previews", async () => {
    const reads: string[] = [];
    const html = await hydrateSavedHtml(
      [
        '<html><head><link rel="stylesheet" href="./A_files/app.css"></head>',
        '<body><script>window.inline = true;</script>',
        '<script src="./A_files/app.js"></script><p>Kept</p></body></html>',
      ].join(""),
      "/vault/web/A.html",
      asset,
      async (path) => {
        reads.push(path);
        if (path.endsWith("app.css")) return "body{color:red}";
        if (path.endsWith("app.js")) return "window.external = true";
        throw new Error("missing");
      },
      { scripts: false }
    );

    expect(html).toContain("<p>Kept</p>");
    expect(html).toContain("body{color:red}");
    expect(html).not.toContain("<script");
    expect(reads.some((path) => path.endsWith("app.js"))).toBe(false);
  });

  it("reuses an already-stripped preview and still strips inlined font rules", async () => {
    const stripped = stripSavedHtmlPreviewCode(
      '<link rel="stylesheet" href="./A_files/app.css"><p onload="bad()">Kept</p><script>bad()</script>'
    );
    const html = await hydrateSavedHtml(
      stripped,
      "/vault/web/A.html",
      asset,
      async () => "@font-face{font-family:x;src:url(/missing.woff2)}p{color:red}",
      { scripts: false, previewCodeStripped: true }
    );

    expect(html).toContain("<p>Kept</p>");
    expect(html).toContain("p{color:red}");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onload=");
    expect(html).not.toContain("@font-face");
  });

  it("keeps hostile stylesheet text inside the style element in preview mode", async () => {
    const html = await hydrateSavedHtml(
      '<link rel="stylesheet" href="./A_files/app.css"><p>Kept</p>',
      "/vault/web/A.html",
      asset,
      async () => "</style><script>bad()</script><style>p{color:red}",
      { scripts: false }
    );

    expect(html).toContain("<\\/style><script>bad()</script><style>");
    expect(html).not.toContain("</style><script>bad()");
  });
});
