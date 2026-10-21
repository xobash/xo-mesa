import { describe, expect, it } from "vitest";
import {
  archiveRelPath,
  buildAgentContext,
  contextPrompt,
  resolveNavTarget,
  vaultFilePath,
  webSearchUrl,
} from "./agent";
import type { Settings } from "../types";

const settings: Settings = {
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

describe("Pi agent context", () => {
  it("uses only directly accessed vault-relative pathnames in the prompt", () => {
    const ctx = buildAgentContext({
      vaultName: "Frontier",
      vaultPath: "/vault",
      activePath: "Notes/Active.md",
      openTabs: ["Notes/Other.md"],
      settings,
    });
    const prompt = contextPrompt(ctx);
    expect(ctx.activeFilePath).toBe("/vault/Notes/Active.md");
    expect(ctx.openFilePaths).toEqual([
      "/vault/Notes/Active.md",
      "/vault/Notes/Other.md",
    ]);
    expect(prompt).toContain("Current document: Notes/Active.md");
    expect(prompt).not.toContain("/vault");
    expect(prompt).toContain("Other open documents: Notes/Other.md");
    expect(prompt).toContain("authoritative, path-only");
    expect(prompt).not.toContain("Research/secret.md");
    expect(prompt).not.toContain("secret contents");
  });

  it("does not disclose an absolute vault path in model-facing context", () => {
    const ctx = buildAgentContext({
      vaultName: "Research",
      vaultPath: "/private-vault",
      activePath: "Notes/Active.md",
      openTabs: [],
      settings,
    });
    expect(contextPrompt(ctx)).not.toContain("/private-vault");
  });

  it("keeps repeated context bounded while preserving the current document", () => {
    const ctx = buildAgentContext({
      vaultName: "Frontier",
      vaultPath: "/vault",
      activePath: "Notes/Active.md",
      openTabs: Array.from({ length: 40 }, (_, i) => `Notes/Open-${i}.md`),
      settings,
    });
    const prompt = contextPrompt(ctx);
    expect(prompt).toContain("Current document: Notes/Active.md");
    expect(prompt).toContain("Notes/Open-11.md");
    expect(prompt).not.toContain("Notes/Open-12.md");
    expect(ctx.openPaths).toHaveLength(13);
  });

  it("builds Windows-safe absolute paths from vault-relative active files", () => {
    expect(vaultFilePath("C:\\Vault", "Folder/Note.md")).toBe(
      "C:\\Vault\\Folder\\Note.md"
    );
  });
});

describe("Pi agent browser helpers", () => {
  it("builds a search URL", () => {
    expect(webSearchUrl("mesa notes")).toBe("https://duckduckgo.com/html/?q=mesa%20notes");
    expect(webSearchUrl("")).toBe("");
  });

  it("builds a stable archive path", () => {
    expect(
      archiveRelPath(
        "https://www.example.com/research/article.html",
        new Date("2026-06-25T12:34:56Z")
      )
    ).toBe("Web Archives/2026-06-25T12-34-56-example-com-article.html");
  });

  it("resolves address-bar input: URLs and bare domains direct, other text a search", () => {
    expect(resolveNavTarget("https://example.com/a?b=1")).toBe(
      "https://example.com/a?b=1"
    );
    expect(resolveNavTarget("  HTTP://EXAMPLE.COM  ")).toBe("HTTP://EXAMPLE.COM");
    expect(resolveNavTarget("mesa notes")).toBe(
      "https://duckduckgo.com/html/?q=mesa%20notes"
    );
    expect(resolveNavTarget("example.com")).toBe("https://example.com");
    expect(resolveNavTarget("en.wikipedia.org/wiki/Mesa")).toBe("https://en.wikipedia.org/wiki/Mesa");
    expect(resolveNavTarget("   ")).toBe("");
  });
});
