import { describe, expect, it } from "vitest";
import type { NoteMeta, VaultFile } from "../types";
import {
  DEFAULT_DEEP_RESEARCH_LIMITS,
  RESEARCH_DEPTH_PRESETS,
  DEPTH_LIMITS,
  clampDepth,
  limitsForDepth,
  buildResearchContext,
  redactResearchContent,
  buildResearchPrompt,
  canonicalizeSourceUrl,
  dedupeSources,
  parseResultEnvelope,
  buildChangeSet,
  buildApplyPlan,
  safeNoteTitle,
  safeFolderName,
  makeLinkTarget,
  titleSlug,
  validateResearchResult,
  researchReportQualityIssues,
  utf8ByteLength,
  truncateUtf8,
  createRunId,
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

describe("titleSlug / makeLinkTarget", () => {
  it("slugifies for dedupe comparison", () => {
    expect(titleSlug("Deep Research — Foo Bar!")).toBe("deep-research-foo-bar");
  });
  it("builds a vault-relative md link target", () => {
    expect(makeLinkTarget("Research", "My Note")).toBe("Research/My Note.md");
    expect(makeLinkTarget("", "Root Note")).toBe("Root Note.md");
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
        "topic.md": "Useful prose. API_KEY=sk-proj-abcdefghijklmnop123456",
        "credentials.md": "password=never-send",
        "API_KEYS.md": "token=never-send",
      },
      limits: DEFAULT_DEEP_RESEARCH_LIMITS,
    });
    expect(out.notes.map((n) => n.relPath)).toEqual(["topic.md"]);
    expect(out.notes[0].content).toMatch(/\[REDACTED(?: CREDENTIAL)?\]/);
    expect(out.notes[0].content).not.toContain("abcdefghijklmnop");
    expect(out.notes[0].redacted).toBe(true);
  });

  it("pulls deterministic related notes via backlinks, outgoing links, tags, and search", () => {
    const out = buildResearchContext({
      query: "mesa",
      activePath: "a.md",
      selectedPaths: [],
      files, notes, content,
      limits: DEFAULT_DEEP_RESEARCH_LIMITS,
    });
    const paths = out.notes.map((n) => n.relPath);
    expect(paths).toContain("b.md"); // backlink + outgoing
    expect(paths).toContain("sub/d.md"); // shared #ai tag
  });

  it("enforces the note cap and reports truncation", () => {
    const out = buildResearchContext({
      query: "a",
      activePath: "a.md",
      selectedPaths: [],
      files, notes, content,
      limits: { ...DEFAULT_DEEP_RESEARCH_LIMITS, maxContextNotes: 2 },
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
});

describe("redactResearchContent", () => {
  it("removes private-key blocks and common provider-token shapes", () => {
    const out = redactResearchContent(
      "before\n-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n" +
      "ghp_abcdefghijklmnopqrstuvwxyz123456\nafter"
    );
    expect(out.redacted).toBe(true);
    expect(out.content).not.toContain("BEGIN PRIVATE KEY");
    expect(out.content).not.toContain("ghp_");
    expect(out.content).toContain("before");
    expect(out.content).toContain("after");
  });
});

describe("UTF-8 byte limits", () => {
  it("truncates on code-point boundaries by bytes, not JavaScript code units", () => {
    expect(utf8ByteLength("😀a")).toBe(5);
    expect(truncateUtf8("😀a", 4)).toBe("😀");
    expect(truncateUtf8("😀a", 3)).toBe("");
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

// --- envelope parsing + validation -------------------------------------------
describe("extractEnvelope / parseResultEnvelope", () => {
  it("parses a valid envelope from model text", () => {
    const result: DeepResearchResult = {
      version: 1,
      report: { title: "Report", markdown: "# Hi [[A]]" },
      notes: [],
      sources: [{ url: "https://a.com/x", title: "A" }],
      claims: [],
      related: [],
    };
    const env = JSON.stringify({ type: "mesa_deep_research", runId: "r1", result });
    const out = parseResultEnvelope(`some prose\n\`\`\`json\n${env}\n\`\`\`\ntrailing`, "r1");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.report.title).toBe("Report");
  });

  it("rejects an envelope for a different run id", () => {
    const env = JSON.stringify({
      type: "mesa_deep_research", runId: "other",
      result: { version: 1, report: { title: "t", markdown: "m" }, notes: [], sources: [], claims: [], related: [] },
    });
    const out = parseResultEnvelope(env, "r1");
    expect(out.ok).toBe(false);
  });

  it("rejects malformed / missing envelope", () => {
    expect(parseResultEnvelope("no json here", "r1").ok).toBe(false);
    expect(parseResultEnvelope('{"type":"nope"}', "r1").ok).toBe(false);
  });

  it("rejects a result missing the report markdown", () => {
    const env = JSON.stringify({
      type: "mesa_deep_research", runId: "r1",
      result: { version: 1, report: { title: "t", markdown: "" }, notes: [], sources: [], claims: [], related: [] },
    });
    const out = parseResultEnvelope(env, "r1");
    expect(out.ok).toBe(false);
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
      report: { title: "R", markdown: "# R\n\nAPI_KEY=sk-proj-abcdefghijklmnop123456" },
      notes: [{
        title: "N",
        markdown: "password=do-not-ship-this",
        sourceUrl: null,
        links: [],
      }],
      sources: [{ url: "https://a.com/x", title: "A" }],
      claims: [],
      related: [{
        relPath: "existing.md",
        reason: "x",
        update: {
          markdown: "access_token=do-not-ship-this",
          sourceUrls: ["https://a.com/x"],
          confidence: "high",
        },
      }],
    };
    const out = validateResearchResult(result);
    expect(out.report.markdown).not.toContain("abcdefghijklmnop");
    expect(out.notes[0].markdown).not.toContain("do-not-ship-this");
    expect(out.related[0].update?.markdown).not.toContain("do-not-ship-this");
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
        markdown: "# R\n\n## Abstract\nAnswer.\n\n## Methodology\nTwo rounds.\n\n## Findings\n### Q1\nEvidence [A](https://a.com/x).\n\n### Q2\nMore evidence.\n\n## Synthesis\nConclusion.\n\n## Confidence and limitations\nHigh with limits.\n\n## Disagreements\nNone.\n\n## Open questions\nNext work.",
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
    expect(report).toBeTruthy();
    expect(report!.relPath.startsWith("Research/")).toBe(true);
    expect(report!.content).toContain("[[Research/Source A.md]]");
    expect(report!.content).toContain("[[existing.md]]");
    expect(report!.content).toContain("https://a.com/x");
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
    expect(update).toBeTruthy();
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

// --- depth presets + clamping ---------------------------------------------------
describe("clampDepth / limitsForDepth / presets", () => {
  it("clamps depth to the allowed ranges", () => {
    const d = clampDepth({ rounds: 99, subQuestions: 0, maxSources: 999, maxGeneratedNotes: -3 });
    expect(d.rounds).toBe(DEPTH_LIMITS.rounds.max);
    expect(d.subQuestions).toBe(DEPTH_LIMITS.subQuestions.min);
    expect(d.maxSources).toBe(DEPTH_LIMITS.maxSources.max);
    expect(d.maxGeneratedNotes).toBe(DEPTH_LIMITS.maxGeneratedNotes.min);
  });

  it("merges depth into limits, overriding source/note caps only", () => {
    const merged = limitsForDepth(DEFAULT_DEEP_RESEARCH_LIMITS, { rounds: 3, subQuestions: 6, maxSources: 20, maxGeneratedNotes: 10 });
    expect(merged.maxSources).toBe(20);
    expect(merged.maxGeneratedNotes).toBe(10);
    expect(merged.maxContextNotes).toBe(DEFAULT_DEEP_RESEARCH_LIMITS.maxContextNotes);
    expect(merged.maxTotalBytes).toBe(DEFAULT_DEEP_RESEARCH_LIMITS.maxTotalBytes);
  });

  it("presets are ordered quick < standard < deep in thoroughness", () => {
    expect(RESEARCH_DEPTH_PRESETS.quick.maxSources).toBeLessThan(RESEARCH_DEPTH_PRESETS.standard.maxSources);
    expect(RESEARCH_DEPTH_PRESETS.standard.maxSources).toBeLessThan(RESEARCH_DEPTH_PRESETS.deep.maxSources);
    expect(RESEARCH_DEPTH_PRESETS.quick.subQuestions).toBeLessThan(RESEARCH_DEPTH_PRESETS.deep.subQuestions);
    expect(RESEARCH_DEPTH_PRESETS.quick.rounds).toBeLessThan(RESEARCH_DEPTH_PRESETS.deep.rounds);
  });
});

// --- run id -----------------------------------------------------------------
describe("createRunId", () => {
  it("creates unique run ids", () => {
    const a = createRunId();
    const b = createRunId();
    expect(a).not.toBe(b);
  });
});

// --- Pi session safety contract (source-pinned) -------------------------------
// The Deep Research write-block is only live while Pi runs with the
// deep-research extension. A session restart on context drift would silently
// shed that extension mid-run. These pins keep AgentPanel's reuse conservative
// and keep the DR launch wired into the spawn env/args.
import agentPanelSrc from "../components/AgentPanel.tsx?raw";

describe("Pi session Deep Research safety contract", () => {
  it("never silently restarts the shared Pi session on context-text drift", () => {
    // The old code stopped the session whenever contextText changed before
    // first user input — that would drop the DR write-block mid-run.
    expect(agentPanelSrc).toContain("Never silently kill a live Pi session");
    expect(agentPanelSrc).not.toMatch(
      /contextText !== contextText &&\s*\n?\s*!SHARED_PI_SESSION\.userInputSeen/
    );
  });

  it("loads the deep-research extension while a run is active", () => {
    expect(agentPanelSrc).toContain("piDeepResearchLaunch");
    // The env constant itself lives in lib/agent.ts (piDeepResearchLaunch).
    expect(agentPanelSrc).toContain("drActive");
  });

  it("opens Deep Research as Pi's own slide-out wing without a duplicate overlay window", () => {
    expect(agentPanelSrc).toContain("openDeepResearch(false)");
    expect(agentPanelSrc).toContain("<DeepResearchPanel piSurfaceAvailable />");
    expect(agentPanelSrc).toContain('className={"dr-wing" + (browserSlideOut ? " slide" : " inline")}');
  });
});
