import { describe, expect, it } from "vitest";
import type { NoteMeta, Settings, VaultFile } from "../types";
import {
  adjacentPath,
  clampKeyboardFocus,
  edgePath,
  keyboardFileOrder,
  moveKeyboardFocus,
} from "./keyboardNav";
import { fileComparator } from "./sort";

const baseSettings: Settings = {
  hoverDelayMs: 450,
  hardwareAccel: true,
  animations: true, browserTextOnly: false,
  enableTabs: false,
  syncBindAddress: "127.0.0.1", syncPort: 8787,
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
  hideGeneratedFiles: false,
  dailyFolder: "Daily",
  templatesFolder: "Templates",
  tasksFile: "Tasks.md",
  researchFolder: "Research",
  researchDepth: "standard",
  researchContextScope: "workspace",
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

  it("memoizes the order on input identity and matches a fresh sort for every mode", () => {
    const many: VaultFile[] = Array.from({ length: 60 }, (_, i) => ({
      path: `/vault/n${(i * 37) % 60}.${i % 3 ? "md" : "pdf"}`, relPath: `n${(i * 37) % 60}.${i % 3 ? "md" : "pdf"}`,
      name: `n${(i * 37) % 60}`, ext: i % 3 ? "md" : "pdf", isMarkdown: i % 3 !== 0,
      size: (i * 7) % 5, mtime: (i * 11) % 4,
    }));
    const linked: Record<string, NoteMeta> = Object.fromEntries(many.map((f, i) =>
      [f.relPath, { relPath: f.relPath, title: f.name, rawLinks: Array(i % 4).fill("x"), tags: [], aliases: [] }]));
    for (const sortMode of ["name", "modified", "size", "links", "type"] as const) {
      for (const sortDir of ["asc", "desc"] as const) {
        for (const typeFilter of ["all", "md"]) {
          const settings = { ...baseSettings, sortMode, sortDir, typeFilter };
          const ordered = keyboardFileOrder(many, linked, settings);
          const sign = sortDir === "desc" ? -1 : 1;
          const compare = fileComparator(sortMode, linked);
          const fresh = many.filter((f) => typeFilter === "all" || f.ext === typeFilter)
            .sort((a, b) => sign * compare(a, b));
          expect(ordered).toEqual(fresh);
          expect(keyboardFileOrder(many, linked, { ...settings })).toBe(ordered);
          expect(keyboardFileOrder([...many], linked, settings)).not.toBe(ordered);
        }
      }
    }
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
