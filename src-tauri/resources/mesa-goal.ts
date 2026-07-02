// Mesa /goal command — a Pi extension bundled with Mesa's embedded terminal.
//
// Gives the embedded Pi agent a persistent session goal. `/goal <text>` pins an
// objective that survives the whole session: it is re-appended to the system
// prompt on every agent turn (so the model never loses it to context drift) and
// shown as a widget above the editor so the user always sees what Pi is
// steering toward. `/goal` alone shows the current goal, `/goal clear` removes
// it.
//
// The goal is persisted as a custom session entry (`mesa-goal`), so resuming or
// branching a session restores the goal that was active at that point in
// history — the same pattern Pi's own docs recommend for extension state.
//
// Safety / boundary notes:
//   - Dependency-free: no imports, no npm packages. Pi loads this file directly
//     via `--extension` (jiti compiles the TypeScript in-process), so this adds
//     nothing to any node_modules and has no supply-chain surface.
//   - No network, no filesystem, no child processes. The goal text only ever
//     travels inside Pi's own session state and system prompt.
//   - Works identically outside Mesa; it just isn't loaded there unless the
//     user opts in with `--extension`.

interface GoalUi {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  setWidget(key: string, lines: string[] | undefined): void;
}

interface GoalCtx {
  hasUI: boolean;
  ui: GoalUi;
  sessionManager: { getEntries(): GoalEntry[] };
}

interface GoalEntry {
  type?: string;
  customType?: string;
  data?: { goal?: unknown };
}

interface BeforeAgentStartEvent {
  systemPrompt: string;
}

interface GoalPi {
  registerCommand(
    name: string,
    command: {
      description: string;
      handler: (args: string, ctx: GoalCtx) => void | Promise<void>;
    }
  ): void;
  on(event: string, handler: (event: never, ctx: GoalCtx) => void): void;
  appendEntry(customType: string, data?: Record<string, unknown>): void;
}

const ENTRY_TYPE = "mesa-goal";
const WIDGET_KEY = "mesa-goal";

export default function mesaGoal(pi: GoalPi): void {
  let goal: string | null = null;

  const syncWidget = (ctx: GoalCtx): void => {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.setWidget(WIDGET_KEY, goal ? [` ◎ Goal: ${goal}`] : undefined);
    } catch {
      /* widget rendering must never break the agent */
    }
  };

  /** Rebuild the active goal from session history (last entry wins), so
   * resume/branch restores whatever goal was set at that point. */
  const reconstruct = (ctx: GoalCtx): void => {
    goal = null;
    try {
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry?.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
        const g = entry.data?.goal;
        goal = typeof g === "string" && g.trim() ? g.trim() : null;
      }
    } catch {
      goal = null;
    }
    syncWidget(ctx);
  };

  pi.on("session_start", (_event, ctx) => reconstruct(ctx));
  pi.on("session_tree", (_event, ctx) => reconstruct(ctx));

  // Re-assert the goal on every turn so it cannot fade out of the context
  // window mid-session. Chained: we extend, never replace, the system prompt.
  pi.on("before_agent_start", ((event: BeforeAgentStartEvent) => {
    if (!goal) return undefined;
    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n## Active goal\nThe user pinned this session goal with /goal. Keep every action aligned with it until the user changes or clears it:\n${goal}`,
    };
  }) as unknown as (event: never, ctx: GoalCtx) => void);

  pi.registerCommand("goal", {
    description: "Pin a session goal (Pi keeps it in mind every turn) · /goal clear removes it",
    handler: (args, ctx) => {
      const text = args.trim();
      if (!text) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            goal ? `Current goal: ${goal}` : "No goal set. Use /goal <text> to pin one.",
            "info"
          );
        }
        return;
      }
      if (/^(clear|done|none|off)$/i.test(text)) {
        goal = null;
        pi.appendEntry(ENTRY_TYPE, { goal: null });
        syncWidget(ctx);
        if (ctx.hasUI) ctx.ui.notify("Goal cleared.", "info");
        return;
      }
      goal = text;
      pi.appendEntry(ENTRY_TYPE, { goal: text });
      syncWidget(ctx);
      if (ctx.hasUI) ctx.ui.notify(`Goal set: ${text}`, "info");
    },
  });
}
