import { describe, expect, it } from "vitest";
import {
  activityOpForTool,
  archiveRelPath,
  buildAgentContext,
  contextPrompt,
  isPiBlockedBinaryPath,
  piActivityLaunch,
  piBinaryWriteBlock,
  piDeepResearchLaunch,
  piStartupArgs,
  PI_BLOCKED_BINARY_EXTENSIONS,
  resolveNavTarget,
  vaultFilePath,
  webSearchUrl,
  type ActivityInfo,
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

  it("resolves address-bar input: URLs direct, everything else a search", () => {
    expect(resolveNavTarget("https://example.com/a?b=1")).toBe(
      "https://example.com/a?b=1"
    );
    expect(resolveNavTarget("  HTTP://EXAMPLE.COM  ")).toBe("HTTP://EXAMPLE.COM");
    expect(resolveNavTarget("mesa notes")).toBe(
      "https://duckduckgo.com/html/?q=mesa%20notes"
    );
    expect(resolveNavTarget("   ")).toBe("");
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
      contextExtensionPath: "/tmp/mesa-pi/mesa-context.ts",
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
      "/tmp/mesa-pi/mesa-context.ts",
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

describe("piDeepResearchLaunch", () => {
  const info: ActivityInfo = {
    port: 8788,
    token: "abc123",
    extensionPath: "/tmp/mesa-pi/mesa-activity.ts",
    deepResearchExtensionPath: "/tmp/mesa-pi/mesa-deep-research.ts",
  };

  it("adds the deep-research extension + active-run env", () => {
    const launch = piDeepResearchLaunch(info, "dr-test-1");
    expect(launch.args).toEqual(["--extension", "/tmp/mesa-pi/mesa-deep-research.ts"]);
    expect(launch.env).toEqual({
      MESA_DEEP_RESEARCH: "1",
      MESA_DEEP_RESEARCH_RUN_ID: "dr-test-1",
    });
  });

  it("stays inert without the extension path", () => {
    expect(piDeepResearchLaunch(null, "x")).toEqual({ env: {}, args: [] });
    expect(piDeepResearchLaunch({ port: 8788, token: "t", extensionPath: "/a.ts" }, "x")).toEqual({
      env: {},
      args: [],
    });
  });
});

describe("piBinaryWriteBlock", () => {
  // The regression this exists for: Pi's text-oriented `write`/`edit` tools
  // reaching a PDF and destroying it. Mesa used to only snapshot around this;
  // it now prevents it outright, so these cases are the guarantee itself.
  it("blocks every content-write tool on a PDF", () => {
    for (const tool of ["write", "edit", "apply_patch"]) {
      const blocked = piBinaryWriteBlock(tool, "/vault/report.pdf");
      expect(blocked?.block, tool).toBe(true);
      expect(blocked?.reason, tool).toContain("binary file");
    }
  });

  it("names the offending path and the routes that do work", () => {
    const blocked = piBinaryWriteBlock("write", "/vault/Papers/thesis.pdf");
    expect(blocked?.reason).toContain("/vault/Papers/thesis.pdf");
    // The reason string is the model's only feedback — without these it just
    // retries the same corrupting write with different content.
    expect(blocked?.reason).toContain("Do not retry");
    expect(blocked?.reason).toContain("bash");
  });

  it("blocks regardless of case or path separator", () => {
    expect(piBinaryWriteBlock("WRITE", "C:\\vault\\Report.PDF")?.block).toBe(true);
    expect(piBinaryWriteBlock(" Edit ", "/vault/scan.PdF")?.block).toBe(true);
  });

  it("leaves text files alone", () => {
    for (const path of ["/vault/note.md", "/vault/data.json", "/vault/a.txt",
                        "/vault/page.svg", "/vault/doc.rtf", "/vault/rows.csv"]) {
      expect(piBinaryWriteBlock("write", path), path).toBeNull();
    }
  });

  it("never blocks reads, or bash — an agent may still drive real binary tools", () => {
    expect(piBinaryWriteBlock("read", "/vault/report.pdf")).toBeNull();
    expect(piBinaryWriteBlock("bash", "/vault/report.pdf")).toBeNull();
    expect(piBinaryWriteBlock("grep", "/vault/report.pdf")).toBeNull();
  });

  it("ignores calls with no usable path", () => {
    expect(piBinaryWriteBlock("write", undefined)).toBeNull();
    expect(piBinaryWriteBlock("write", "")).toBeNull();
    expect(piBinaryWriteBlock("write", 42)).toBeNull();
  });

  it("treats a dotfile with no extension as text, not as its own extension", () => {
    expect(isPiBlockedBinaryPath("/vault/.pdf")).toBe(false);
    expect(isPiBlockedBinaryPath("/vault/README")).toBe(false);
    expect(isPiBlockedBinaryPath("/vault/trailing.")).toBe(false);
  });

  it("covers the formats most likely to be in a vault", () => {
    for (const ext of ["pdf", "docx", "xlsx", "png", "jpg", "zip", "mp4", "sqlite"]) {
      expect(PI_BLOCKED_BINARY_EXTENSIONS, ext).toContain(ext);
    }
  });
});
