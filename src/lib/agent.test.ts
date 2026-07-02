import { describe, expect, it } from "vitest";
import {
  activityOpForTool,
  archiveRelPath,
  buildAgentContext,
  contextPrompt,
  piActivityLaunch,
  piStartupArgs,
  vaultFilePath,
  webSearchUrl,
} from "./agent";
import type { Settings } from "../types";

const settings: Settings = {
  hoverDelayMs: 450,
  hardwareAccel: true,
  animations: true,
  enableTabs: false,
  syncPort: 8787,
  syncEnabled: true,
  syncDiscovery: true,
  syncToken: "",
  syncAutoMinutes: 0,
  peers: [],
  sortMode: "name",
  sortDir: "asc",
  foldersFirst: true,
  typeFilter: "all",
  dailyFolder: "Daily",
  templatesFolder: "Templates",
  tasksFile: "Tasks.md",
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

describe("Pi agent context", () => {
  it("uses only directly accessed pathnames and injects absolute active file paths", () => {
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
    expect(prompt).toContain("Vault path: /vault");
    expect(prompt).toContain("Active file: Notes/Active.md");
    expect(prompt).toContain("Active file path: /vault/Notes/Active.md");
    expect(prompt).toContain("- Notes/Active.md");
    expect(prompt).toContain("- Notes/Other.md");
    expect(prompt).not.toContain("Research/secret.md");
    expect(prompt).not.toContain("secret contents");
  });

  it("builds Windows-safe absolute paths from vault-relative active files", () => {
    expect(vaultFilePath("C:\\Vault", "Folder/Note.md")).toBe(
      "C:\\Vault\\Folder\\Note.md"
    );
  });

  it("passes Mesa context through Pi's supported startup system prompt hook", () => {
    expect(piStartupArgs("Vault path: /vault\nActive file path: /vault/a.md")).toEqual([
      "--append-system-prompt",
      "Vault path: /vault\nActive file path: /vault/a.md",
    ]);
    expect(piStartupArgs("  ")).toEqual([]);
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
});

describe("Pi activity reporting", () => {
  it("maps Pi tool names to graph activity ops", () => {
    expect(activityOpForTool("read", true)).toBe("read");
    expect(activityOpForTool("Read", false)).toBe("read");
    expect(activityOpForTool("edit", true)).toBe("edit");
    // write is create for a new file, write for an existing one
    expect(activityOpForTool("write", false)).toBe("create");
    expect(activityOpForTool("write", true)).toBe("write");
  });

  it("ignores tools that don't map to a single note node", () => {
    for (const tool of ["bash", "grep", "find", "ls", "deploy", ""]) {
      expect(activityOpForTool(tool, true)).toBeNull();
    }
  });

  it("injects env + extension args only when the activity server is available", () => {
    const info = {
      port: 8788,
      token: "abc123",
      extensionPath: "/tmp/mesa-pi/mesa-activity.ts",
      goalExtensionPath: "/tmp/mesa-pi/mesa-goal.ts",
      browserExtensionPath: "/tmp/mesa-pi/mesa-browser.ts",
    };
    const launch = piActivityLaunch(info);
    expect(launch.env).toEqual({
      MESA_ACTIVITY_PORT: "8788",
      MESA_ACTIVITY_TOKEN: "abc123",
    });
    expect(launch.args).toEqual([
      "--extension",
      "/tmp/mesa-pi/mesa-activity.ts",
      "--extension",
      "/tmp/mesa-pi/mesa-goal.ts",
      "--extension",
      "/tmp/mesa-pi/mesa-browser.ts",
    ]);
  });

  it("still loads the activity extension alone when the goal extension is missing", () => {
    const launch = piActivityLaunch({
      port: 8788,
      token: "abc123",
      extensionPath: "/tmp/mesa-pi/mesa-activity.ts",
    });
    expect(launch.args).toEqual(["--extension", "/tmp/mesa-pi/mesa-activity.ts"]);
  });

  it("stays inert when the activity server did not start", () => {
    expect(piActivityLaunch(null)).toEqual({ env: {}, args: [] });
    expect(piActivityLaunch(undefined)).toEqual({ env: {}, args: [] });
    expect(
      piActivityLaunch({ port: 0, token: "", extensionPath: "", goalExtensionPath: "" })
    ).toEqual({ env: {}, args: [] });
  });
});
