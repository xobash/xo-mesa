// Mesa Deep Research bridge — a Pi extension bundled with Mesa's embedded
// terminal. Loaded alongside mesa-activity / mesa-browser only when the user
// starts a Deep Research run.
//
// What it does:
//   - Registers three tools the model uses to report a Deep Research run back
//     to Mesa: `deep_research_progress` (phase/status updates),
//     `deep_research_finish` (the final structured result), and
//     `deep_research_blocked` (a structured stop with its reason). All POST to
//     Mesa's loopback activity server, which re-emits them to the frontend.
//   - While a run is active (MESA_DEEP_RESEARCH=1 is injected), it BLOCKS
//     Pi's direct content mutation tools: Deep Research is a read-only
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
  on(event: string, handler: (event: {
    toolName?: string;
    messages?: Array<{ role?: string; stopReason?: string; errorMessage?: string }>;
  }) => { block: boolean; reason?: string } | undefined | Promise<void>): void;
}

const PHASES = ["planning", "researching", "synthesizing"] as const;

function progressMessage(params: Record<string, unknown>): string {
  const explicit = typeof params.message === "string" ? params.message.trim() : "";
  if (explicit) return explicit.slice(0, 800);

  const kind = typeof params.kind === "string" ? params.kind : "";
  const subQuestion = typeof params.subQuestion === "string" ? params.subQuestion.trim() : "";
  const sourceTitle = typeof params.sourceTitle === "string" ? params.sourceTitle.trim() : "";
  const sourceUrl = typeof params.sourceUrl === "string" ? params.sourceUrl.trim() : "";
  const round = typeof params.round === "number" ? params.round : undefined;

  if (kind === "subquestion" && subQuestion) return `Researching: ${subQuestion}`.slice(0, 800);
  if (kind === "source" && (sourceTitle || sourceUrl)) return `Opening source: ${sourceTitle || sourceUrl}`.slice(0, 800);
  if (kind === "note" && (sourceTitle || sourceUrl)) return `Finished source: ${sourceTitle || sourceUrl}`.slice(0, 800);
  if (kind === "round" && round !== undefined) return `Starting research round ${round}`;
  if (kind) return `Deep Research ${kind} update`;
  return "Deep Research progress update";
}

export default function mesaDeepResearch(pi: ResearchPi): void {
  const port = process.env.MESA_ACTIVITY_PORT;
  const token = process.env.MESA_ACTIVITY_TOKEN;
  if (!port || !token) return; // not running inside Mesa — stay silent.

  let active = process.env.MESA_DEEP_RESEARCH === "1";
  const runId = process.env.MESA_DEEP_RESEARCH_RUN_ID ?? "";
  const endpoint = `http://127.0.0.1:${port}/deep-research`;
  const authHeaders = { Authorization: `Bearer ${token}` };

  async function post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(body.kind === "finish" ? 35_000 : 2_000);
    return fetch(endpoint, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  }

  // PTY existence is not model liveness. Report actual agent-loop boundaries;
  // Mesa may show an unfinished turn without interrupting provider retries.
  pi.on("agent_start", async () => {
    if (active) await post({ kind: "agent-start", runId }).catch(() => undefined);
  });
  pi.on("agent_end", async (event) => {
    if (!active) return;
    const last = [...(event.messages ?? [])].reverse().find((message) => message.role === "assistant");
    const reason = last?.errorMessage
      ? `Pi ended its turn with an error: ${last.errorMessage}`
      : `Pi ended its turn (${last?.stopReason ?? "no finish"}) without an accepted Deep Research report.`;
    await post({ kind: "agent-end", runId, reason: reason.slice(0, 4000) }).catch(() => undefined);
  });

  // --- Hard guarantee: no direct content mutation during a run. ------------
  // Register the block unconditionally; it only engages while `active` so a
  // normal (non-research) Pi session is unaffected. Shell remains available
  // for read-only inspection (for example `find`, `rg`, and `ls`). This hook
  // receives the tool name, not the shell command, so blocking the entire
  // shell tool would also block harmless vault reads and make Pi report a
  // false environment/permission failure.
  pi.on("tool_call", (event) => {
    if (!active) return undefined;
    const name = typeof event?.toolName === "string" ? event.toolName.toLowerCase() : "";
    if (["write", "edit", "apply_patch"].includes(name)) {
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
    name: "deep_research_blocked",
    label: "Deep Research: blocked",
    description:
      "Stop the Deep Research run safely when a tool validation error, unavailable source path, or other blocker prevents a trustworthy result. " +
      "Call this instead of writing a plain-text refusal. Explain the exact blocker and what Mesa should preserve in the trace.",
    parameters: Type.Object({
      reason: Type.String({ description: "Exact reason the research cannot continue safely" }),
    }),

    async execute(_toolCallId, params, signal) {
      const reason = String(params?.reason ?? "No safe completion path was available.").slice(0, 4000);
      try {
        const res = await post({ kind: "blocked", runId, reason }, signal);
        if (!res.ok) return { content: [{ type: "text", text: `blocked report failed (HTTP ${res.status})` }], isError: true };
        active = false;
        return { content: [{ type: "text", text: "Deep Research blocked. Mesa recorded the reason and stopped the run." }] };
      } catch (e) {
        return { content: [{ type: "text", text: `blocked report failed: ${String(e)}` }], isError: true };
      }
    },
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
      message: Type.Optional(Type.String({ description: "Short human-readable status; Mesa derives one when omitted" })),
      kind: Type.Optional(Type.String({ description: "plan | subquestion | source | note | synthesize | status" })),
      round: Type.Optional(Type.Number({ description: "One-based research round" })),
      subQuestion: Type.Optional(Type.String({ description: "The sub-question being researched" })),
      sourceUrl: Type.Optional(Type.String({ description: "Source URL being examined" })),
      sourceTitle: Type.Optional(Type.String({ description: "Source title being examined" })),
      draftMarkdown: Type.Optional(Type.String({ description: "Current assembled report snapshot during synthesis" })),
    }),

    async execute(_toolCallId, params, signal) {
      const phase = String(params?.phase ?? "researching");
      const message = progressMessage(params ?? {});
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
        return { content: [{ type: "text", text: "Progress recorded. The research run is not complete; continue to an accepted deep_research_finish or report deep_research_blocked." }], details: { phase, complete: false } };
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

    async execute(toolCallId, params, signal) {
      const result = params?.result;
      if (!result || typeof result !== "object") {
        return { content: [{ type: "text", text: "finish: a `result` object is required." }], isError: true };
      }
      try {
        const res = await post({ kind: "finish", runId, requestId: toolCallId, result }, signal);
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          return {
            content: [{ type: "text", text: `finish failed (HTTP ${res.status}): ${detail || "no detail"}` }],
            isError: true,
          };
        }
        // The HTTP response now carries Mesa's actual validation decision.
        // Keep the read-only gate active on rejection or ambiguous transport.
        const reply = await res.json() as { status?: string; message?: string };
        if (!["accepted", "rejected", "stopped"].includes(reply.status ?? "") || typeof reply.message !== "string") {
          throw new Error("Mesa returned no validation decision; the run is not confirmed complete.");
        }
        if (reply.status === "accepted" || reply.status === "stopped") active = false;
        return {
          content: [{ type: "text", text: reply.message }],
          details: { delivered: true, accepted: reply.status === "accepted", status: reply.status },
          isError: reply.status !== "accepted",
        };
      } catch (e) {
        return { content: [{ type: "text", text: `finish failed: ${String(e)}` }], isError: true };
      }
    },
  });
}
