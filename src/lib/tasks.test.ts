import { describe, it, expect } from "vitest";
import {
  parseTasks,
  bucketTask,
  groupTasks,
  classifyTask,
  taskProject,
  updateTaskLine,
  type TaskItem,
} from "./tasks";

describe("parseTasks", () => {
  it("extracts checkboxes, done state, and due dates; ignores code fences", () => {
    const src = [
      "- [ ] plain todo",
      "- [x] finished",
      "* [ ] starred with 📅 2026-07-01",
      "- [ ] due: 2026-08-15 review",
      "```",
      "- [ ] not a task (in code)",
      "```",
      "regular text",
    ].join("\n");
    const tasks = parseTasks("n.md", "Note", src);
    expect(tasks).toHaveLength(4);
    expect(tasks[0]).toMatchObject({ checked: false, due: null, line: 0 });
    expect(tasks[1].checked).toBe(true);
    expect(tasks[2].due).toBe("2026-07-01");
    expect(tasks[3].due).toBe("2026-08-15");
  });

  it("classifies agent vs personal tasks by marker", () => {
    expect(classifyTask("write the report")).toBe("personal");
    expect(classifyTask("scrape leads #agent")).toBe("agent");
    expect(classifyTask("@agent summarize inbox")).toBe("agent");
    expect(classifyTask("🤖 generate images")).toBe("agent");
    const tasks = parseTasks("n.md", "Note", "- [ ] do thing #agent\n- [ ] mine");
    expect(tasks[0].kind).toBe("agent");
    expect(tasks[1].kind).toBe("personal");
  });
});

describe("taskProject", () => {
  it("returns the parent folder, or empty at the vault root", () => {
    expect(taskProject("Ideas/Project Mesa.md")).toBe("Ideas");
    expect(taskProject("a/b/c/note.md")).toBe("a/b/c");
    expect(taskProject("Tasks.md")).toBe("");
    expect(taskProject("Win\\Path\\note.md")).toBe("Win/Path");
  });
});

describe("bucketTask", () => {
  const t = (due: string | null, checked = false): TaskItem => ({
    rel: "n.md",
    noteTitle: "n",
    line: 0,
    text: "x",
    checked,
    due,
    kind: "personal",
  });
  const today = "2026-06-23";
  it("buckets by due date and done state", () => {
    expect(bucketTask(t(null, true), today)).toBe("done");
    expect(bucketTask(t(null), today)).toBe("noDue");
    expect(bucketTask(t("2026-06-01"), today)).toBe("overdue");
    expect(bucketTask(t("2026-06-23"), today)).toBe("today");
    expect(bucketTask(t("2026-07-01"), today)).toBe("upcoming");
  });
});

describe("groupTasks", () => {
  it("groups and sorts dated buckets by due date", () => {
    const mk = (due: string | null, checked = false): TaskItem => ({
      rel: "n.md",
      noteTitle: "n",
      line: 0,
      text: due ?? "none",
      checked,
      due,
      kind: "personal",
    });
    const g = groupTasks(
      [mk("2026-07-10"), mk("2026-07-01"), mk(null), mk("2026-01-01"), mk(null, true)],
      "2026-06-23"
    );
    expect(g.upcoming.map((t) => t.due)).toEqual(["2026-07-01", "2026-07-10"]);
    expect(g.overdue).toHaveLength(1);
    expect(g.noDue).toHaveLength(1);
    expect(g.done).toHaveLength(1);
  });
});

describe("updateTaskLine", () => {
  it("updates checked state and due date in the original markdown line", () => {
    const src = "- [ ] write report due: 2026-07-01\n- [x] old";
    expect(updateTaskLine(src, 0, { checked: true, due: "2026-07-10" })).toBe(
      "- [x] write report 📅 2026-07-10\n- [x] old"
    );
    expect(updateTaskLine(src, 0, { due: null })).toBe("- [ ] write report\n- [x] old");
  });

  it("leaves non-task lines unchanged", () => {
    expect(updateTaskLine("plain\n- [ ] ok", 0, { checked: true })).toBe(
      "plain\n- [ ] ok"
    );
  });
});
