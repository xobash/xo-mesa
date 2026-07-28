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

export default function mesaContext(pi: ContextPi): void {
  const port = process.env.MESA_ACTIVITY_PORT;
  const token = process.env.MESA_ACTIVITY_TOKEN;
  if (!port || !token) return;

  const endpoint = `http://127.0.0.1:${port}/context`;

  pi.on("before_agent_start", async (event) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 900);
    try {
      const response = await fetch(endpoint, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!response.ok) return undefined;
      const payload = (await response.json()) as MesaContextResponse;
      const context =
        typeof payload.context === "string" ? payload.context.trim() : "";
      if (!context) return undefined;
      return {
        systemPrompt:
          event.systemPrompt +
          "\n\n## Live Mesa workspace context\n" +
          "This is the current Mesa view and supersedes any older Mesa workspace context from session launch:\n" +
          context,
      };
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  });
}
