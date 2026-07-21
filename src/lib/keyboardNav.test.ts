import { describe, expect, it } from "vitest";
import type { NoteMeta, Settings, VaultFile } from "../types";
import {
  adjacentPath,
  clampKeyboardFocus,
  edgePath,
  keyboardFileOrder,
  moveKeyboardFocus,
} from "./keyboardNav";

const baseSettings: Settings = {
  hoverDelayMs: 450,
  hardwareAccel: true,
  animations: true,
  enableTabs: false,
  syncPort: 8787,
  syncEnabled: true,
  syncDiscovery: true,
  syncToken: "",
  syncDeviceName: "Test Device",
  syncAutoMinutes: 0,
  peers: [],
  sortMode: "name",
  sortDir: "asc",
  foldersFirst: true,
  typeFilter: "all",
  dailyFolder: "Daily",
  templatesFolder: "Templates",
  tasksFile: "Tasks.md",
  researchFolder: "Research",
  researchDepth: "standard",
  sidebarOpen: true,
  sidebarWidth: 240,
  rightWidth: 380,
  tagsCollapsed: false,
  bookmarks: [],
  bookmarksCollapsed: false,
  sidebarAutoHide: false,
  graphShowTags: false,
  graphExistingFilesOnly: true,
  graphShowOrphans: true,
  graphShowAttachments: false,
  centerView: "doc",
  rightStack: ["preview"],
  dockSide: "right",
  agentProvider: "manual",
  agentModel: "gpt-4.1-mini",
  agentEndpoint: "",
  agentApiKey: "",
};

const files: VaultFile[] = [
  { path: "/vault/B.md", relPath: "B.md", name: "B", ext: "md", isMarkdown: true },
  { path: "/vault/A.md", relPath: "A.md", name: "A", ext: "md", isMarkdown: true },
  { path: "/vault/C.pdf", relPath: "C.pdf", name: "C", ext: "pdf", isMarkdown: false },
];

const notes: Record<string, NoteMeta> = {
  "A.md": { relPath: "A.md", title: "A", rawLinks: [], tags: [], aliases: [] },
  "B.md": { relPath: "B.md", title: "B", rawLinks: [], tags: [], aliases: [] },
};

describe("keyboard navigation", () => {
  it("uses the sidebar sort and type filter for j/k note traversal", () => {
    const ordered = keyboardFileOrder(files, notes, {
      ...baseSettings,
      sortMode: "name",
      typeFilter: "md",
    });
    expect(ordered.map((f) => f.relPath)).toEqual(["A.md", "B.md"]);
  });

  it("finds adjacent and edge paths without wrapping unexpectedly", () => {
    const ordered = keyboardFileOrder(files, notes, baseSettings);
    expect(adjacentPath(ordered, "A.md", 1)).toBe("B.md");
    expect(adjacentPath(ordered, "A.md", -1)).toBe("A.md");
    expect(edgePath(ordered, "last")).toBe("C.pdf");
  });

  it("moves focus with h/l across sidebar, center, and right panes", () => {
    expect(moveKeyboardFocus({ region: "center", rightIndex: 0 }, "h", 2, true)).toEqual({
      region: "sidebar",
      rightIndex: 0,
    });
    expect(moveKeyboardFocus({ region: "center", rightIndex: 0 }, "l", 2, true)).toEqual({
      region: "right",
      rightIndex: 0,
    });
  });

  it("moves and clamps focus inside the right stack with j/k", () => {
    expect(moveKeyboardFocus({ region: "right", rightIndex: 0 }, "j", 3, true)).toEqual({
      region: "right",
      rightIndex: 1,
    });
    expect(clampKeyboardFocus({ region: "right", rightIndex: 9 }, 2)).toEqual({
      region: "right",
      rightIndex: 1,
    });
    expect(clampKeyboardFocus({ region: "right", rightIndex: 0 }, 0)).toEqual({
      region: "center",
      rightIndex: 0,
    });
  });
});
