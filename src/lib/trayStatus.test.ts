import { describe, expect, it } from "vitest";
import { buildTraySnapshot, TRAY_TASK_LIMIT, type TrayInput } from "./trayStatus";
import type { TaskItem } from "./tasks";

const task = (text: string, due: string | null, checked = false, line = 1): TaskItem =>
  ({ rel: "Notes.md", noteTitle: "Notes", line, text, checked, due, kind: "personal" });
const base: TrayInput = {
  vaultName: "Demo Vault", saveState: { pending: 0, saving: 0, failed: 0 }, tasks: [],
  today: "2026-10-13", researchPhase: null, syncEnabled: false, syncBusy: false, syncPeers: 0,
};

describe("tray snapshot", () => {
  it("summarizes an idle workspace", () => {
    expect(buildTraySnapshot(base)).toEqual({
      vault: "Demo Vault", save: "All changes saved", tasksSummary: "No open tasks",
      tasks: [], research: null, sync: "Sync: off",
    });
  });

  it("lists overdue work first, drops done tasks and stays bounded", () => {
    const tasks = [
      task("Later", null, false, 1),
      task("Done", null, true, 2),
      task("Late 📅 2026-10-01", "2026-10-01", false, 3),
      ...Array.from({ length: 10 }, (_, i) => task(`Extra ${i}`, null, false, 10 + i)),
    ];
    const snap = buildTraySnapshot({ ...base, tasks });
    expect(snap.tasksSummary).toBe("12 open tasks · 1 overdue");
    expect(snap.tasks).toHaveLength(TRAY_TASK_LIMIT);
    expect(snap.tasks[0]).toEqual({ label: "○ Late", rel: "Notes.md", line: 3 });
  });

  it("reports failed saves, active research and sync", () => {
    const snap = buildTraySnapshot({
      ...base, saveState: { pending: 1, saving: 0, failed: 1 }, researchPhase: "researching",
      syncEnabled: true, syncPeers: 2,
    });
    expect(snap.save).toBe("1 save needs attention");
    expect(snap.research).toBe("Deep Research: Researching");
    expect(snap.sync).toBe("Sync: on · 2 devices");
  });
});
