import { expect, it } from "vitest";
import type { TextSaveIssue } from "../store";
import { createSaveIssueHelpers } from "./saveIssues";

function harness() {
  let state = { textSaveIssues: {} as Record<string, TextSaveIssue>, status: "" };
  let sets = 0;
  const helpers = createSaveIssueHelpers({
    get: () => state,
    set: (update) => { sets++; state = { ...state, ...(typeof update === "function" ? update(state) : update) }; },
  });
  return { helpers, state: () => state, sets: () => sets };
}

it("reports failures and cancellations with the action label", async () => {
  const h = harness();
  await h.helpers.reportingFailure("Rename", async () => { throw new Error("locked"); });
  expect(h.state().status).toBe("Rename failed: Error: locked");
  await h.helpers.reportingFailure("Import", async () => { throw new DOMException("stop", "AbortError"); });
  expect(h.state().status).toBe("Import cancelled.");
  await h.helpers.reportingFailure("Save", async () => {});
  expect(h.state().status).toBe("Import cancelled.");
});

it("records, marks busy and clears save issues without needless updates", () => {
  const h = harness();
  h.helpers.recordTextSaveIssue("/v/a.md", "a.md", "disk changed");
  expect(h.state().textSaveIssues["/v/a.md"]).toEqual({ key: "/v/a.md", relPath: "a.md", message: "disk changed", busy: null });
  h.helpers.setTextSaveIssueBusy("/v/a.md", "retry");
  expect(h.state().textSaveIssues["/v/a.md"].busy).toBe("retry");
  const before = h.state().textSaveIssues;
  h.helpers.setTextSaveIssueBusy("/v/a.md", "retry");
  h.helpers.setTextSaveIssueBusy("/v/missing.md", "disk");
  expect(h.state().textSaveIssues).toBe(before);
  expect(h.helpers.clearTextSaveIssues(["/v/missing.md"])).toBe(false);
  const setsBeforeClear = h.sets();
  expect(h.helpers.clearTextSaveIssues(["/v/a.md", "/v/missing.md"])).toBe(true);
  expect(h.sets()).toBe(setsBeforeClear + 1);
  expect(h.state().textSaveIssues).toEqual({});
});
