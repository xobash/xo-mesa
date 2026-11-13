import { describe, expect, it } from "vitest";
import { createMentionScan, linkMention, linkTextFor, mentionNames, type UnlinkedMention } from "./unlinkedMentions";

/** Mentions in one note, found by the live resumable scan. */
function mentionsIn(source: string, names: string[]): UnlinkedMention[] {
  const scan = createMentionScan(["note.md"], () => source, names, () => 0);
  for (let slices = 0; !scan.advance(Infinity); slices++) {
    if (slices > 1) throw new Error("mention scan did not finish");
  }
  return scan.results()[0]?.mentions ?? [];
}

const texts = (source: string, names: string[]) => mentionsIn(source, names).map((m) => m.text);

describe("mentionNames", () => {
  it("uses the title and aliases, longest first, without duplicates or single characters", () => {
    expect(mentionNames({ title: "New York", aliases: ["NYC", "new york", "N", "New York City"] }))
      .toEqual(["New York City", "New York", "NYC"]);
  });
});

describe("unlinked mention matching", () => {
  it("matches whole words case-insensitively", () => {
    expect(texts("Alpha, alpha and ALPHA. Alphabet and pre-alpha.", ["Alpha"])).toEqual(["Alpha", "alpha", "ALPHA", "alpha"]);
    expect(texts("Café menu and cafés", ["Café"])).toEqual(["Café"]);
  });

  it("skips text that is already a link, code, a URL, markup, math or frontmatter", () => {
    const source = [
      "---", "title: Alpha", "---",
      "[[Alpha]] and [[Other|Alpha]] and ![[Alpha.png]]",
      "[Alpha](Alpha.md) [x][Alpha] <span title=\"Alpha\">x</span>",
      "`Alpha` and https://example.com/Alpha $Alpha$",
      "```", "Alpha", "```",
      "[Alpha]: https://example.com",
      "Plain Alpha here.",
    ].join("\n");
    const found = mentionsIn(source, ["Alpha"]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ text: "Alpha", before: "Plain ", after: " here." });
    expect(source.slice(found[0].start, found[0].end)).toBe("Alpha");
  });

  it("prefers the longest overlapping name", () => {
    expect(texts("I live in New York City.", ["New York City", "New York"])).toEqual(["New York City"]);
  });

  it("escapes regular-expression characters in names", () => {
    expect(texts("Use C++ (fast) daily; C+ is not it.", ["C++ (fast)"])).toEqual(["C++ (fast)"]);
  });

  it("bounds the result count", () => {
    expect(mentionsIn("Al ".repeat(60), ["Al"])).toHaveLength(50);
  });
});

describe("mention masking cost", () => {
  // Note bytes are untrusted (sync, import, Pi). Equal total input per side
  // (8 small runs, 1 large run), interleaved, best of five: linear scanning
  // gives about 1, quadratic scanning about 8.
  it("masks unclosed links, footnotes and tags on one line in linear time", () => {
    const work = (text: string, reps: number) => {
      const start = performance.now();
      for (let i = 0; i < reps; i++) mentionsIn(`${text} Alpha`, ["Alpha"]);
      return performance.now() - start;
    };
    for (const unit of ["[](", "[^", "<", "[[", "[]["]) {
      const small = unit.repeat(5_000), large = unit.repeat(40_000);
      expect(texts(`${large} Alpha`, ["Alpha"])).toEqual(["Alpha"]);
      const reps = Math.ceil(20 / Math.max(work(large, 1), 0.1));
      let smallBest = Infinity, largeBest = Infinity;
      for (let round = 0; round < 5; round++) {
        smallBest = Math.min(smallBest, work(small, 8 * reps));
        largeBest = Math.min(largeBest, work(large, reps));
      }
      expect(largeBest / smallBest).toBeLessThan(4);
    }
  }, 30000);
});

describe("linkMention", () => {
  it("inserts a plain link when the text matches the link text and an alias link otherwise", () => {
    expect(linkMention("Met Alpha.", { start: 4, end: 9, text: "Alpha" }, "Alpha")).toBe("Met [[Alpha]].");
    expect(linkMention("Met alpha.", { start: 4, end: 9, text: "alpha" }, "Alpha")).toBe("Met [[Alpha|alpha]].");
  });

  it("refuses when the text at the offsets changed", () => {
    expect(linkMention("Met Beta.", { start: 4, end: 9, text: "Alpha" }, "Alpha")).toBeNull();
  });
});

describe("mentions inside markup", () => {
  it("skips tags and footnote references", () => {
    expect(texts("See #project and [^project] about project.", ["project"])).toEqual(["project"]);
    expect(mentionsIn("See #project and [^project] about project.", ["project"])[0].start).toBe(34);
  });
  it("refuses an aliased link in a table row but allows an exact one", () => {
    expect(() => linkMention("| alpha | 1 |", { start: 2, end: 7, text: "alpha" }, "Alpha")).toThrow(/table row/);
    expect(linkMention("| Alpha | 1 |", { start: 2, end: 7, text: "Alpha" }, "Alpha")).toBe("| [[Alpha]] | 1 |");
  });
});

describe("linkTextFor", () => {
  it("uses the title when it resolves to the target, otherwise the vault path", () => {
    const resolve = (target: string) => (target === "Alpha" ? "Alpha.md" : null);
    expect(linkTextFor("Alpha.md", "Alpha", resolve)).toBe("Alpha");
    expect(linkTextFor("Archive/Alpha.md", "Alpha", resolve)).toBe("Archive/Alpha");
  });
  it("never writes a target that link syntax would split", () => {
    const resolve = () => "C# notes.md";
    expect(linkTextFor("C# notes.md", "C# notes", resolve)).toBeNull();
    expect(linkTextFor("Lang/C notes.md", "C|notes", () => null)).toBe("Lang/C notes");
  });
});

describe("createMentionScan", () => {
  it("scans in slices, counts unread notes, and reports only notes with mentions", () => {
    let clock = 0;
    const text: Record<string, string | undefined> = { "a.md": "Alpha here", "b.md": "nothing", "c.md": undefined, "d.md": "and alpha" };
    const scan = createMentionScan(Object.keys(text), (rel) => text[rel], ["Alpha"], () => (clock += 5));
    expect(scan.advance(4)).toBe(false);
    while (!scan.advance(4)) { /* next slice */ }
    expect(scan.results().map((r) => r.relPath)).toEqual(["a.md", "d.md"]);
    expect(scan.unread()).toBe(1);
  });

  it("finds mixed-case and non-ASCII names", () => {
    const names = ["ÉCOLE Normale", "Straße", "NYC"];
    const text: Record<string, string> = {
      "a.md": "the école normale and STRASSE", "b.md": "Die straße in nyc", "c.md": "[[NYC]] only", "d.md": "none",
    };
    const scan = createMentionScan(Object.keys(text), (rel) => text[rel], names, () => 0);
    while (!scan.advance(1)) { /* next slice */ }
    expect(scan.results()).toEqual([
      { relPath: "a.md", mentions: [{ start: 4, end: 17, text: "école normale", before: "the ", after: " and STRASSE" }] },
      { relPath: "b.md", mentions: [
        { start: 4, end: 10, text: "straße", before: "Die ", after: " in nyc" },
        { start: 14, end: 17, text: "nyc", before: "Die straße in ", after: "" },
      ] },
    ]);
    expect(scan.results().map((r) => r.relPath)).toEqual(["a.md", "b.md"]);
  });
});
