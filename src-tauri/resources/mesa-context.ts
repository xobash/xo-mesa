// Mesa live-workspace context — a Pi extension loaded by Mesa's embedded
// terminal.
//
// Pi's --append-system-prompt and process environment are fixed when the PTY
// starts, but Mesa's active note/layout can change throughout one conversation.
// This extension asks Mesa's authenticated loopback bridge for the current
// path-only workspace context before every agent turn and appends it to that
// turn's system prompt. The newest block is explicitly authoritative over the
// launch-time fallback, so switching notes never requires restarting Pi.
//
// Safety:
//   - Inert unless Mesa supplied its loopback port and bearer token.
//   - Talks only to 127.0.0.1 and has a short timeout.
//   - Never sends note contents; Mesa publishes only the same direct path/layout
//     context shown in the Pi context strip.
//   - A bridge failure leaves the launch-time fallback intact and never blocks
//     the user's prompt.

interface BeforeAgentStartEvent {
  systemPrompt: string;
}

interface ContextPi {
  on(
    event: "before_agent_start",
    handler: (
      event: BeforeAgentStartEvent
    ) => Promise<{ systemPrompt: string } | undefined>
  ): void;
}

interface MesaContextResponse {
  context?: unknown;
}

const MAX_CONTEXT_CHARS = 8 * 1024;

function usableContext(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_CONTEXT_CHARS) : "";
}

export default function mesaContext(pi: ContextPi): void {
  const port = process.env.MESA_ACTIVITY_PORT;
  const token = process.env.MESA_ACTIVITY_TOKEN;
  if (!port || !token) return;

  const endpoint = `http://127.0.0.1:${port}/context`;
  const launchContext = usableContext(process.env.MESA_CONTEXT);
  let liveContextRead = false;

  pi.on("before_agent_start", async (event) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 900);
    let context = "";
    try {
      const response = await fetch(endpoint, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (response.ok) {
        const payload = (await response.json()) as MesaContextResponse;
        context = usableContext(payload.context);
        liveContextRead = true;
      }
    } catch {
      // The launch prompt is the fail-safe for a temporarily unavailable
      // bridge. It contains the exact document that was open when Pi started.
    } finally {
      clearTimeout(timer);
    }
    let heading = "## Current Mesa document";
    let explanation =
      "This path is authoritative for the document currently open in Mesa. " +
      "It supersedes older Mesa workspace context:";
    if (!context && !liveContextRead && launchContext) {
      context = launchContext;
      heading = "## Current Mesa document (startup snapshot)";
      explanation =
        "This path was authoritative when Pi started. Mesa has not returned a newer live context yet:";
    }
    if (!context) {
      heading = "## Current Mesa document unavailable";
      explanation =
        "Mesa could not return the current document path. Do not infer the current document from project instructions or older context.";
      context = "";
    }
    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n${heading}\n${explanation}` +
        (context ? `\n${context}` : ""),
    };
  });
}
