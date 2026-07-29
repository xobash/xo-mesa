import { describe, it, expect } from "vitest";
import {
  parseSearchQuery,
  searchVault,
  SEARCH_RESULT_LIMIT,
  type SearchFile,
  type SearchPass,
} from "./search";

describe("parseSearchQuery", () => {
  it("extracts ext: and type: filters", () => {
    expect(parseSearchQuery("ext:pdf budget")).toEqual({
      term: "budget",
      ext: "pdf",
      quoted: false,
    });
    expect(parseSearchQuery("type:md alpha beta")).toEqual({
      term: "alpha beta",
      ext: "md",
      quoted: false,
    });
  });

  it("treats a lone .ext token as a filter", () => {
    expect(parseSearchQuery(".png")).toEqual({ term: "", ext: "png", quoted: false });
    expect(parseSearchQuery("logo .svg")).toEqual({
      term: "logo",
      ext: "svg",
      quoted: false,
    });
  });

  it("returns plain terms unchanged", () => {
    expect(parseSearchQuery("hello world")).toEqual({
      term: "hello world",
      ext: null,
      quoted: false,
    });
  });

  it("unwraps a quoted phrase", () => {
    expect(parseSearchQuery('"hidden assumptions"')).toEqual({
      term: "hidden assumptions",
      ext: null,
      quoted: true,
    });
    // whitespace inside a phrase collapses the same way a bare term does
    expect(parseSearchQuery('"  spaced   out  "')).toEqual({
      term: "spaced out",
      ext: null,
      quoted: true,
    });
  });

  it("keeps a filter alongside a quoted phrase", () => {
    expect(parseSearchQuery('ext:txt "hidden assumptions"')).toEqual({
      term: "hidden assumptions",
      ext: "txt",
      quoted: true,
    });
  });

  it("does not treat an unbalanced or inner quote as a phrase", () => {
    expect(parseSearchQuery('"open ended')).toEqual({
      term: '"open ended',
      ext: null,
      quoted: false,
    });
    expect(parseSearchQuery('say "hi" there')).toEqual({
      term: 'say "hi" there',
      ext: null,
      quoted: false,
    });
  });

  it("leaves ext:-looking text inside a phrase alone", () => {
    expect(parseSearchQuery('"ext:pdf is a filter"')).toEqual({
      term: "ext:pdf is a filter",
      ext: null,
      quoted: true,
    });
  });
});

// ---------------------------------------------------------------------------

function file(relPath: string, name: string, ext = "md"): SearchFile {
  return { relPath, name, ext };
}

const FILES: SearchFile[] = [
  file("Budget.md", "Budget"),
  file("notes/q3.md", "q3"),
  file("readme.md", "readme"),
  file("plan.pdf", "plan", "pdf"),
  file("archive/Ledger.md", "Ledger"),
];

const CACHE: Record<string, string> = {
  "Budget.md": "The Budget for Q3 is set. Budget review pending.",
  "notes/q3.md": "Quarterly planning. No numbers yet.",
  "readme.md": "Mesa is a local-first note vault.",
  "plan.pdf": "",
  "archive/Ledger.md": "Nothing relevant in this body.",
};

/** A full (non-incremental) pass — the reference every narrowed pass must equal. */
const full = (q: string) => searchVault(FILES, CACHE, q);

describe("searchVault matching", () => {
  it("matches case-insensitively regardless of query casing", () => {
    // Regression: lowering only the note text made every capitalised query
    // return nothing, even against a note literally containing the word.
    for (const q of ["budget", "Budget", "BUDGET", "BuDgEt"]) {
      const hits = full(q).hits;
      expect(hits.map((h) => h.rel), `query ${q}`).toEqual(["Budget.md"]);
      expect(hits[0].count, `query ${q}`).toBe(2);
    }
  });

  it("matches a capitalised file name from any query casing", () => {
    // "Ledger" appears in the NAME only — its body has no match — so this
    // exercises the name comparison independently of the content scan.
    for (const q of ["ledger", "Ledger", "LEDGER"]) {
      const hits = full(q).hits;
      expect(hits.map((h) => h.rel), `query ${q}`).toEqual(["archive/Ledger.md"]);
      expect(hits[0].snippet, `query ${q}`).toBe("");
      expect(hits[0].count, `query ${q}`).toBe(0);
    }
  });

  it("requires two characters unless an ext filter is present", () => {
    const pass = full("b");
    expect(pass.hits).toEqual([]);
    // A pass that never scanned must not be narrowable.
    expect(pass.candidates).toBeNull();
  });

  it("lists every file of an ext filter with no term", () => {
    const pass = full(".pdf");
    expect(pass.hits.map((h) => h.rel)).toEqual(["plan.pdf"]);
    expect(pass.hits[0].snippet).toBe("plan.pdf");
    expect(pass.hits[0].count).toBe(0);
  });

  it("ranks by match count and builds a snippet around the first hit", () => {
    const hit = full("q3").hits[0];
    expect(hit.rel).toBe("Budget.md");
    expect(hit.snippet).toContain("Q3");
    expect(hit.snippet.endsWith("...")).toBe(true);
  });
});

describe("searchVault incremental narrowing", () => {
  /** Feed a typing sequence through the incremental path. */
  function type(queries: string[]): SearchPass {
    let pass: SearchPass | null = null;
    for (const q of queries) pass = searchVault(FILES, CACHE, q, pass);
    return pass as SearchPass;
  }

  it("matches a full scan while the term grows", () => {
    const typed = type(["bu", "bud", "budg", "budge", "budget"]);
    expect(typed.hits).toEqual(full("budget").hits);
  });

  it("matches a full scan when the term shrinks (backspace)", () => {
    const typed = type(["budget", "budge", "bud", "bu"]);
    expect(typed.hits).toEqual(full("bu").hits);
  });

  it("does not narrow across a changed ext filter", () => {
    let pass = searchVault(FILES, CACHE, "plan .pdf");
    // Same term, filter dropped: the md notes must come back into scope.
    pass = searchVault(FILES, CACHE, "plan", pass);
    expect(pass.hits.map((h) => h.rel)).toEqual(full("plan").hits.map((h) => h.rel));
    expect(pass.hits.map((h) => h.rel)).toContain("notes/q3.md");
  });

  it("does not narrow from a pass that never scanned", () => {
    const short = searchVault(FILES, CACHE, "b");
    const next = searchVault(FILES, CACHE, "bu", short);
    expect(next.hits).toEqual(full("bu").hits);
  });

  it("keeps candidates uncapped so the display cap cannot drop a later match", () => {
    // More matches than the render cap, with the only narrower match last.
    const many: SearchFile[] = [];
    const cache: Record<string, string> = {};
    const n = SEARCH_RESULT_LIMIT + 40;
    for (let i = 0; i < n; i++) {
      const rel = `n${String(i).padStart(3, "0")}.md`;
      many.push(file(rel, `n${String(i).padStart(3, "0")}`));
      cache[rel] = i === n - 1 ? "aab needle" : "aa filler";
    }
    const wide = searchVault(many, cache, "aa");
    expect(wide.hits).toHaveLength(SEARCH_RESULT_LIMIT);
    expect(wide.candidates).toHaveLength(n);

    const narrowed = searchVault(many, cache, "aab", wide);
    expect(narrowed.hits.map((h) => h.rel)).toEqual([`n${String(n - 1).padStart(3, "0")}.md`]);
    expect(narrowed.hits).toEqual(searchVault(many, cache, "aab").hits);
  });

  it("narrowing only reads the surviving notes", () => {
    const reads: string[] = [];
    const probe = new Proxy(CACHE, {
      get(t, k: string) {
        reads.push(k);
        return t[k];
      },
    });
    const wide = searchVault(FILES, probe, "bud");
    reads.length = 0;
    searchVault(FILES, probe, "budge", wide);
    expect(reads).toEqual(["Budget.md"]);
  });
});
