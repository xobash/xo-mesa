// Scripted Deep Research run. Drives Mesa's real research controller through the
// same `mesa://deep-research` / `mesa://browse` events the Pi extension emits.
(() => {
  const S = window.__REC_SHARED__;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms * (S.research.pace ?? 1)));
  const U = {
    sci: "https://www.science.org/doi/10.1126/science.aad8745",
    fro: "https://www.frontiersin.org/articles/10.3389/fmars.2019.00499",
    roy: "https://royalsocietypublishing.org/doi/10.1098/rstb.2013.0269",
    nat: "https://www.nature.com/articles/s41598-019-51114-y",
    oup: "https://academic.oup.com/bioscience/article/68/2/64/4810652",
    wil: "https://onlinelibrary.wiley.com/doi/10.1111/brv.12850",
  };
  const title = (u) => S.pages.articles[u].title;
  const host = (u) => new URL(u).hostname.replace(/^www\./, "");
  const SQ = [
    "How long do kelp forests take to recover after marine heatwaves?",
    "What feedbacks block or delay recovery?",
    "Which interventions speed recovery?",
    "Do giant and bull kelp recover at different rates?",
    "What urchin densities allow kelp to return?",
  ];
  const plan = [
    { round: 1, sq: 0, search: "kelp forest recovery after marine heatwave years", sources: [U.sci, U.fro] },
    { round: 1, sq: 1, search: "urchin barrens hysteresis kelp recovery", sources: [U.roy, U.nat] },
    { round: 1, sq: 2, search: "kelp restoration urchin removal outcomes review", sources: [U.wil] },
    { round: 2, sq: 3, search: "giant kelp bull kelp recovery heatwave comparison", sources: [] },
    { round: 2, sq: 4, search: "turf algae block kelp recruitment", sources: [U.oup] },
  ];
  const report = `# How fast do kelp forests recover after marine heatwaves?

## Abstract

Kelp forests can take anywhere from a few years to decades to recover after marine heatwaves; recovery is limited less by temperature than by grazing and turf feedbacks (${U.roy}).

## Methodology

Searched for peer-reviewed studies on post-heatwave kelp dynamics, read primary sources in Mesa's browser, and cross-checked claims against the vault's existing notes.

## Findings

### ${SQ[0]}

Recovery ranges from a few years to none observed. Western Australian reefs showed no kelp return years after 2011 (${U.sci}); responses in Baja California differed among sites (${U.fro}).

### ${SQ[1]}

Urchin barrens and turf algae are self-reinforcing: kelp returns only far below the grazing level that caused collapse (${U.roy}); northern California barrens persisted after the water cooled (${U.nat}); turfs block recruitment (${U.oup}).

### ${SQ[2]}

Restoration targets the feedbacks — grazer control, transplanting, seeding — but the evidence base is uneven (${U.wil}).

### ${SQ[3]}

Bull kelp, an annual, collapsed faster and has recovered less than perennial giant kelp where urchins remain abundant (${U.nat}; ${U.fro}).

### ${SQ[4]}

Reverse thresholds sit roughly an order of magnitude below the densities that triggered barrens (${U.roy}).

## Synthesis

Temperature sets the timing of loss; grazers and turfs set the timing of recovery. For [[Chapter 3 - Canopy Recovery]], urchin density is the variable to model.

## Confidence and limitations

High confidence in the hysteresis mechanism; medium confidence in recovery-time ranges, which come from few long time series.

## Disagreements

Sites with strong upwelling recovered within two years (${U.fro}), while other regions saw no recovery (${U.sci}).

## Open questions

- Does culling below the reverse threshold reopen recovery at Point Lobos?
- How long does a turf state persist without disturbance?
`;
  const result = {
    version: 1,
    subQuestions: SQ,
    report: { title: "Kelp recovery after marine heatwaves", markdown: report },
    notes: [{
      title: "Kelp recovery windows",
      markdown: "Recovery after heatwaves depends on grazing and turf feedbacks more than on temperature alone.\n",
      sourceUrl: null,
      links: ["Topics/Kelp Forests.md", "Topics/Marine Heatwaves.md", "Topics/Sea Urchin Barrens.md"],
    }],
    sources: [U.sci, U.fro, U.roy, U.nat, U.oup, U.wil].map((url) => ({ url, title: title(url) })),
    claims: [
      { text: "Kelp returns only far below the urchin density that caused collapse.", kind: "verified", sourceUrl: U.roy },
      { text: "Western Australian kelp did not recover years after the 2011 heatwave.", kind: "verified", sourceUrl: U.sci },
      { text: "Northern California barrens persisted after the water cooled.", kind: "verified", sourceUrl: U.nat },
    ],
    related: [{
      relPath: "Projects/Chapter 3 - Canopy Recovery.md",
      reason: "The chapter's hypothesis depends on urchin-driven recovery thresholds.",
      update: {
        markdown: "Evidence: recovery requires urchin density far below the collapse threshold (Ling 2015) — see [[Kelp recovery after marine heatwaves]].",
        sourceUrls: [U.roy], confidence: "high",
      },
    }],
  };

  const progress = (runId, p) => S.emit("mesa://deep-research", JSON.stringify({ kind: "progress", runId, ...p }));

  S.research = {
    pace: 1,
    pending: null,
    onReply(args) { this.pending?.(args); },
    async run(pi, prompt) {
      const runId = /dr-[a-z0-9.]+-[a-z0-9]+/.exec(prompt)?.[0];
      const query = S.research.query ?? "How fast do kelp forests recover after marine heatwaves?";
      pi.running = true;
      pi.add([["acc", "› "], ["user", "Deep Research · "], ["n", query]]);
      await sleep(500);
      pi.add([["warn", "◌ "], ["dim", "mesa-deep-research: write tools gated for this run; reporting progress to Mesa."]]);
      S.emit("mesa://deep-research", JSON.stringify({ kind: "agent-start", runId }));
      await S.pi.busy(pi, "planning", 900 * (S.research.pace ?? 1));
      progress(runId, { phase: "planning", activityKind: "plan", message: SQ.join("\n") });
      pi.add([["n", "Plan: 5 sub-questions, 2 rounds."]]);
      pi.tokens = "↑9.8k ↓0"; pi.ctx = "9%";
      for (const rel of ["Projects/Chapter 3 - Canopy Recovery.md", "Topics/Kelp Forests.md"]) {
        S.emit("activity", JSON.stringify({ op: "read", path: `mesa://demo/Tidewater/${rel}` }));
        await S.pi.busy(pi, "reading", 350 * (S.research.pace ?? 1));
        pi.add([["ok", "✓ "], ["b", "read "], ["path", rel], ["mute", "  vault context"]]);
      }
      let lastRound = 0;
      for (const step of plan) {
        if (step.round !== lastRound) {
          lastRound = step.round;
          progress(runId, { activityKind: "round", round: step.round, message: `Round ${step.round}` });
        }
        progress(runId, { activityKind: "subquestion", subQuestion: SQ[step.sq], round: step.round, message: SQ[step.sq] });
        const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(step.search)}`;
        S.emit("mesa://browse", searchUrl);
        await S.pi.busy(pi, "searching", 700 * (S.research.pace ?? 1));
        progress(runId, { activityKind: "search", message: `Searched: ${step.search}`, subQuestion: SQ[step.sq], round: step.round });
        pi.add([["ok", "✓ "], ["b", "browse "], ["path", step.search], ["mute", "  search"]]);
        pi.add(Object.assign([["dim", `  ${4 + step.sq % 3} results`]], { indent: 2 }));
        for (const url of step.sources) {
          S.emit("mesa://browse", url);
          progress(runId, { activityKind: "source", sourceUrl: url, sourceTitle: title(url), subQuestion: SQ[step.sq], round: step.round, message: `Reading ${title(url)}` });
          await S.pi.busy(pi, "reading", 1100 * (S.research.pace ?? 1));
          pi.add([["ok", "✓ "], ["b", "browse_read "], ["path", host(url)], ["mute", "  reading"]]);
          pi.add(Object.assign([["dim", "  " + title(url)]], { indent: 2 }));
          progress(runId, { activityKind: "note", sourceUrl: url, sourceTitle: title(url), subQuestion: SQ[step.sq], round: step.round, message: `Noted: ${title(url)}` });
          pi.tokens = `↑${(10 + Math.random() * 2).toFixed(1)}k ↓${Math.round(Math.random() * 20)}`;
        }
      }
      progress(runId, { phase: "synthesizing", activityKind: "synthesize", message: "Writing the report", draftMarkdown: report });
      await S.pi.busy(pi, "writing", 1500 * (S.research.pace ?? 1));
      pi.add([]);
      pi.add([["n", "Synthesis drafted. Submitting the structured result to Mesa for validation."]]);
      pi.tokens = "↑12.2k ↓27"; pi.ctx = "16%";
      const reply = new Promise((resolve) => { S.research.pending = resolve; });
      S.emit("mesa://deep-research", JSON.stringify({ kind: "finish", runId, requestId: "req-1", result }));
      const r = await reply;
      S.research.lastReply = r;
      pi.add([["dim", r.status === "accepted" ? "· Mesa accepted the report · proposed notes are waiting for review." : `· Mesa: ${r.message}`]]);
      S.emit("mesa://deep-research", JSON.stringify({ kind: "agent-end", runId, reason: "Report accepted." }));
      pi.running = false;
      pi.setStatus("ok", "● ready");
    },
  };
})();
