import { describe, expect, it } from "vitest";
import type { ResearchActivity } from "./deepResearch";
import {
  buildResearchTroubleshootingKit,
  explainResearchTimeout,
  RESEARCH_TROUBLESHOOTING_IDLE_MS,
  researchTroubleshootingTrigger,
  type ResearchRunSnapshot,
} from "./deepResearchDiagnostics";

const T0 = Date.parse("2026-07-20T18:00:00Z");

function act(partial: Partial<ResearchActivity> & Pick<ResearchActivity, "kind" | "message">): ResearchActivity {
  return { at: T0 + 1000, ...partial };
}

function run(partial: Partial<ResearchRunSnapshot> = {}): ResearchRunSnapshot {
  return {
    runId: "dr-test-1",
    phase: "researching",
    launchStage: "active",
    query: "how do tides work",
    depth: { rounds: 2, subQuestions: 5, maxSources: 16, maxGeneratedNotes: 8 },
    startedAt: T0,
    promptBytes: 2048,
    promptSentAt: T0 + 500,
    firstSignalAt: T0 + 1000,
    error: null,
    context: {
      query: "how do tides work",
      scope: "workspace",
      notes: [
        { relPath: "a.md", title: "a", tags: [], content: "", via: ["active"] },
        { relPath: "b.md", title: "b", tags: [], content: "", via: ["backlink", "outgoing"], redacted: true },
      ],
      totalBytes: 1234,
      truncated: false,
      omittedNotes: 0,
      summary: "2 notes in context, 1234 B",
    },
    subQuestions: ["q1", "q2"],
    currentRound: 1,
    currentSubQuestion: "q1",
    sources: [
      {
        url: "https://a.com/x",
        title: "A",
        status: "done",
        archiveStatus: "saved",
        archiveRelPath: "Web Archives/a.html",
        archiveKind: "page",
      },
      { url: "https://b.com/y", status: "reading" },
    ],
    activity: [act({ kind: "status", message: "Preparing research context…", at: T0 })],
    reportDraft: "",
    ...partial,
  };
}

describe("explainResearchTimeout", () => {
  it("diagnoses a dead Pi session first", () => {
    const msg = explainResearchTimeout({ run: run(), piSessionLive: false, now: T0 + 400_000 });
    expect(msg).toContain("no longer running");
  });

  it("diagnoses zero self-reports AND zero observed browsing as protocol never engaged", () => {
    const msg = explainResearchTimeout({
      run: run({ sources: [], subQuestions: [] }),
      piSessionLive: true,
      now: T0 + 400_000,
    });
    expect(msg).toContain("NO progress reports");
    expect(msg).toContain("NO web browsing");
    expect(msg).toContain("deep_research_progress");
    expect(msg).toContain("Pi terminal");
  });

  it("distinguishes a submitted prompt with no model signal", () => {
    const msg = explainResearchTimeout({
      run: run({
        launchStage: "waiting-for-model",
        activity: [act({ kind: "status", message: "Research task submitted to Pi" })],
        subQuestions: [],
        sources: [],
        firstSignalAt: null,
      }),
      piSessionLive: true,
      now: T0 + 400_000,
    });
    expect(msg).toContain("submitted a 2048 B research prompt");
    expect(msg).toContain("model server logs");
  });

  it("diagnoses observed browsing without self-reports as protocol not followed", () => {
    const msg = explainResearchTimeout({
      run: run({
        activity: [
          act({ kind: "status", message: "Preparing research context…", at: T0 }),
          act({ kind: "search", message: "Searched for “tides”", observed: true }),
          act({ kind: "source", message: "Opened a.com/x", observed: true }),
        ],
      }),
      piSessionLive: true,
      now: T0 + 400_000,
    });
    expect(msg).toContain("observed 2 real page visits");
    expect(msg).toContain("never called deep_research_progress");
  });

  it("diagnoses a stalled run with the last self-reported activity and progress counts", () => {
    const msg = explainResearchTimeout({
      run: run({
        activity: [
          act({ kind: "plan", message: "q1\nq2" }),
          act({ kind: "subquestion", message: "Researching q1", at: T0 + 60_000 }),
        ],
        reportDraft: "## Draft",
      }),
      piSessionLive: true,
      now: T0 + 460_000,
    });
    expect(msg).toContain('went quiet after "Researching q1"');
    expect(msg).toContain("round 1/2");
    expect(msg).toContain("1/2 sources read");
    expect(msg).toContain("no activity for the last");
  });

  it("always points at the troubleshooting kit", () => {
    const msg = explainResearchTimeout({ run: run(), piSessionLive: true, now: T0 + 400_000 });
    expect(msg).toContain("Copy troubleshooting kit");
  });
});

describe("researchTroubleshootingTrigger", () => {
  it("stays hidden during the first two minutes of a quiet submitted run", () => {
    expect(
      researchTroubleshootingTrigger(
        run({
          launchStage: "waiting-for-model",
          firstSignalAt: null,
          activity: [act({ kind: "status", message: "Waiting for Pi" })],
        }),
        T0 + 500 + RESEARCH_TROUBLESHOOTING_IDLE_MS - 1
      )
    ).toBeNull();
  });

  it("reveals diagnostics after two minutes with zero real actions", () => {
    expect(
      researchTroubleshootingTrigger(
        run({
          launchStage: "waiting-for-model",
          firstSignalAt: null,
          activity: [act({ kind: "status", message: "Waiting for Pi" })],
        }),
        T0 + 500 + RESEARCH_TROUBLESHOOTING_IDLE_MS
      )
    ).toBe("initial-inactivity");
  });

  it("stays hidden once any real research action exists", () => {
    expect(
      researchTroubleshootingTrigger(
        run({
          activity: [
            act({ kind: "status", message: "Waiting for Pi" }),
            act({ kind: "search", message: "Searched for tides", observed: true }),
          ],
        }),
        T0 + 500 + RESEARCH_TROUBLESHOOTING_IDLE_MS * 2
      )
    ).toBeNull();
  });

  it("reveals diagnostics immediately for a confirmed run error", () => {
    expect(
      researchTroubleshootingTrigger(
        run({ phase: "error", launchStage: "error", error: "Provider API call failed." }),
        T0 + 2_000
      )
    ).toBe("confirmed-error");
  });

  it("does not expose a kit for preflight input errors that never started a run", () => {
    expect(
      researchTroubleshootingTrigger(
        run({
          phase: "error",
          launchStage: "error",
          startedAt: 0,
          promptSentAt: null,
          error: "Enter a research question first.",
        }),
        T0 + 2_000
      )
    ).toBeNull();
  });
});

describe("buildResearchTroubleshootingKit", () => {
  const input = {
    appVersion: "0.1.0",
    userAgent: "TestAgent/1.0 (macOS)",
    vaultFileCount: 718,
    vaultNoteCount: 650,
    piSessionLive: true,
    agentProvider: "manual",
    agentModel: "",
    run: run({
      error: "Deep Research timed out after 6.0m — no activity for the last 6.0m.",
      activity: [
        act({ kind: "status", message: "Preparing research context…", at: T0 }),
        act({ kind: "search", message: "Searched for “tides”", observed: true, at: T0 + 5_000 }),
        act({ kind: "subquestion", message: "Researching q1", round: 1, at: T0 + 9_000 }),
      ],
    }),
    now: new Date(T0 + 400_000),
  };

  it("includes environment, run, context, progress, and timeline sections", () => {
    const kit = buildResearchTroubleshootingKit(input);
    expect(kit).toContain("# Mesa Deep Research troubleshooting kit");
    expect(kit).toContain("Mesa version: 0.1.0");
    expect(kit).toContain("718 files / 650 notes (path withheld)");
    expect(kit).toContain("Pi session live: yes");
    expect(kit).toContain("Run id: dr-test-1");
    expect(kit).toContain("Phase: researching");
    expect(kit).toContain("Launch stage: active");
    expect(kit).toContain("Prompt: 2048 B");
    expect(kit).toContain("Scope: workspace");
    expect(kit).toContain("- Selected via: active 1, backlink 1, outgoing 1");
    expect(kit).toContain("a.md (active)");
    expect(kit).toContain("b.md (backlink, outgoing, redacted)");
    expect(kit).toContain("Model self-reports (deep_research_progress): 1 · Mesa-observed navigations: 1");
    expect(kit).toContain("- [done] A — https://a.com/x");
    expect(kit).toContain("archive=saved:page (Web Archives/a.html)");
    expect(kit).toContain("- [reading] https://b.com/y");
    expect(kit).toContain("## Activity timeline");
    expect(kit).toContain("[search, observed] Searched for “tides”");
    expect(kit).toContain("[subquestion, self-reported] Researching q1 (round 1)");
    expect(kit).toContain("Error: Deep Research timed out");
  });

  it("scrubs credential-shaped values from every line", () => {
    const kit = buildResearchTroubleshootingKit({
      ...input,
      run: run({
        query: "why is sk-proj-abcdefghijklmnop123456 leaking",
        activity: [act({ kind: "status", message: "token=ghp_abcdefghijklmnopqrstuv123456 seen" })],
      }),
    });
    expect(kit).not.toContain("sk-proj-abcdefghijklmnop123456");
    expect(kit).not.toContain("ghp_abcdefghijklmnopqrstuv123456");
    expect(kit).toContain("[REDACTED CREDENTIAL]");
  });

  it("caps the activity timeline and reports the omission", () => {
    const many = Array.from({ length: 90 }, (_, i) =>
      act({ kind: "note", message: `line ${i}`, at: T0 + i * 1000 })
    );
    const kit = buildResearchTroubleshootingKit({ ...input, run: run({ activity: many }) });
    expect(kit).toContain("(10 earlier entries omitted)");
    expect(kit).toContain("line 89");
    expect(kit).not.toContain("- line 9\n"); // early lines dropped
  });

  it("handles a run that never built context", () => {
    const kit = buildResearchTroubleshootingKit({ ...input, run: run({ context: null, activity: [] }) });
    expect(kit).toContain("(none — the run never built a context)");
    expect(kit).toContain("(no activity was recorded)");
  });
});
