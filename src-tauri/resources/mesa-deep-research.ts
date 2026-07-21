// Mesa Deep Research bridge — a Pi extension bundled with Mesa's embedded
// terminal. Loaded alongside mesa-activity / mesa-browser only when the user
// starts a Deep Research run.
//
// What it does:
//   - Registers two tools the model uses to report a Deep Research run back
//     to Mesa: `deep_research_progress` (phase/status updates) and
//     `deep_research_finish` (the final structured result). Both POST to
//     Mesa's loopback activity server, which re-emits them to the frontend.
//   - While a run is active (MESA_DEEP_RESEARCH=1 is injected), it BLOCKS
//     Pi's mutation-capable write/edit/patch/shell tools: Deep Research is a read-only
//     proposal phase. Mesa owns every vault mutation and applies the reviewed
//     change set itself through verified atomic writes. This is the belt to
//     the prompt's suspenders — even if the model ignores the instruction,
//     it cannot mutate the vault during a run.
//
// Safety / boundary notes:
//   - No-op unless Mesa injected MESA_ACTIVITY_PORT + MESA_ACTIVITY_TOKEN, so
//     running `pi` outside Mesa (or without a run active) never gains these
//     tools and never blocks writes.
//   - Talks only to 127.0.0.1 (loopback). Nothing leaves the machine.
//   - The mutation-tool block is fail-safe: it only engages while
//     MESA_DEEP_RESEARCH=1 is set, and a blocked tool returns a clear reason
//     to the model instead of throwing.
//   - `typebox` resolves from Pi's own runtime (extensions load in-process
//     via jiti) — this adds nothing to Mesa's npm tree.

// @ts-ignore — typebox ships inside Pi's runtime (extensions are compiled
// in-process by jiti); it is intentionally NOT a dependency of Mesa's repo.
import { Type } from "typebox";

// Node's process global, typed locally so this file needs no @types/node.
declare const process: { env: Record<string, string | undefined> };

interface ToolTextResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}

interface ResearchPi {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal
    ): Promise<ToolTextResult>;
  }): void;
  on(event: string, handler: (event: { toolName?: string }) => { block: boolean; reason?: string } | undefined): void;
}

const PHASES = ["planning", "researching", "synthesizing"] as const;

export default function mesaDeepResearch(pi: ResearchPi): void {
  const port = process.env.MESA_ACTIVITY_PORT;
  const token = process.env.MESA_ACTIVITY_TOKEN;
  if (!port || !token) return; // not running inside Mesa — stay silent.

  let active = process.env.MESA_DEEP_RESEARCH === "1";
  const runId = process.env.MESA_DEEP_RESEARCH_RUN_ID ?? "";
  const endpoint = `http://127.0.0.1:${port}/deep-research`;
  const authHeaders = { Authorization: `Bearer ${token}` };

  async function post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    return fetch(endpoint, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  }

  // --- Hard guarantee: no direct vault mutation during a run. -------------
  // Register the block unconditionally; it only engages while `active` so a
  // normal (non-research) Pi session is unaffected.
  pi.on("tool_call", (event) => {
    if (!active) return undefined;
    const name = typeof event?.toolName === "string" ? event.toolName.toLowerCase() : "";
    if (["write", "edit", "apply_patch", "bash", "shell", "exec"].includes(name)) {
      return {
        block: true,
        reason:
          "Deep Research is read-only. Mesa applies your proposed changes itself after the user reviews them — " +
          "finish with deep_research_finish instead of writing files.",
      };
    }
    return undefined;
  });

  pi.registerTool({
    name: "deep_research_progress",
    label: "Deep Research: report progress",
    description:
      "Report Deep Research progress to Mesa. Call constantly so the user can watch the run: " +
      "once with kind=plan (sub-questions), kind=subquestion when starting one, kind=source when " +
      "opening a source, kind=note when finishing one, kind=synthesize when assembling. " +
      "phase is planning | researching | synthesizing.",
    parameters: Type.Object({
      phase: Type.String({ description: "planning | researching | synthesizing" }),
      message: Type.String({ description: "Short human-readable status" }),
      kind: Type.Optional(Type.String({ description: "plan | subquestion | source | note | synthesize | status" })),
      round: Type.Optional(Type.Number({ description: "One-based research round" })),
      subQuestion: Type.Optional(Type.String({ description: "The sub-question being researched" })),
      sourceUrl: Type.Optional(Type.String({ description: "Source URL being examined" })),
      sourceTitle: Type.Optional(Type.String({ description: "Source title being examined" })),
      draftMarkdown: Type.Optional(Type.String({ description: "Current assembled report snapshot during synthesis" })),
    }),

    async execute(_toolCallId, params, signal) {
      const phase = String(params?.phase ?? "researching");
      const message = String(params?.message ?? "").slice(0, 800);
      try {
        const res = await post(
          {
            kind: "progress",
            runId,
            phase: (PHASES as readonly string[]).includes(phase) ? phase : "researching",
            message,
            activityKind: params?.kind ? String(params.kind) : undefined,
            round: typeof params?.round === "number" ? params.round : undefined,
            subQuestion: params?.subQuestion ? String(params.subQuestion) : undefined,
            sourceUrl: params?.sourceUrl ? String(params.sourceUrl) : undefined,
            sourceTitle: params?.sourceTitle ? String(params.sourceTitle) : undefined,
            draftMarkdown: params?.draftMarkdown ? String(params.draftMarkdown).slice(0, 32768) : undefined,
          },
          signal
        );
        if (!res.ok) {
          return { content: [{ type: "text", text: `progress report failed (HTTP ${res.status})` }], isError: true };
        }
        return { content: [{ type: "text", text: "ok" }], details: { phase } };
      } catch (e) {
        return { content: [{ type: "text", text: `progress report failed: ${String(e)}` }], isError: true };
      }
    },
  });

  pi.registerTool({
    name: "deep_research_finish",
    label: "Deep Research: finish with structured result",
    description:
      "Finish the Deep Research run by handing Mesa the structured result. " +
      "Pass { result } where result has report {title, markdown}, notes[], sources[], claims[], related[]. " +
      "Mesa validates it, builds the note change set, and shows it to the user for review.",
    parameters: Type.Object({
      result: Type.Object({}, { additionalProperties: true }),
    }),

    async execute(_toolCallId, params, signal) {
      const result = params?.result;
      if (!result || typeof result !== "object") {
        return { content: [{ type: "text", text: "finish: a `result` object is required." }], isError: true };
      }
      try {
        const res = await post({ kind: "finish", runId, result }, signal);
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          return {
            content: [{ type: "text", text: `finish failed (HTTP ${res.status}): ${detail || "no detail"}` }],
            isError: true,
          };
        }
        // The proposal phase is over. Keep the shared Pi conversation alive,
        // but immediately restore its ordinary write/edit capability.
        active = false;
        return {
          content: [{ type: "text", text: "Research result delivered to Mesa for review." }],
          details: { delivered: true },
        };
      } catch (e) {
        return { content: [{ type: "text", text: `finish failed: ${String(e)}` }], isError: true };
      }
    },
  });
}
