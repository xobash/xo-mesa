import type { DeepResearchRunState } from "../store";
import { IN_TAURI } from "../lib/vault";
import { type ResearchContextScope, type ResearchActivity } from "../lib/deepResearch";
import { invoke } from "@tauri-apps/api/core";

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
    if (Number.isFinite(n)) set(Math.max(lo, Math.min(hi, Math.round(n))));
  };
}

export async function copyText(text: string | Promise<string>): Promise<boolean> {
  if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    try {
      // Begin within the click; WebKit can resolve the native snapshot afterward.
      await navigator.clipboard.write([new ClipboardItem({
        "text/plain": Promise.resolve(text).then(value => new Blob([value], { type: "text/plain" })),
      })]);
      return true;
    } catch {
      /* Keep the existing text and disk fallbacks. */
    }
  }
  const resolved = typeof text === "string" ? text : await text;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(resolved);
      return true;
    }
  } catch {
    /* Fall through to the legacy WebKit/Tauri clipboard path. */
  }
  const area = document.createElement("textarea");
  area.value = resolved;
  area.setAttribute("readonly", "true");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
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
