import { describe, expect, it } from "vitest";
import type { ResearchActivity } from "./deepResearch";
import { explainResearchTimeout } from "./deepResearchTimeout";

const T0 = Date.parse("2026-07-20T18:00:00Z");

function act(partial: Partial<ResearchActivity> & Pick<ResearchActivity, "kind" | "message">): ResearchActivity {
  return { at: T0 + 1000, ...partial };
}

type Run = Parameters<typeof explainResearchTimeout>[0]["run"];

function run(partial: Partial<Run> = {}): Run {
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
    context: null,
    activity: [act({ kind: "status", message: "Preparing research context…", at: T0 })],
    ...partial,
  };
}

describe("explainResearchTimeout", () => {
  it("states the run age and idle time", () => {
    const msg = explainResearchTimeout({
      run: run({ activity: [act({ kind: "plan", message: "q1", at: T0 + 60_000 })] }),
      piSessionLive: true,
      now: T0 + 460_000,
    });
    expect(msg.split("\n")[0]).toBe("Deep Research timed out after 7.7m — no activity for the last 6.7m.");
  });

  it("diagnoses a dead Pi session first", () => {
    const msg = explainResearchTimeout({ run: run(), piSessionLive: false, now: T0 + 400_000 });
    expect(msg).toContain("no longer running");
  });

  it("diagnoses zero self-reports AND zero observed browsing", () => {
    const msg = explainResearchTimeout({ run: run(), piSessionLive: true, now: T0 + 400_000 });
    expect(msg).toContain("NO progress reports");
    expect(msg).toContain("NO web browsing");
    expect(msg).toContain("Pi terminal");
  });

  it("distinguishes a submitted prompt with no model signal", () => {
    const msg = explainResearchTimeout({
      run: run({
        launchStage: "waiting-for-model",
        activity: [act({ kind: "status", message: "Research task submitted to Pi" })],
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
    expect(msg).toContain("observed browser activity but received no progress reports");
  });

  it("diagnoses model progress without observed browsing", () => {
    const msg = explainResearchTimeout({
      run: run({
        activity: [
          act({ kind: "plan", message: "q1\nq2" }),
          act({ kind: "subquestion", message: "Researching q1", at: T0 + 60_000 }),
        ],
      }),
      piSessionLive: true,
      now: T0 + 460_000,
    });
    expect(msg).toContain("received model progress but observed no browser activity");
    expect(msg).toContain("no activity for the last");
  });

  it("diagnoses an idle run that had both progress and browsing", () => {
    const msg = explainResearchTimeout({
      run: run({
        activity: [
          act({ kind: "plan", message: "q1" }),
          act({ kind: "source", message: "Opened a.com/x", observed: true }),
        ],
      }),
      piSessionLive: true,
      now: T0 + 400_000,
    });
    expect(msg).toContain("received both model progress and browser activity, but the run became idle");
  });
});
