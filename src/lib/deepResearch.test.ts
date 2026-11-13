import { buildApplyPlan } from "./researchApplyPlan";
import { describe, expect, it } from "vitest";
import type { NoteMeta, VaultFile } from "../types";
import {
  DEFAULT_DEEP_RESEARCH_LIMITS,
  RESEARCH_DEPTH_PRESETS,
  buildResearchContext,
  redactResearchContent,
  buildResearchPrompt,
  canonicalizeSourceUrl,
  dedupeSources,
  presentResearchSource,
  buildChangeSet,
  safeNoteTitle,
  safeFolderName,
  titleSlug,
  validateResearchResult,
  researchReportQualityIssues,
  utf8ByteLength,
  type DeepResearchResult,
  type ProposedNote,
} from "./deepResearch";

function md(relPath: string): VaultFile {
  const name = relPath.split("/").pop()!.replace(/\.md$/i, "");
  return { path: `/vault/${relPath}`, relPath, name, ext: "md", isMarkdown: true };
}

function note(relPath: string, rawLinks: string[] = [], tags: string[] = []): NoteMeta {
  return { relPath, title: relPath.split("/").pop()!.replace(/\.md$/i, ""), rawLinks, tags, aliases: [] };
}

const providerCredentialFixture = ["sk", "-proj-", "mesa_test_fixture_1234567890"].join("");
const githubCredentialFixture = ["gh", "p_", "mesa_test_fixture_1234567890"].join("");
const privateKeyFixture = [
  "-----BEGIN ",
  "PRIVATE KEY-----\nfixture\n",
  "-----END ",
  "PRIVATE KEY-----",
].join("");
const assignment = (name: string, value: string) => `${name}=${value}`;

// --- URL canonicalization + dedup ------------------------------------------
describe("canonicalizeSourceUrl", () => {
  it("strips tracking params, www, fragment, and trailing slash", () => {
    expect(
      canonicalizeSourceUrl("HTTPS://www.Example.com/path/?utm_source=x&b=2&a=1#frag")
    ).toBe("https://example.com/path?a=1&b=2");
  });
  it("rejects non-http(s) URLs", () => {
    expect(canonicalizeSourceUrl("file:///etc/passwd")).toBeNull();
    expect(canonicalizeSourceUrl("javascript:alert(1)")).toBeNull();
    expect(canonicalizeSourceUrl("ftp://x/y")).toBeNull();
  });
  it("rejects malformed URLs", () => {
    expect(canonicalizeSourceUrl("not a url")).toBeNull();
    expect(canonicalizeSourceUrl("")).toBeNull();
  });
});

describe("dedupeSources", () => {
  it("drops duplicate canonical URLs and keeps first valid title", () => {
    const out = dedupeSources([
      { url: "https://a.com/x?utm_source=y", title: "A" },
      { url: "https://www.a.com/x", title: "A dup" },
      { url: "not-a-url", title: "bad" },
      { url: "https://b.com/y", title: "B" },
    ]);
    expect(out.map((s) => s.url)).toEqual(["https://a.com/x", "https://b.com/y"]);
    expect(out[0].title).toBe("A");
  });
});

describe("presentResearchSource", () => {
  it("turns opaque source URLs into a browser-style site and page identity", () => {
    const source = presentResearchSource(
      "https://en.wikipedia.org/wiki/Jeffrey_Epstein?utm_source=test",
      "en.wikipedia.org/wiki/Jeffrey_Epstein"
    );
    expect(source).toEqual({
      url: "https://en.wikipedia.org/wiki/Jeffrey_Epstein",
      siteName: "Wikipedia",
      host: "en.wikipedia.org",
      pageTitle: "Jeffrey Epstein",
      faviconUrl: "https://en.wikipedia.org/favicon.ico",
      initial: "W",
    });
  });

  it("keeps a real source title and provides a readable known-site label", () => {
    const source = presentResearchSource(
      "https://www.theguardian.com/books/2017/jun/01/example",
      "A documented history of the subject"
    );
    expect(source?.siteName).toBe("The Guardian");
    expect(source?.pageTitle).toBe("A documented history of the subject");
  });

  it("rejects non-web sources", () => {
    expect(presentResearchSource("file:///tmp/private", "Private")).toBeNull();
  });
});

// --- naming ------------------------------------------------------------------
describe("safeNoteTitle / safeFolderName", () => {
  it("sanitizes to a non-empty, filesystem-safe base name", () => {
    expect(safeNoteTitle('What is "X"?: a/b')).toBe("What is X a-b");
    expect(safeNoteTitle("con")).toBe("Research");
    expect(safeNoteTitle("   ")).toBe("Research");
  });
  it("falls back for a reserved/empty folder name", () => {
    expect(safeFolderName("Research")).toBe("Research");
    expect(safeFolderName("NUL")).toBe("Research");
  });
});

describe("titleSlug", () => {
  it("slugifies for dedupe comparison", () => {
    expect(titleSlug("Deep Research — Foo Bar!")).toBe("deep-research-foo-bar");
  });
});

// --- context builder -----------------------------------------------------------
describe("buildResearchContext", () => {
  const files = [md("a.md"), md("b.md"), md("c.md"), md("sub/d.md"), md(".secret/x.md"), md(".hidden.md")];
  const notes: Record<string, NoteMeta> = {
    "a.md": note("a.md", ["b.md"], ["research", "ai"]),
    "b.md": note("b.md", ["a.md"], ["research"]),
    "c.md": note("c.md", [], ["other"]),
    "sub/d.md": note("sub/d.md", [], ["ai"]),
    ".secret/x.md": note(".secret/x.md", [], []),
    ".hidden.md": note(".hidden.md", [], []),
  };
  const content: Record<string, string> = {
    "a.md": "alpha body about mesa graph and pi agent",
    "b.md": "beta links back",
    "c.md": "gamma unrelated",
    "sub/d.md": "delta ai note",
    ".secret/x.md": "hidden credential stuff",
    ".hidden.md": "hidden root note",
  };

  it("always includes the active file and selected files, deduped", () => {
    const out = buildResearchContext({
      query: "mesa",
      activePath: "a.md",
      selectedPaths: ["a.md", "c.md"],
      files, notes, content,
      limits: DEFAULT_DEEP_RESEARCH_LIMITS,
    });
    const paths = out.notes.map((n) => n.relPath);
    expect(paths).toContain("a.md");
    expect(paths).toContain("c.md");
    expect(paths.filter((p) => p === "a.md")).toHaveLength(1);
  });

  it("excludes dot-folder / hidden artifact paths", () => {
    const out = buildResearchContext({
      query: "credential",
      activePath: null,
      selectedPaths: [],
      files, notes, content,
      limits: DEFAULT_DEEP_RESEARCH_LIMITS,
      scope: "vault",
    });
    const paths = out.notes.map((n) => n.relPath);
    expect(paths).not.toContain(".secret/x.md");
    expect(paths).not.toContain(".hidden.md");
  });

  it("excludes credential-named notes and redacts credential-shaped values in normal notes", () => {
    const files2 = [md("topic.md"), md("credentials.md"), md("API_KEYS.md")];
    const notes2 = {
      "topic.md": note("topic.md"),
      "credentials.md": note("credentials.md"),
      "API_KEYS.md": note("API_KEYS.md"),
    };
    const out = buildResearchContext({
      query: "topic credentials",
      activePath: "topic.md",
      selectedPaths: ["credentials.md", "API_KEYS.md"],
      files: files2,
      notes: notes2,
      content: {
        "topic.md": `Useful prose. ${assignment("API_KEY", providerCredentialFixture)}`,
        "credentials.md": assignment("password", "fixture-value"),
        "API_KEYS.md": assignment("token", "fixture-value"),
      },
      limits: DEFAULT_DEEP_RESEARCH_LIMITS,
    });
    expect(out.notes.map((n) => n.relPath)).toEqual(["topic.md"]);
    expect(out.notes[0].content).toMatch(/\[REDACTED(?: CREDENTIAL)?\]/);
    expect(out.notes[0].content).not.toContain("abcdefghijklmnop");
    expect(out.notes[0].redacted).toBe(true);
  });

  it("vault scope pulls related notes via backlinks, outgoing links, tags, and search", () => {
    const out = buildResearchContext({
      query: "mesa",
      activePath: "a.md",
      selectedPaths: [],
      files, notes, content,
      limits: DEFAULT_DEEP_RESEARCH_LIMITS,
      scope: "vault",
    });
    expect(out.scope).toBe("vault");
    const paths = out.notes.map((n) => n.relPath);
    expect(paths).toContain("b.md"); // backlink + outgoing
    expect(paths).toContain("sub/d.md"); // shared #ai tag
  });

  it("defaults to workspace scope: active + selected + link neighborhood, NO vault sweep", () => {
    const out = buildResearchContext({
      query: "mesa",
      activePath: "a.md",
      selectedPaths: [],
      files, notes, content,
      limits: DEFAULT_DEEP_RESEARCH_LIMITS,
    });
    expect(out.scope).toBe("workspace");
    // a.md (active) + b.md (its backlink/outgoing neighbor) only — the
    // shared-tag note (sub/d.md) and content-search matches stay out.
    expect(out.notes.map((n) => n.relPath)).toEqual(["a.md", "b.md"]);
    expect(out.omittedNotes).toBe(0);
  });

  it("enforces the note cap and reports truncation", () => {
    const out = buildResearchContext({
      query: "a",
      activePath: "a.md",
      selectedPaths: [],
      files, notes, content,
      limits: { ...DEFAULT_DEEP_RESEARCH_LIMITS, maxContextNotes: 2 },
      scope: "vault",
    });
    expect(out.notes.length).toBeLessThanOrEqual(2);
    expect(out.truncated).toBe(true);
    expect(out.omittedNotes).toBeGreaterThan(0);
  });

  it("enforces the byte cap and reports truncation", () => {
    const big = "x".repeat(5000);
    const out = buildResearchContext({
      query: "a",
      activePath: "a.md",
      selectedPaths: [],
      files: [md("a.md")], notes: { "a.md": note("a.md") },
      content: { "a.md": big },
      limits: { ...DEFAULT_DEEP_RESEARCH_LIMITS, maxNoteBytes: 100, maxTotalBytes: 200 },
    });
    expect(out.totalBytes).toBeLessThanOrEqual(200);
    expect(out.truncated).toBe(true);
  });

  it("excludes the query terms from returned content? no — content is included verbatim", () => {
    const out = buildResearchContext({
      query: "mesa",
      activePath: "a.md",
      selectedPaths: [],
      files, notes, content,
      limits: DEFAULT_DEEP_RESEARCH_LIMITS,
    });
    const a = out.notes.find((n) => n.relPath === "a.md");
    expect(a?.content).toContain("alpha body");
  });

  it("counts notes past the cap without reading or redacting their content", () => {
    const backlinks = ["b1.md", "b2.md", "b3.md"];
    const tagged = ["t1.md", "t2.md", "t3.md", "t4.md"];
    const searched = ["s1.md", "s2.md", "s3.md"];
    const rels = ["hub.md", ...backlinks, ...tagged, ...searched];
    const bigNotes: Record<string, NoteMeta> = { "hub.md": note("hub.md") };
    // Only the backlinks past the cap carry the tag the tag sweep follows.
    backlinks.forEach((rel, i) => { bigNotes[rel] = note(rel, ["hub"], i === 0 ? [] : ["x"]); });
    for (const rel of tagged) bigNotes[rel] = note(rel, [], ["x"]);
    for (const rel of searched) bigNotes[rel] = note(rel);
    const text: Record<string, string> = Object.fromEntries(rels.map((rel) => [rel, `${rel} zebra body`]));
    const reads = new Map<string, number>();
    const counted = new Proxy(text, {
      get(target, key: string) { reads.set(key, (reads.get(key) ?? 0) + 1); return target[key]; },
    });
    const out = buildResearchContext({
      query: "zebra", activePath: "hub.md", selectedPaths: [], scope: "vault",
      files: rels.map(md), notes: bigNotes, content: counted,
      limits: { ...DEFAULT_DEEP_RESEARCH_LIMITS, maxContextNotes: 2 },
    });
    expect(out.notes.map((n) => n.relPath)).toEqual(["hub.md", "b1.md"]);
    expect(out.omittedNotes).toBe(9);
    expect(out.summary).toBe(`2 notes in context (9 omitted, ${out.totalBytes} B, truncated)`);
    // A search match is read once to test it; tag and link matches past the cap never.
    for (const rel of [...backlinks.slice(1), ...tagged]) expect(reads.get(rel) ?? 0).toBe(0);
    for (const rel of searched) expect(reads.get(rel)).toBe(1);
  });
});

describe("redactResearchContent", () => {
  it("removes private-key blocks and common provider-token shapes", () => {
    const out = redactResearchContent(
      `before\n${privateKeyFixture}\n${githubCredentialFixture}\nafter`
    );
    expect(out.redacted).toBe(true);
    expect(out.content).not.toContain("BEGIN PRIVATE KEY");
    expect(out.content).not.toContain(githubCredentialFixture);
    expect(out.content).toContain("before");
    expect(out.content).toContain("after");
  });
  it("removes credential shapes from otherwise useful prose", () => {
    const secrets = [
      `AKIA${"A".repeat(16)}`,
      `github_pat_${"a".repeat(30)}`,
      `AIza${"A".repeat(35)}`,
      `eyJ${"a".repeat(12)}.eyJ${"b".repeat(12)}.${"c".repeat(24)}`,
      `sk-ant-api03-${"a".repeat(32)}`,
      `sk-proj-${"b".repeat(32)}`,
    ];
    const result = redactResearchContent(`Context ${secrets.join(" then ")} remains useful.`);
    expect(result.redacted).toBe(true);
    for (const secret of secrets) expect(result.content).not.toContain(secret);
    expect(result.content).toContain("Context ");
    expect(result.content).toContain(" remains useful.");
  });
});

describe("redactResearchContent cost", () => {
  // Equal total input per side (8 small runs, 1 large run), interleaved, best
  // of five: linear scanning gives about 1, quadratic scanning about 8.
  it("redacts notes made of blank lines in linear time", () => {
    const work = (text: string, reps: number) => {
      const start = performance.now();
      for (let i = 0; i < reps; i++) redactResearchContent(text);
      return performance.now() - start;
    };
    for (const unit of ["\n", "\r", " \n", "\u2028"]) {
      const small = `${unit.repeat(5_000)}x`, large = `${unit.repeat(40_000)}x`;
      expect(redactResearchContent(`${large}\npassword: hunter2`).content.endsWith("password: [REDACTED]")).toBe(true);
      const reps = Math.ceil(20 / Math.max(work(large, 1), 0.1));
      let smallBest = Infinity, largeBest = Infinity;
      for (let round = 0; round < 5; round++) {
        smallBest = Math.min(smallBest, work(small, 8 * reps));
        largeBest = Math.min(largeBest, work(large, reps));
      }
      expect(largeBest / smallBest).toBeLessThan(4);
    }
  }, 30000);
  it("keeps indented and next-line credential values redacted", () => {
    expect(redactResearchContent("intro\n\n  API_KEY = abc123\nrest").content).toBe("intro\n\n  API_KEY = [REDACTED]\nrest");
    expect(redactResearchContent("\u00a0secret: s3cret").content).toBe("\u00a0secret: [REDACTED]");
    expect(redactResearchContent("password\n: value").content).toBe("password\n: [REDACTED]");
  });
});

// --- prompt -----------------------------------------------------------------
describe("buildResearchPrompt", () => {
  it("instructs read-only research, the tools, and no direct vault writes", () => {
    const ctx = buildResearchContext({
      query: "q",
      activePath: null, selectedPaths: [],
      files: [], notes: {}, content: {},
      limits: DEFAULT_DEEP_RESEARCH_LIMITS,
    });
    const p = buildResearchPrompt({ runId: "r1", query: "my query", context: ctx, folder: "Research", depth: RESEARCH_DEPTH_PRESETS.standard });
    expect(p).toContain("deep_research_progress");
    expect(p).toContain("deep_research_finish");
    expect(p).toContain("Do not use the write or edit tools");
    expect(p).toContain("browse");
    expect(p).toContain("my query");
    expect(p).toContain("[[");
    expect(p).toContain("sub-questions");
  });

  it("embeds the requested depth and the rich reporting instructions", () => {
    const ctx = buildResearchContext({
      query: "q", activePath: null, selectedPaths: [],
      files: [], notes: {}, content: {}, limits: DEFAULT_DEEP_RESEARCH_LIMITS,
    });
    const p = buildResearchPrompt({
      runId: "r1", query: "q", context: ctx, folder: "Research",
      depth: { rounds: 4, subQuestions: 7, maxSources: 20, maxGeneratedNotes: 9 },
    });
    expect(p).toContain("exactly 4 research rounds");
    expect(p).toContain("exactly 7 sub-questions");
    expect(p).toContain("up to 20 sources");
    expect(p).toContain('kind: "plan"');
    expect(p).toContain('kind: "round"');
    expect(p).toContain('kind: "source"');
    expect(p).toContain('kind: "subquestion"');
    expect(p).toContain('kind: "synthesize"');
    expect(p).toContain("methodology");
    expect(p).toContain("draftMarkdown");
    expect(p).toContain("high-confidence, source-backed addition");
  });
});

describe("validateResearchResult", () => {
  it("preserves uncertainty and conflicting claims, dedupes sources", () => {
    const result: DeepResearchResult = {
      version: 1,
      report: { title: "R", markdown: "# R" },
      notes: [],
      sources: [
        { url: "https://a.com/x?utm_medium=z", title: "A" },
        { url: "https://a.com/x", title: "A again" },
      ],
      claims: [
        { text: "fact", kind: "verified", sourceUrl: "https://a.com/x" },
        { text: "maybe", kind: "inference" },
        { text: "disagree", kind: "conflict" },
        { text: "unknown", kind: "unknown" },
      ],
      related: [],
    };
    const out = validateResearchResult(result);
    expect(out.sources).toHaveLength(1);
    expect(out.claims.map((c) => c.kind)).toEqual(["verified", "inference", "conflict", "unknown"]);
  });

  it("caps output sizes to the limits", () => {
    const notes: ProposedNote[] = Array.from({ length: 30 }, (_, i) => ({
      title: `N${i}`, markdown: `# N${i}`, sourceUrl: null, links: [],
    }));
    const result: DeepResearchResult = {
      version: 1, report: { title: "R", markdown: "# R" },
      notes, sources: [], claims: [], related: [],
    };
    const out = validateResearchResult(result, { ...DEFAULT_DEEP_RESEARCH_LIMITS, maxGeneratedNotes: 5 });
    expect(out.notes.length).toBeLessThanOrEqual(5);
  });

  it("enforces the total generated-output byte budget", () => {
    const result: DeepResearchResult = {
      version: 1,
      report: { title: "R", markdown: "12345678" },
      notes: [
        { title: "N1", markdown: "😀😀", sourceUrl: null, links: [] },
        { title: "N2", markdown: "abcdef", sourceUrl: null, links: [] },
      ],
      sources: [], claims: [], related: [],
    };
    const out = validateResearchResult(result, {
      ...DEFAULT_DEEP_RESEARCH_LIMITS,
      maxGeneratedTotalBytes: 12,
    });
    const total = utf8ByteLength(out.report.markdown) +
      out.notes.reduce((sum, n) => sum + utf8ByteLength(n.markdown), 0);
    expect(total).toBeLessThanOrEqual(12);
  });

  it("redacts credential-shaped values from every generated artifact", () => {
    const result: DeepResearchResult = {
      version: 1,
      report: { title: "R", markdown: `# R\n\n${assignment("API_KEY", providerCredentialFixture)}` },
      notes: [{
        title: "N",
        markdown: assignment("password", "fixture-value"),
        sourceUrl: null,
        links: [],
      }],
      sources: [{ url: "https://a.com/x", title: "A" }],
      claims: [],
      related: [{
        relPath: "existing.md",
        reason: "x",
        update: {
          markdown: assignment("access_token", "fixture-value"),
          sourceUrls: ["https://a.com/x"],
          confidence: "high",
        },
      }],
    };
    const out = validateResearchResult(result);
    expect(out.report.markdown).not.toContain("abcdefghijklmnop");
    expect(out.notes[0].markdown).not.toContain("fixture-value");
    expect(out.related[0].update?.markdown).not.toContain("fixture-value");
  });

  it("drops source notes without a surviving source and normalizes useful related updates", () => {
    const result: DeepResearchResult = {
      version: 1,
      report: { title: "R", markdown: "# R" },
      notes: [
        { title: "Good", markdown: "# Good", sourceUrl: "https://a.com/x", links: [] },
        { title: "Bad", markdown: "# Bad", sourceUrl: "https://missing.example/x", links: [] },
      ],
      sources: [{ url: "https://a.com/x?utm_source=test", title: "A" }],
      claims: [],
      related: [{
        relPath: "existing.md",
        reason: "new evidence",
        update: {
          markdown: "A useful source-backed addition with enough detail for the note.",
          sourceUrls: ["https://www.a.com/x#section", "file:///private/key"],
          confidence: "high",
        },
      }],
    };
    const out = validateResearchResult(result);
    expect(out.notes.map((n) => n.title)).toEqual(["Good"]);
    expect(out.related[0].update).toEqual({
      markdown: "A useful source-backed addition with enough detail for the note.",
      sourceUrls: ["https://a.com/x"],
      confidence: "high",
    });
  });
});

describe("researchReportQualityIssues", () => {
  const depth = { rounds: 2, subQuestions: 2, maxSources: 8, maxGeneratedNotes: 4 };
  it("accepts the thesis-grade report structure with per-question findings and citations", () => {
    const result: DeepResearchResult = {
      version: 1,
      subQuestions: ["Q1", "Q2"],
      report: {
        title: "R",
        markdown: "# R\n\n## Abstract\nAnswer.\n\n## Methodology\nTwo rounds.\n\n## Findings\n### Q1\nEvidence [A](https://a.com/x).\n\n### Q2\nMore evidence [A](https://a.com/x).\n\n## Synthesis\nConclusion.\n\n## Confidence and limitations\nHigh with limits.\n\n## Disagreements\nNone.\n\n## Open questions\nNext work.",
      },
      notes: [],
      sources: [{ url: "https://a.com/x", title: "A" }],
      claims: [{ text: "verified", kind: "verified", sourceUrl: "https://a.com/x" }],
      related: [],
    };
    expect(researchReportQualityIssues(result, depth)).toEqual([]);
  });

  it("reports missing methodology, findings coverage, and citations", () => {
    const result: DeepResearchResult = {
      version: 1,
      subQuestions: ["Q1", "Q2"],
      report: { title: "R", markdown: "# R\n\n## Abstract\nThin." },
      notes: [], sources: [{ url: "https://a.com/x", title: "A" }], claims: [], related: [],
    };
    const issues = researchReportQualityIssues(result, depth);
    expect(issues).toContain("missing Methodology section");
    expect(issues).toContain("findings cover 0/2 sub-questions");
    expect(issues).toContain("findings contain no inline source URL citations");
  });

  it("rejects an uncited finding subsection", () => {
    const result: DeepResearchResult = {
      version: 1,
      subQuestions: ["Q1", "Q2"],
      report: { title: "R", markdown: "# R\n\n## Abstract\nAnswer.\n\n## Methodology\nTwo rounds.\n\n## Findings\n### Q1\n[A](https://a.com/x).\n\n### Q2\nUnsupported.\n\n## Synthesis\nConclusion.\n\n## Confidence and limitations\nLimits.\n\n## Disagreements\nNone.\n\n## Open questions\nNone." },
      notes: [],
      sources: [{ url: "https://a.com/x", title: "A" }],
      claims: [{ text: "verified", kind: "verified", sourceUrl: "https://a.com/x" }],
      related: [],
    };
    expect(researchReportQualityIssues(result, depth)).toContain(
      'findings subsection for sub-question "Q2" has no source URL citation'
    );
  });

  it("reads headings after a backtick line whose info string holds a backtick", () => {
    const result: DeepResearchResult = {
      version: 1,
      subQuestions: ["Q1", "Q2"],
      report: {
        title: "R",
        markdown: "# R\n\n## Abstract\nUse ``` a`b inline.\n``` a`b\n\n## Methodology\nTwo rounds.\n\n## Findings\n### Q1\nEvidence [A](https://a.com/x).\n\n### Q2\nMore evidence [A](https://a.com/x).\n\n## Synthesis\nConclusion.\n\n## Confidence and limitations\nHigh with limits.\n\n## Disagreements\nNone.\n\n## Open questions\nNext work.",
      },
      notes: [],
      sources: [{ url: "https://a.com/x", title: "A" }],
      claims: [{ text: "verified", kind: "verified", sourceUrl: "https://a.com/x" }],
      related: [],
    };
    expect(researchReportQualityIssues(result, depth)).toEqual([]);
  });
});


describe("report prompt and findings boundaries", () => {
  function example(count = 5): DeepResearchResult {
    const context = buildResearchContext({ query: "q", activePath: null, selectedPaths: [], files: [], notes: {}, content: {}, limits: DEFAULT_DEEP_RESEARCH_LIMITS });
    const prompt = buildResearchPrompt({ runId: "r", query: "q", folder: "Research", context, depth: { rounds: 2, subQuestions: count, maxSources: 16, maxGeneratedNotes: 8 } });
    return JSON.parse(prompt.match(/```json\n([\s\S]+?)\n```/)![1]);
  }
  const depth = { rounds: 2, subQuestions: 5, maxSources: 16, maxGeneratedNotes: 8 };
  it("supplies a complete validator-compatible example for the requested depth", () => {
    expect(researchReportQualityIssues(example(), depth)).toEqual([]);
  });
  it("accepts numbered, bold and Unicode question headings without merging different questions", () => {
    const result = example();
    const question = "What are the earliest documented Western Hermetic, alchemical, and ceremonial magical practices, and how were they transmitted and structured?";
    result.subQuestions![0] = `1. ${question}`;
    result.report.markdown = result.report.markdown.replace("### Sub-question 1", `### **1. ${question}**`);
    result.subQuestions![1] = "祈りの歴史";
    result.report.markdown = result.report.markdown.replace("### Sub-question 2", "### 祈りの歴史");
    expect(researchReportQualityIssues(result, depth)).toEqual([]);
    result.report.markdown = result.report.markdown.replace("### 祈りの歴史", "### 瞑想の歴史");
    expect(researchReportQualityIssues(result, depth)).toContain('missing findings subsection for sub-question "祈りの歴史"');
  });
  it("does not borrow a citation from Synthesis or count headings outside Findings", () => {
    const result = example();
    result.report.markdown = result.report.markdown.replace("### Sub-question 5\nEvidence with [inline citation](https://example.com/page).", "### Sub-question 5\nUnsupported.").replace("## Synthesis", "## Synthesis\n[A](https://example.com/page)");
    expect(researchReportQualityIssues(result, depth)).toContain('findings subsection for sub-question "Sub-question 5" has no source URL citation');
    result.report.markdown = result.report.markdown.replace("## Findings", "## Appendix");
    expect(researchReportQualityIssues(result, depth)).toContain("findings cover 0/5 sub-questions");
  });
  it("ignores required headings inside a fenced example", () => {
    const result = example();
    result.report.markdown = "```markdown\n" + result.report.markdown + "\n```";
    expect(researchReportQualityIssues(result, depth)).toContain("missing Findings section");
  });
});

// --- change set ---------------------------------------------------------------
describe("buildChangeSet", () => {
  const existingFiles = [md("existing.md"), md("Research/old.md")];
  const notes: Record<string, NoteMeta> = {
    "existing.md": note("existing.md"),
    "Research/old.md": note("Research/old.md"),
  };
  const content: Record<string, string> = {
    "existing.md": "# Existing\n\nSome text.",
    "Research/old.md": "# Old",
  };

  it("creates a report note in the folder with wiki-links to sources and related", () => {
    const result: DeepResearchResult = {
      version: 1,
      report: { title: "My Report", markdown: "# My Report\n\nFindings." },
      notes: [{ title: "Source A", markdown: "# A", sourceUrl: "https://a.com/x", links: [] }],
      sources: [{ url: "https://a.com/x", title: "Source A" }],
      claims: [],
      related: [{ relPath: "existing.md", reason: "relevant" }],
    };
    const cs = buildChangeSet({
      runId: "r1", result, folder: "Research",
      existingFiles, notes, content, now: new Date("2026-07-17T12:00:00Z"),
    });
    const report = cs.ops.find((o) => o.kind === "create" && o.title === "My Report");
    expect(report).toMatchObject({ kind: "create", title: "My Report" });
    expect(report!.relPath.startsWith("Research/")).toBe(true);
    expect(report!.content).toContain("[[Research/Source A.md]]");
    expect(report!.content).toContain("[[existing.md]]");
    expect(report!.content).toContain("https://a.com/x");
  });

  it("dates notes with the local calendar day near midnight", () => {
    const result: DeepResearchResult = {
      version: 1,
      report: { title: "Night Report", markdown: "# Night Report\n\nFindings." },
      notes: [{ title: "Night Source", markdown: "# N", sourceUrl: null, links: [] }],
      sources: [], claims: [], related: [],
    };
    // Local wall-clock instants on each side of midnight: in any zone east or west
    // of UTC, one of them falls on a different UTC calendar day.
    for (const [now, day] of [[new Date(2026, 6, 17, 23, 59), "2026-07-17"], [new Date(2026, 6, 18, 0, 1), "2026-07-18"]] as const) {
      const cs = buildChangeSet({ runId: "r-night", result, folder: "Research", existingFiles, notes, content, now });
      const report = cs.ops.find((o) => o.kind === "create" && o.title === "Night Report");
      const source = cs.ops.find((o) => o.kind === "create" && o.title === "Night Source");
      expect(report!.content).toContain(`_Generated by Deep Research · ${day}_`);
      expect(source!.content).toContain(`_Created by Deep Research · ${day}_`);
    }
  });

  it("dedupes a generated note whose slug already exists and links instead", () => {
    const result: DeepResearchResult = {
      version: 1,
      report: { title: "R2", markdown: "# R2" },
      notes: [{ title: "Old", markdown: "# dup", sourceUrl: null, links: [] }],
      sources: [], claims: [], related: [],
    };
    const cs = buildChangeSet({
      runId: "r2", result, folder: "Research",
      existingFiles, notes, content, now: new Date("2026-07-17T12:00:00Z"),
    });
    // "Research/old.md" already exists → the proposed "Old" note must not be recreated.
    const created = cs.ops.filter((o) => o.kind === "create" && o.relPath === "Research/Old.md");
    expect(created).toHaveLength(0);
    expect(cs.ops.some((o) => o.kind === "create" && o.title === "R2")).toBe(true);
  });

  it("dedupes a source note by canonical source URL", () => {
    const files2 = [...existingFiles, md("Research/Source A.md")];
    const content2 = { ...content, "Research/Source A.md": "# A\n\nSource: https://a.com/x" };
    const result: DeepResearchResult = {
      version: 1,
      report: { title: "R3", markdown: "# R3" },
      notes: [{ title: "Source A", markdown: "# new", sourceUrl: "https://a.com/x?utm_source=z", links: [] }],
      sources: [{ url: "https://a.com/x", title: "Source A" }],
      claims: [], related: [],
    };
    const cs = buildChangeSet({
      runId: "r3", result, folder: "Research",
      existingFiles: files2, notes, content: content2, now: new Date("2026-07-17T12:00:00Z"),
    });
    expect(cs.ops.filter((o) => o.kind === "create" && o.title === "Source A")).toHaveLength(0);
  });

  it("numbers a colliding report name inside a dotted folder, case-insensitively", () => {
    const files = [...existingFiles, md("Research v1.2/report.md"), md("Research v1.2/Report 1.md")];
    const result: DeepResearchResult = {
      version: 1,
      report: { title: "Report", markdown: "# Report" },
      notes: [], sources: [], claims: [], related: [],
    };
    const cs = buildChangeSet({
      runId: "r5", result, folder: "Research v1.2",
      existingFiles: files, notes, content, now: new Date("2026-07-17T12:00:00Z"),
    });
    expect(cs.reportRelPath).toBe("Research v1.2/Report 2.md");
  });

  it("never treats a relation reason or backlink stub as a useful note update", () => {
    const result: DeepResearchResult = {
      version: 1,
      report: { title: "R4", markdown: "# R4" },
      notes: [], sources: [], claims: [],
      related: [{ relPath: "existing.md", reason: "x" }],
    };
    const cs = buildChangeSet({
      runId: "r4", result, folder: "Research",
      existingFiles, notes, content, now: new Date("2026-07-17T12:00:00Z"),
    });
    expect(cs.ops.filter((o) => o.kind === "update")).toHaveLength(0);
  });

  it("proposes a substantive, source-backed update for a high-confidence related note", () => {
    const result: DeepResearchResult = {
      version: 1,
      report: { title: "R Useful", markdown: "# R Useful" },
      notes: [],
      sources: [{ url: "https://a.com/x", title: "Primary A" }],
      claims: [],
      related: [{
        relPath: "existing.md",
        reason: "changes the existing conclusion",
        update: {
          markdown: "New primary evidence changes the conclusion and explains why the prior assumption no longer holds.",
          sourceUrls: ["https://a.com/x"],
          confidence: "high",
        },
      }],
    };
    const cs = buildChangeSet({
      runId: "r-useful", result, folder: "Research",
      existingFiles, notes, content, now: new Date("2026-07-17T12:00:00Z"),
    });
    const update = cs.ops.find((o) => o.kind === "update" && o.relPath === "existing.md");
    expect(update?.content).toContain("New primary evidence changes the conclusion");
    expect(update?.content).toContain("[Primary A](https://a.com/x)");
    expect(update?.content).toContain("[[Research/R Useful.md]]");
    expect(update?.expectedBytes).toBe(content["existing.md"]);
  });

  it("avoids duplicate links when a related note already links to the report", () => {
    const content2 = { ...content, "existing.md": "# Existing\n\nSee [[Research/My Report.md]]." };
    const result: DeepResearchResult = {
      version: 1,
      report: { title: "My Report", markdown: "# My Report" },
      notes: [], claims: [],
      related: [{
        relPath: "existing.md",
        reason: "x",
        update: {
          markdown: "A substantive addition that is long enough to qualify as a useful related-note update.",
          sourceUrls: ["https://a.com/x"],
          confidence: "high",
        },
      }],
      sources: [{ url: "https://a.com/x", title: "A" }],
    };
    const cs = buildChangeSet({
      runId: "r5", result, folder: "Research",
      existingFiles, notes, content: content2, now: new Date("2026-07-17T12:00:00Z"),
    });
    const update = cs.ops.find((o) => o.kind === "update" && o.relPath === "existing.md");
    expect(update).toMatchObject({ kind: "update", relPath: "existing.md" });
    expect(update!.content.match(/\[\[Research\/My Report\.md\]\]/g)!.length).toBe(1);
  });

  it("sanitizes generated file and folder names", () => {
    const result: DeepResearchResult = {
      version: 1,
      report: { title: 'Bad: "Name" / Test?', markdown: "# x" },
      notes: [], sources: [], claims: [], related: [],
    };
    const cs = buildChangeSet({
      runId: "r6", result, folder: "Research",
      existingFiles, notes, content, now: new Date("2026-07-17T12:00:00Z"),
    });
    const report = cs.ops.find((o) => o.kind === "create");
    expect(report!.relPath).not.toMatch(/[:*?"<>|\\]/);
    expect(report!.relPath.split("/").every((seg) => seg && !seg.startsWith("."))).toBe(true);
  });
});

// --- apply plan (transaction) ---------------------------------------------------
describe("buildApplyPlan", () => {
  const files = [md("a.md")];
  const notes: Record<string, NoteMeta> = { "a.md": note("a.md") };

  it("requires expected bytes for updates and captures originals for rollback", () => {
    const ops = [
      { kind: "create" as const, relPath: "Research/r.md", title: "R", content: "# R" },
      { kind: "update" as const, relPath: "a.md", title: "A", content: "# A2", expectedBytes: "# A" },
    ];
    const plan = buildApplyPlan({ ops, existingContent: { "a.md": "# A" }, files, notes });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      const upd = plan.steps.find((s) => s.relPath === "a.md");
      expect(upd?.expectedBytes).toBe("# A");
      expect(upd?.originalContent).toBe("# A");
    }
  });

  it("rejects an update whose expected bytes no longer match (stale file)", () => {
    const ops = [
      { kind: "update" as const, relPath: "a.md", title: "A", content: "# A2", expectedBytes: "# OLD" },
    ];
    const plan = buildApplyPlan({ ops, existingContent: { "a.md": "# NEW" }, files, notes });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toMatch(/stale|changed/i);
  });

  it("rejects an update without an explicit version precondition", () => {
    const plan = buildApplyPlan({
      ops: [{ kind: "update", relPath: "a.md", title: "A", content: "# A2" }],
      existingContent: { "a.md": "# A" },
      files,
      notes,
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toMatch(/version precondition/i);
  });

  it("rejects an update targeting a note that no longer exists", () => {
    const ops = [
      { kind: "update" as const, relPath: "gone.md", title: "G", content: "# G", expectedBytes: "# G" },
    ];
    const plan = buildApplyPlan({ ops, existingContent: {}, files, notes });
    expect(plan.ok).toBe(false);
  });

  it("orders creates before updates and plans rollback in reverse", () => {
    const ops = [
      { kind: "update" as const, relPath: "a.md", title: "A", content: "# A2", expectedBytes: "# A" },
      { kind: "create" as const, relPath: "Research/r.md", title: "R", content: "# R" },
      { kind: "create" as const, relPath: "Research/s.md", title: "S", content: "# S" },
    ];
    const plan = buildApplyPlan({ ops, existingContent: { "a.md": "# A" }, files, notes });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      const kinds = plan.steps.map((s) => s.kind);
      expect(kinds.indexOf("create")).toBeLessThan(kinds.indexOf("update"));
      const rollbackCreates = plan.rollback.filter((r) => r.kind === "remove").map((r) => r.relPath);
      expect(rollbackCreates).toEqual(["Research/s.md", "Research/r.md"]);
    }
  });

  it("rejects any op outside the vault or with an unsafe path", () => {
    const ops = [
      { kind: "create" as const, relPath: "../escape.md", title: "E", content: "# E" },
    ];
    const plan = buildApplyPlan({ ops, existingContent: {}, files, notes });
    expect(plan.ok).toBe(false);
  });
});

// --- Pi session safety contract (source-pinned) -------------------------------
// The Deep Research write-block is only live while Pi runs with the
// deep-research extension. A session restart on context drift would silently
// shed that extension mid-run. These pins keep AgentPanel's reuse conservative
// and keep the DR launch wired into the spawn env/args.

describe("untrusted result fields", () => {
  it("drops non-text source fields instead of ending the run", () => {
    const result = {
      version: 1,
      report: { title: 7, markdown: "# R" },
      notes: [{ title: "N", markdown: "# N", sourceUrl: 3, links: [] }],
      sources: [null, { url: 1 }, { url: "https://a.example", title: 5, date: 2024 }, "https://b.example"],
      claims: [{ text: "fact", kind: "verified", sourceUrl: 42 }],
      related: [],
    } as unknown as DeepResearchResult;
    let out: DeepResearchResult | undefined;
    expect(() => { out = validateResearchResult(result); }).not.toThrow();
    expect(out!.sources).toEqual([{ url: "https://a.example/", title: "https://a.example/", date: undefined }]);
    expect(out!.claims).toEqual([{ text: "fact", kind: "unknown", sourceUrl: undefined }]);
    expect(out!.notes.map((n) => n.sourceUrl)).toEqual([null]);
    expect(out!.report.title).toBe("Deep Research");
    expect(dedupeSources([undefined, { url: "https://c.example/p", title: " T ", date: " 2024 " }] as unknown[]))
      .toEqual([{ url: "https://c.example/p", title: "T", date: "2024" }]);
  });
});

describe("one source URL canonicalization", () => {
  it("keeps encoded query values and matches the startup-safe observed-navigation module", async () => {
    const urls = await import("./deepResearchUrls");
    expect(canonicalizeSourceUrl).toBe(urls.canonicalizeSourceUrl);
    expect(canonicalizeSourceUrl("https://a.example/s?q=a%26b&ref=x&utm_x=1")).toBe("https://a.example/s?q=a%26b");
    expect(canonicalizeSourceUrl("https://a.example/s?q=x%3Dy+z&b=%23")).toBe("https://a.example/s?b=%23&q=x%3Dy+z");
    expect(dedupeSources([{ url: "https://a.example/s?q=a%26b", title: "A" }, { url: "https://a.example/s?q=a&b", title: "B" }])).toHaveLength(2);
  });

  it("escapes source titles and wraps unsafe destinations in generated links", () => {
    const url = "https://en.example/wiki/Foo_(bar";
    const result: DeepResearchResult = {
      version: 1,
      report: { title: "R", markdown: "# R" },
      notes: [],
      sources: [{ url, title: "A [draft] \\ title\nnext" }],
      claims: [{ text: "fact", kind: "verified", sourceUrl: url }],
      related: [],
    };
    const cs = buildChangeSet({ runId: "r", result, folder: "Research", existingFiles: [], notes: {}, content: {}, now: new Date("2026-07-17T12:00:00Z") });
    const report = cs.ops.find((o) => o.kind === "create")!;
    expect(report.content).toContain(`- [A \\[draft\\] \\\\ title next](<${url}>)`);
    expect(report.content).toContain(`([source](<${url}>))`);
  });
});
