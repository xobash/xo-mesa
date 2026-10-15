import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { codeLineScanner, inlineCodeSpans, proseText } from "./markdownCode";
import { extractLinks, extractTags } from "./markdownExtract";
import { parseMarkdown } from "./markdownParser";
import { parseTasks } from "./taskParsing";
import { encodeDocument } from "./documentCodec";
import { rewriteInboundLinks } from "./linkRewrite";

const md = new MarkdownIt({ html: true, linkify: true });
/** Generated differential tests are CPU-bound; leave room for coverage runs on a busy machine. */
const GENERATED_TIMEOUT = 60_000;

/** Line indexes markdown-it renders inside a fence or indented code block. */
function renderedCodeLines(source: string): Set<number> {
  const lines = new Set<number>();
  for (const token of md.parse(source, {})) {
    if ((token.type === "fence" || token.type === "code_block") && token.map) {
      for (let line = token.map[0]; line < token.map[1]; line++) lines.add(line);
    }
  }
  return lines;
}

/** Non-blank lines where the scanner and markdown-it disagree. */
function disagreements(source: string): number[] {
  const expected = renderedCodeLines(source);
  const isCode = codeLineScanner();
  return source.split("\n").flatMap((line, index) =>
    isCode(line) !== expected.has(index) && !/^[>\s]*$/.test(line) ? [index] : []);
}

const codeLines = (source: string) => {
  const isCode = codeLineScanner();
  return source.split("\n").flatMap((line, index) => (isCode(line) ? [index] : []));
};

function random(seed: number): () => number {
  return () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
}
const pick = <T,>(next: () => number, items: readonly T[]): T => items[Math.floor(next() * items.length)];

describe("codeLineScanner", () => {
  it.each([
    ["a longer fence holds a shorter one", "````\n```\n#inner\n````\n#outside", [0, 1, 2, 3]],
    ["a closer with an info string does not close", "```\nx\n```js\n- [ ] A\n```\n- [ ] B", [0, 1, 2, 3, 4]],
    ["a backtick info string with a backtick is prose", "``` a`b\n- [ ] H", []],
    ["a tilde info string may hold a backtick", "~~~ a`b\nx\n~~~", [0, 1, 2]],
    ["the other fence character does not close", "```\n~~~\nx\n```\ny", [0, 1, 2, 3]],
    ["an unclosed fence runs to the end", "a\n```\nb\nc", [1, 2, 3]],
    ["a CRLF closer closes", "```\r\nx\r\n```\r\ny", [0, 1, 2]],
    ["a fence nested in a list item", "- item\n\n  ```\n  - [ ] I\n  ```\n- [ ] J", [2, 3, 4]],
    ["a fence ends with its list item", "- item\n  ```\n  #code\n#outside", [1, 2]],
    ["a fence ends with its block quote", "> ```\n> #quoted\n#out", [0, 1]],
    ["a quoted fence closes inside the quote", "> ```\n> #quoted\n> ```\n#out", [0, 1, 2]],
    ["a fence line indented 4 columns is indented code", "para\n\n    ```\n#visible", [2]],
    ["indented code after a heading", "# Todo\n\t- [ ] a", [1]],
    ["indented text continues a paragraph", "para\n    still para", []],
    ["a nested task list is not code", "- [ ] parent\n    - [ ] child\n\t- [ ] tab child", []],
    ["code inside a list item needs 4 columns past its content", "- a\n\n      code\n    not code", [2]],
    ["an HTML block holds no code", "<div>\n```\n    x\n</div>", []],
    ["a blank line ends an HTML block", "<div>\n\n```\nx\n```", [2, 3, 4]],
  ])("%s", (_name, source, expected) => {
    expect(codeLines(source)).toEqual(expected);
    expect(disagreements(source)).toEqual([]);
  });

  it("agrees with markdown-it on generated block structure", () => {
    const prefixes = ["", "", "", "", "> ", ">", "> > ", ">>", "  > ", ">\t", "- ", "1) "];
    const indents = ["", "", "", " ", "  ", "   ", "    ", "      ", "\t", "        "];
    const bodies = [
      "```", "````", "~~~", "~~~~", "```js", "``` a`b", "~~~ a`b", "``` x", "```  ", "   ```",
      "- item", "+ item", "* item", "1. item", "1) item", "2. item", "10. item", "-", "-\titem",
      "- [ ] task", "- - [ ] t", "- ```", "   - ```", "- > ```", "1.     code", "> quote", "> - [ ] t",
      "#tag text", "# Heading", "## H2", "para text", "para `` ``` `` x", "---", "***", "* * *",
      "===", "=", "--", "<div>", "\t\tcode", "", "",
    ];
    const next = random(42);
    for (let n = 0; n < 3000; n++) {
      const lines = Array.from({ length: 2 + Math.floor(next() * 14) },
        () => pick(next, prefixes) + pick(next, indents) + pick(next, bodies));
      const source = lines.join("\n");
      expect(disagreements(source), JSON.stringify(source)).toEqual([]);
    }
  }, GENERATED_TIMEOUT);

  it("agrees with markdown-it on generated Markdown-significant text", () => {
    const atoms = [
      " ", " ", " ", "  ", "    ", "\t", ">", "> ", "-", "- ", "*", "+ ", "`", "```", "~~~", "````",
      "1", "1. ", "2) ", "#", "# ", "<div>", "<!--", "-->", "<pre>", "</pre>", "<a href=\"x\">", "a",
      "word", "\n", "\n", "\n", "\n\n", "=", "\r\n", "[ ] ",
    ];
    const next = random(2026);
    for (let n = 0; n < 6000; n++) {
      let source = "";
      for (let k = 4 + Math.floor(next() * 40); k > 0; k--) source += pick(next, atoms);
      expect(disagreements(source), JSON.stringify(source)).toEqual([]);
    }
  }, GENERATED_TIMEOUT);
});

describe("inlineCodeSpans", () => {
  it.each([
    ["`a` b `c`", [0, 3, 6, 9]],
    ["``a ` b``", [0, 9]],
    ["``a```b``", [0, 9]],
    ["`unclosed", []],
    ["\\`not code`", []],
    ["\\``code``", []],
    ["\\```code``", [2, 10]],
  ])("%s", (line, expected) => {
    expect(inlineCodeSpans(line)).toEqual(expected);
  });
});

describe("proseText", () => {
  it("returns the source itself when there is no code", () => {
    const source = "plain #tag [[Link]]";
    expect(proseText(source)).toBe(source);
  });
  it("blanks code and keeps offsets", () => {
    const source = "a `b` c\n```\nd\n```\ne";
    expect(proseText(source)).toBe("a     c\n   \n \n   \ne");
  });
});

describe("tags, links and tasks skip what the renderer shows as code", () => {
  /** Tags in the text markdown-it shows outside code. */
  const renderedTags = (source: string) => {
    const text = md.parse(source, {})
      .filter((token) => token.type === "inline")
      .map((token) => (token.children ?? [])
        .map((child) => (child.type === "text" ? child.content : child.type.endsWith("break") ? "\n" : "\0"))
        .join(""))
      .join("\n");
    return [...new Set([...text.matchAll(/(?:^|\s)#([A-Za-z][\w/-]*)/g)].map((m) => m[1]))].sort();
  };
  /** Note links in Mesa's own rendered HTML. */
  const renderedLinks = (source: string) => [
    ...[...parseMarkdown(source).matchAll(/class="wikilink" data-target="([^"]+)"/g)].map((m) => m[1]),
    // Linkify turns a bare `D.md` into http://D.md (a real top-level domain); that is no note link.
    ...[...parseMarkdown(source).matchAll(/<a href="(?![a-z]+:)([^"]+\.md)"/g)].map((m) => m[1]),
  ].sort();

  it("reports the audit cases as the renderer shows them", () => {
    expect(extractTags("````\n```\n#inner\n````\n#outside")).toEqual(["outside"]);
    expect(extractTags("use `` ```x `` here #real\n\n```\n#fake\n```\n#after")).toEqual(["real", "after"]);
    expect(extractTags("```\nx\n```js\n#stillcode\n```\n#out")).toEqual(["out"]);
    expect(extractTags("#top\n```\n#code")).toEqual(["top"]);
    expect(extractTags("text `a #inline` #real")).toEqual(["real"]);
    expect(extractTags("> ```\n> #quoted\n> ```\n#out")).toEqual(["out"]);
    expect(extractTags("para\n\n    ```\n#visible")).toEqual(["visible"]);
    expect(extractLinks("```\n[[InCode]]\n```\n`[[Inline]]` [[Real]] [`Doc.md`](Doc.md)")).toEqual(["Real", "Doc.md"]);
    expect(extractLinks("a `b\n[[Wrapped]]` c [[After]]")).toEqual(["After"]);
    expect(extractTags("a `b\n#wrapped` c #after")).toEqual(["after"]);
  });

  it("agrees with markdown-it for generated notes", () => {
    const pieces = [
      // Links end with a space: the extractor skips a link that starts right after another one.
      "#a", "#b/c", "`#d`", "`` #e ``", "[[A]]", "`[[B]]`", "[c](C.md) ", "[`d`](D.md) ", "```", "~~~",
      "    ", "  ", "- ", "> ", "\n", "\n", "\n\n", "text", "x#f", " ",
    ];
    const next = random(7);
    for (let n = 0; n < 3000; n++) {
      let source = "";
      for (let k = 3 + Math.floor(next() * 24); k > 0; k--) source += pick(next, pieces);
      expect([...extractTags(source)].sort(), JSON.stringify(source)).toEqual(renderedTags(source));
      expect([...extractLinks(source)].sort(), JSON.stringify(source)).toEqual(renderedLinks(source));
    }
  }, GENERATED_TIMEOUT);

  it.each([
    ["closer with an info string", "```\ncode\n```js\n- [ ] A\n```\n- [ ] B", ["B"]],
    ["info string with a backtick", "``` a`b\n- [ ] H\n", ["H"]],
    ["other fence character", "```\n~~~\n- [ ] D\n```\n- [ ] E", ["E"]],
    ["longer outer fence", "````\n```\n- [ ] F\n````\n- [ ] G", ["G"]],
    ["fence nested in a list", "- item\n\n  ```\n  - [ ] I\n  ```\n- [ ] J", ["J"]],
    ["indented fence line", "text\n\n    ```\n- [ ] T", ["T"]],
    ["fence ended by its list item", "- [ ] K\n  ```\n  - [ ] L\n- [ ] M", ["K", "M"]],
  ])("tasks: %s", (_name, source, expected) => {
    expect(parseTasks("a.md", "a", source).map((task) => task.text)).toEqual(expected);
  });
});

describe("rename repair edits prose only", () => {
  const rename = (content: string) => rewriteInboundLinks(
    "src.md", content, "Old.md", "New.md",
    (target) => (target.toLowerCase().replace(/\.md$/, "") === "old" ? "Old.md" : null), true, true,
  ).text;

  it.each([
    ["a closer with an info string keeps the fence open", "```\nx\n```js\n[a](Old.md)\n```\n[b](Old.md)", "```\nx\n```js\n[a](Old.md)\n```\n[b](New.md)"],
    ["a backtick line with a backtick info string is prose", "``` a`b\n[[Old]]", "``` a`b\n[[New]]"],
    ["indented code stays as written", "para\n\n    [[Old]]\n\n[[Old]]", "para\n\n    [[Old]]\n\n[[New]]"],
    ["a fence ends with its list item", "- a\n  ```\n  [[Old]]\n[[Old]]", "- a\n  ```\n  [[Old]]\n[[New]]"],
    ["a label may hold inline code", "See [`Old.md`](Old.md) here", "See [`Old.md`](New.md) here"],
    ["an alias may hold inline code", "[[Old|the `Old` note]]", "[[New|the `Old` note]]"],
    ["inline code is never a link", "`[[Old]]` and [[Old]]", "`[[Old]]` and [[New]]"],
    ["a definition must start its line", "`x` [a]: Old.md\n[b]: Old.md", "`x` [a]: Old.md\n[b]: New.md"],
    ["inline code may cross a line break", "a `b\n[[Old]]` c\n\n[[Old]]", "a `b\n[[Old]]` c\n\n[[New]]"],
    ["CRLF line endings are kept", "```\r\n[[Old]]\r\n```\r\n[[Old]]\r\n", "```\r\n[[Old]]\r\n```\r\n[[New]]\r\n"],
  ])("%s", (_name, source, expected) => {
    expect(rename(source)).toBe(expected);
  });
  it("rewrites exactly the links the renderer shows and keeps code byte-exact", () => {
    const code = (source: string) => md.parse(source, {}).flatMap((token) => [
      ...(token.type === "fence" || token.type === "code_block" ? [token.content] : []),
      ...(token.children ?? []).filter((child) => child.type === "code_inline").map((child) => child.content),
    ]);
    const targets = (source: string, name: string) => {
      const html = parseMarkdown(source);
      return [...html.matchAll(/class="wikilink" data-target="([^"]+)"/g)].filter((m) => m[1] === name).length +
        [...html.matchAll(/<a href="([^"]+)"/g)].filter((m) => m[1] === `${name}.md`).length;
    };
    const pieces = [
      "[[Old]]", "`[[Old]]`", "`` [[Old]] ``", "[`x`](Old.md) ", "[t](Old.md) ", "```", "~~~", "`", "    ",
      "- ", "> ", "\n", "\n", "\n\n", "text ", "#tag ",
    ];
    const next = random(99);
    for (let n = 0; n < 3000; n++) {
      let source = "";
      for (let k = 3 + Math.floor(next() * 20); k > 0; k--) source += pick(next, pieces);
      const after = rename(source);
      const label = JSON.stringify(source);
      expect(code(after), label).toEqual(code(source));
      expect(targets(after, "Old"), label).toBe(0);
      expect(targets(after, "New"), label).toBe(targets(source, "Old"));
    }
  }, GENERATED_TIMEOUT);
});

describe("other text files are not Markdown", () => {
  const txt = "intro\n\n    - [ ] indented [[Indented]] #indented\n  ```\n  - [ ] fenced [[Fenced]] #fenced\n  ```js\n  ```\n- [ ] after [[After]] #after";

  it("only fenced blocks are code, at any indentation", () => {
    const isCode = codeLineScanner(false);
    expect(txt.split("\n").map((line) => isCode(line))).toEqual([false, false, false, true, true, true, true, false]);
  });

  it("tasks, links and tags follow plain-text rules", () => {
    expect(parseTasks("todo.txt", "todo", txt).map((task) => task.text)).toEqual(["indented [[Indented]] #indented", "after [[After]] #after"]);
    expect(extractLinks(txt, false)).toEqual(["Indented", "After"]);
    expect(extractTags(txt, false)).toEqual(["indented", "after"]);
    // The same text as a Markdown note: the indented line is code there.
    expect(parseTasks("todo.md", "todo", txt).map((task) => task.text)).toEqual(["after [[After]] #after"]);
  });

  it("index records keep each file's own task rules", () => {
    expect(encodeDocument(txt, false).tasks.map((task) => task.text)).toEqual(["indented [[Indented]] #indented", "after [[After]] #after"]);
    expect(encodeDocument(txt).tasks.map((task) => task.text)).toEqual(["after [[After]] #after"]);
  });

  it("rename repair edits indented text but not fences or inline code", () => {
    const text = "    [[Old]]\n```\n[[Old]]\n```\n`[[Old]]` [[Old]]";
    expect(rewriteInboundLinks("notes.txt", text, "Old.md", "New.md", (t) => (t === "Old" ? "Old.md" : null), true, true).text)
      .toBe("    [[New]]\n```\n[[Old]]\n```\n`[[Old]]` [[New]]");
  });
});
