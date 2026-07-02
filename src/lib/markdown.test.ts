import { describe, it, expect } from "vitest";
import {
  extractLinks,
  extractTags,
  extractFirstImage,
  parseFrontmatter,
  extractAliases,
  renderMarkdown,
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

  it("passes raw HTML through", () => {
    expect(renderMarkdown("<div class='x'>hi</div>")).toContain(
      "<div class='x'>hi</div>"
    );
  });
});
