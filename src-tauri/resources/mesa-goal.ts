// Persist a session goal and append it to each turn’s system prompt; /goal clear removes it.
// The extension has no direct network or filesystem calls; Pi may send its prompt to a provider.

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
