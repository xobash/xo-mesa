import type { DeepResearchRunState } from "../store";
import { IN_TAURI } from "../lib/vault";
import { type ResearchContextScope, type ResearchActivity } from "../lib/deepResearch";
import { invoke } from "@tauri-apps/api/core";
import { clamp } from "../lib/clamp";

export function busy(run: DeepResearchRunState): boolean {
  return run.phase === "planning" || run.phase === "researching" || run.phase === "synthesizing";
}

export function activeRunStarted(run: DeepResearchRunState): boolean {
  return busy(run) && run.startedAt > 0;
}

export const KIND_ICON: Record<ResearchActivity["kind"], string> = {
  plan: "▤",
  round: "↻",
  subquestion: "→",
  search: "⌕",
  source: "▹",
  note: "✓",
  synthesize: "✎",
  status: "·",
};

export const SCOPE_INFO: Record<ResearchContextScope, string> = {
  workspace:
    "Send only what you're looking at: the active note, selected notes, and their direct links (backlinks + outgoing).",
  vault:
    "Also mine the whole vault: notes sharing tags with the picked set and query-term content matches.",
};

export function num(lo: number, hi: number, set: (n: number) => void) {
  return (e: React.ChangeEvent<HTMLInputElement>) => {
    const n = Number(e.target.value);
    if (Number.isFinite(n)) set(clamp(Math.round(n), lo, hi));
  };
}


export async function saveKitToDisk(text: string, runId: string, completed: boolean): Promise<boolean> {
  if (!IN_TAURI) return false;
  const safeRunId = runId.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 48) || "run";
  try {
    // Native picks the path and refuses vault destinations; the renderer has no fs write grant.
    return await invoke<boolean>("research_kit_save", {
      name: `mesa-deep-research-${safeRunId}-${completed ? "complete" : "troubleshooting"}.md`,
      content: text,
    });
  } catch {
    return false;
  }
}
