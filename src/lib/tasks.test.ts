import { describe, it, expect, beforeEach } from "vitest";
import {
  parseTasks,
  bucketTask,
  collectVaultTasks,
  groupTasks,
  classifyTask,
  resetVaultTaskMemo,
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

describe("collectVaultTasks", () => {
  const notes = {
    "Tasks.md": { title: "Tasks" },
    "work/plan.md": { title: "plan" },
    "empty.md": { title: "empty" },
  };
  const cache: Record<string, string> = {
    "Tasks.md": "- [ ] buy milk 📅 2026-08-01\n- [x] done thing",
    "work/plan.md": "notes\n- [ ] ship the thing #agent",
    "empty.md": "no tasks here",
  };

  /** The pre-memo implementation, kept verbatim as the parity reference. */
  function reference(
    n: Record<string, { title: string }>,
    c: Record<string, string>,
    personalRel: string
  ): TaskItem[] {
    const out: TaskItem[] = [];
    for (const rel of Object.keys(n)) {
      const src = c[rel];
      if (src == null) continue;
      const kind = rel === personalRel ? "personal" : "agent";
      for (const t of parseTasks(rel, n[rel].title, src)) out.push({ ...t, kind });
    }
    return out;
  }

  beforeEach(() => resetVaultTaskMemo());

  it("matches the un-memoised pass", () => {
    expect(collectVaultTasks(notes, cache, "Tasks.md")).toEqual(
      reference(notes, cache, "Tasks.md")
    );
  });

  it("tags the tasks note personal and everything else agent", () => {
    const all = collectVaultTasks(notes, cache, "Tasks.md");
    expect(all.filter((t) => t.kind === "personal").map((t) => t.text)).toEqual([
      "buy milk 📅 2026-08-01",
      "done thing",
    ]);
    expect(all.filter((t) => t.kind === "agent").map((t) => t.text)).toEqual([
      "ship the thing #agent",
    ]);
  });

  it("skips notes with no cached content", () => {
    const partial = { ...cache };
    delete partial["work/plan.md"];
    expect(collectVaultTasks(notes, partial, "Tasks.md").map((t) => t.rel)).toEqual([
      "Tasks.md",
      "Tasks.md",
    ]);
  });

  it("reuses unchanged notes and re-parses only the edited one", () => {
    const first = collectVaultTasks(notes, cache, "Tasks.md");
    const edited = { ...cache, "work/plan.md": "notes\n- [ ] ship it later" };
    const second = collectVaultTasks(notes, edited, "Tasks.md");

    // Untouched note keeps item identity; the edited note is re-parsed.
    expect(second[0]).toBe(first[0]);
    expect(second[2]).not.toBe(first[2]);
    expect(second[2].text).toBe("ship it later");
    expect(second).toEqual(reference(notes, edited, "Tasks.md"));
  });

  it("re-parses when the note title or personal/agent tag changes", () => {
    const first = collectVaultTasks(notes, cache, "Tasks.md");
    const retitled = { ...notes, "work/plan.md": { title: "renamed" } };
    expect(collectVaultTasks(retitled, cache, "Tasks.md")[2].noteTitle).toBe("renamed");

    // Pointing `tasksFile` at another note must re-tag both sides.
    const retagged = collectVaultTasks(notes, cache, "work/plan.md");
    expect(retagged).toEqual(reference(notes, cache, "work/plan.md"));
    expect(retagged[2].kind).toBe("personal");
    expect(retagged[2]).not.toBe(first[2]);
  });

  it("drops notes that left the vault so their content is not retained", () => {
    collectVaultTasks(notes, cache, "Tasks.md");
    const fewer = { "Tasks.md": { title: "Tasks" } };
    expect(collectVaultTasks(fewer, cache, "Tasks.md").map((t) => t.rel)).toEqual([
      "Tasks.md",
      "Tasks.md",
    ]);
    // A note that returns with different content must not serve a stale parse.
    const revived = { ...cache, "work/plan.md": "- [ ] brand new" };
    expect(collectVaultTasks(notes, revived, "Tasks.md")[2].text).toBe("brand new");
  });

  it("returns a fresh pass after the memo is reset", () => {
    const first = collectVaultTasks(notes, cache, "Tasks.md");
    resetVaultTaskMemo();
    const second = collectVaultTasks(notes, cache, "Tasks.md");
    expect(second).toEqual(first);
    expect(second[0]).not.toBe(first[0]);
  });
});
