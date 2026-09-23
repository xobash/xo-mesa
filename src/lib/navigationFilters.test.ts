import { expect, it } from "vitest";
import { isGeneratedNavigationFile } from "./navigationFilters";
it("filters only generated archive and conflict locations, preserving authored notes", () => {
  expect(isGeneratedNavigationFile("Web Archives/source.html")).toBe(true);
  expect(isGeneratedNavigationFile("Notes/A (conflict from device 2026-09-14).md")).toBe(true);
  expect(isGeneratedNavigationFile("Notes/A (conflict from device 2026-09-14) (2).md")).toBe(true);
  for (const path of ["Research/report.md", "Scratchpad/day.md", "Whiteboard/Board.mesa-board.json", "Notes/Web Archives.md", "Notes/conflict.md"]) expect(isGeneratedNavigationFile(path)).toBe(false);
});
