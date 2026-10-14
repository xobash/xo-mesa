import { groupTasks, type TaskItem } from "./tasks";
import { DUE_RE } from "./taskParsing";
import type { DeepResearchPhase } from "./deepResearch";
import type { TextSaveState } from "./textSaveCoordinator";

/** Bounded workspace summary shown by the native menu-bar / tray item. */
export interface TraySnapshot {
  vault: string | null;
  save: string;
  tasksSummary: string;
  tasks: { label: string; rel: string; line: number }[];
  research: string | null;
  sync: string;
}

export interface TrayInput {
  vaultName: string | null;
  saveState: TextSaveState;
  tasks: readonly TaskItem[];
  today: string;
  researchPhase: DeepResearchPhase | null;
  syncEnabled: boolean;
  syncBusy: boolean;
  syncPeers: number;
}

export const TRAY_TASK_LIMIT = 5;

const RESEARCH_LABEL: Partial<Record<DeepResearchPhase, string>> = {
  planning: "Planning",
  researching: "Researching",
  synthesizing: "Drafting report",
  review: "Ready for review",
  applying: "Applying changes",
};

function saveLine({ pending, saving, failed }: TextSaveState): string {
  if (failed > 0) return failed === 1 ? "1 save needs attention" : `${failed} saves need attention`;
  if (saving > 0 || pending > 0) return "Saving changes…";
  return "All changes saved";
}

/** Open tasks in dashboard order (overdue, today, upcoming, undated). */
export function buildTraySnapshot(input: TrayInput): TraySnapshot {
  const groups = groupTasks([...input.tasks], input.today);
  const open = [...groups.overdue, ...groups.today, ...groups.upcoming, ...groups.noDue];
  const tasksSummary = open.length === 0
    ? "No open tasks"
    : `${open.length} open task${open.length === 1 ? "" : "s"}` +
      (groups.overdue.length ? ` · ${groups.overdue.length} overdue` : "") +
      (groups.today.length ? ` · ${groups.today.length} due today` : "");
  const phase = input.researchPhase ? RESEARCH_LABEL[input.researchPhase] : undefined;
  return {
    vault: input.vaultName,
    save: input.vaultName ? saveLine(input.saveState) : "Open a vault to start",
    tasksSummary,
    tasks: open.slice(0, TRAY_TASK_LIMIT).map((t) => ({
      label: "○ " + t.text.replace(DUE_RE, "").trim(),
      rel: t.rel,
      line: t.line,
    })),
    research: phase ? `Deep Research: ${phase}` : null,
    sync: input.syncBusy
      ? "Sync: syncing…"
      : input.syncEnabled
        ? `Sync: on · ${input.syncPeers} device${input.syncPeers === 1 ? "" : "s"}`
        : "Sync: off",
  };
}
