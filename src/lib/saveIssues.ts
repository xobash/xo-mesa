import type { TextSaveIssue } from "../store";

interface SaveIssueState {
  textSaveIssues: Record<string, TextSaveIssue>;
  status: string;
}

interface SaveIssueDeps {
  get: () => SaveIssueState;
  set: (update: Partial<SaveIssueState> | ((state: SaveIssueState) => Partial<SaveIssueState>)) => void;
}

/** Shared save-failure state helpers, isolated from vault and workspace state. */
export function createSaveIssueHelpers({ get, set }: SaveIssueDeps) {
  return {
    reportingFailure: async (label: string, run: () => Promise<void>): Promise<void> => {
      try { await run(); } catch (error) { set({ status: `${label} failed: ${String(error)}` }); }
    },
    recordTextSaveIssue: (key: string, relPath: string, message: string): void => {
      set((state) => ({ textSaveIssues: { ...state.textSaveIssues, [key]: { key, relPath, message, busy: null } } }));
    },
    clearTextSaveIssues: (keys: Iterable<string>): boolean => {
      const remove = new Set(keys);
      if (![...remove].some((key) => get().textSaveIssues[key])) return false;
      set((state) => { const next = { ...state.textSaveIssues }; for (const key of remove) delete next[key]; return { textSaveIssues: next }; });
      return true;
    },
    setTextSaveIssueBusy: (key: string, busy: TextSaveIssue["busy"]): void => {
      set((state) => { const issue = state.textSaveIssues[key]; return issue && issue.busy !== busy ? { textSaveIssues: { ...state.textSaveIssues, [key]: { ...issue, busy } } } : {}; });
    },
  };
}
