import { describe, expect, it, vi } from "vitest";
import { transpileModule, ScriptTarget, ModuleKind } from "typescript";
import deepResearchExt from "../../src-tauri/resources/mesa-deep-research.ts?raw";
import { piDeepResearchLaunch } from "./agent";

describe("bundled Deep Research extension behavior", () => {
  type Result = {
    content: Array<{ text: string }>;
    isError?: boolean;
    details?: Record<string, unknown>;
  };

  function extension(runId = "run-1") {
    const launch = piDeepResearchLaunch(
      {
        port: 8788,
        token: "test-token",
        extensionPath: "/fixture/mesa-activity.ts",
        deepResearchExtensionPath: "/fixture/mesa-deep-research.ts",
      },
      runId,
    );
    const registered = new Map<
      string,
      {
        execute: (
          id: string,
          params: Record<string, unknown>,
          signal?: AbortSignal,
        ) => Promise<Result>;
      }
    >();
    const hooks = new Map<string, (event: unknown) => unknown>();
    const fetch = vi.fn(async (_url: string, _options: RequestInit) => new Response("ok"));
    const js = transpileModule(
      deepResearchExt
        .replace('import { Type } from "typebox";', "")
        .replace("export default function", "function"),
      { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ESNext } },
    ).outputText;
    const register = new Function(
      "process",
      "fetch",
      "Type",
      `${js}; return mesaDeepResearch;`,
    )(
      {
        env: {
          MESA_ACTIVITY_PORT: "8788",
          MESA_ACTIVITY_TOKEN: "test-token",
          ...launch.env,
        },
      },
      fetch,
      new Proxy({}, { get: () => () => ({}) }),
    );
    register({
      registerTool: (tool: { name: string; execute: never }) =>
        registered.set(tool.name, tool),
      on: (name: string, handler: (event: unknown) => unknown) => hooks.set(name, handler),
    });
    return {
      launch,
      fetch,
      hooks,
      call: (name: string, params: Record<string, unknown>) =>
        registered.get(name)!.execute("call-1", params),
    };
  }

  it.each(["", " ", "\t\n"])(
    "leaves ordinary Pi tools and agent turns alone for run ID %j",
    async (runId) => {
      const ext = extension(runId);
      expect(ext.launch).toEqual({ env: {}, args: [] });
      for (const toolName of ["write", "edit", "apply_patch", "read", "bash"]) {
        expect(ext.hooks.get("tool_call")!({ toolName })).toBeUndefined();
      }
      await ext.hooks.get("agent_start")!({});
      await ext.hooks.get("agent_end")!({ messages: [] });
      expect(ext.fetch).not.toHaveBeenCalled();
    },
  );

  it("activates the write gate and reports the exact active run ID", async () => {
    const ext = extension("run-active-2");
    expect(ext.launch.args).toEqual(["--extension", "/fixture/mesa-deep-research.ts"]);
    for (const toolName of ["write", "edit", "apply_patch"]) {
      expect(ext.hooks.get("tool_call")!({ toolName })).toMatchObject({ block: true });
    }
    expect(ext.hooks.get("tool_call")!({ toolName: "read" })).toBeUndefined();
    await ext.hooks.get("agent_start")!({});
    expect(JSON.parse(String(ext.fetch.mock.calls[0][1].body))).toMatchObject({
      kind: "agent-start",
      runId: "run-active-2",
    });
  });

  it("releases the write gate only after an accepted finish", async () => {
    const ext = extension();
    ext.fetch.mockResolvedValueOnce(
      Response.json({ status: "rejected", message: "Copy each exact question as a heading." }),
    );
    const rejected = await ext.call("deep_research_finish", { result: {} });
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0].text).toContain("exact question");
    expect(ext.hooks.get("tool_call")!({ toolName: "write" })).toMatchObject({ block: true });

    ext.fetch.mockResolvedValueOnce(
      Response.json({ status: "accepted", message: "Ready for review." }),
    );
    const accepted = await ext.call("deep_research_finish", { result: {} });
    expect(accepted.details?.accepted).toBe(true);
    expect(ext.hooks.get("tool_call")!({ toolName: "write" })).toBeUndefined();
  });

  it.each(["ok", '{"status":"pending"}', "HTTP failure"])(
    "keeps writes blocked for ambiguous finish response %s",
    async (body) => {
      const ext = extension();
      ext.fetch.mockResolvedValueOnce(
        new Response(body, { status: body === "HTTP failure" ? 504 : 200 }),
      );
      const result = await ext.call("deep_research_finish", { result: {} });
      expect(result.isError).toBe(true);
      expect(ext.hooks.get("tool_call")!({ toolName: "edit" })).toMatchObject({ block: true });
    },
  );

  it("reports idle and restart boundaries without completing the run", async () => {
    const ext = extension();
    const progress = await ext.call("deep_research_progress", { phase: "synthesizing" });
    expect(progress.content[0].text).toContain("not complete");
    await ext.hooks.get("agent_end")!({
      messages: [
        { role: "assistant", stopReason: "error", errorMessage: "Provider unavailable" },
      ],
    });
    expect(JSON.parse(String(ext.fetch.mock.calls[1][1].body))).toMatchObject({
      kind: "agent-end",
      reason: "Pi ended its turn with an error: Provider unavailable",
    });
    await ext.hooks.get("agent_start")!({});
    expect(ext.hooks.get("tool_call")!({ toolName: "write" })).toMatchObject({ block: true });
    expect(ext.hooks.get("tool_call")!({ toolName: "bash" })).toBeUndefined();
  });
});
