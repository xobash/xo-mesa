import type { ResearchActivity, DeepResearchPhase, DeepResearchLaunchStage, ResearchDepth, DeepResearchContext } from "./deepResearch";

interface RunSnapshot {
  runId: string; phase: DeepResearchPhase; launchStage: DeepResearchLaunchStage;
  query: string; depth: ResearchDepth; startedAt: number; promptBytes: number;
  promptSentAt: number | null; firstSignalAt: number | null; error: string | null;
  context: DeepResearchContext | null; activity: ResearchActivity[];
}

const selfReported = (a: ResearchActivity[]) => a.filter((x) => !x.observed && x.kind !== "status");
const observed = (a: ResearchActivity[]) => a.filter((x) => x.observed);
const minutes = (ms: number) => ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${(ms / 60_000).toFixed(1)}m`;

export function explainResearchTimeout(input: { run: RunSnapshot; piSessionLive: boolean; now?: number }): string {
  const { run, piSessionLive } = input;
  const now = input.now ?? Date.now();
  const self = selfReported(run.activity), seen = observed(run.activity);
  const lastAt = run.activity.reduce((m, a) => Math.max(m, a.at), run.startedAt);
  const lines = [`Deep Research timed out after ${minutes(now - run.startedAt)} — no activity for the last ${minutes(now - lastAt)}.`];
  if (!piSessionLive) lines.push("The Pi session is no longer running — it may have crashed or been closed. Reopen the Pi agent, let it finish starting, then run again.");
  else if (self.length === 0 && seen.length === 0) lines.push(run.launchStage === "waiting-for-model" && run.promptSentAt
    ? `Mesa submitted a ${run.promptBytes} B research prompt to Pi's PTY, but received NO model progress and observed NO web browsing. Check the Pi terminal for the submitted prompt and model server logs.`
    : "Mesa received NO progress reports from the model and observed NO web browsing. Check the Pi terminal to see what the model actually did.");
  else if (self.length === 0) lines.push("Mesa observed browser activity but received no progress reports from the model. The research protocol may not be active in the Pi session.");
  else if (seen.length === 0) lines.push("Mesa received model progress but observed no browser activity. The model may be reasoning without gathering source evidence.");
  else lines.push("Mesa received both model progress and browser activity, but the run became idle. Check the last activity entry and continue or cancel the run.");
  return lines.join("\n");
}
