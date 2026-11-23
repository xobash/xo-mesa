import { expect, it } from "vitest";
import { isWorkspaceWindow } from "./windowRole";

it("treats only the main window as owning the pane layout", () => {
  expect(isWorkspaceWindow("")).toBe(true);
  expect(isWorkspaceWindow("?vault=%2Fv")).toBe(true);
  for (const route of ["?panel=graph", "?doc=a.md", "?agent=1", "?research=1"]) expect(isWorkspaceWindow(route)).toBe(false);
});
