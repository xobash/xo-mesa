import { describe, expect, it } from "vitest";
import settingsSource from "../components/SettingsModal.tsx?raw";
import storeSource from "../store.ts?raw";

describe("recovery restore ownership", () => {
  it("routes recovery restore through the store so pending saves flush first", () => {
    expect(settingsSource).not.toContain("restoreRecoveryEntry,");
    expect(settingsSource).toContain("const restoreRecoveryEntry = useAppStore");
    const actionStart = storeSource.indexOf("    restoreRecoveryEntry: async (entry)");
    const actionEnd = storeSource.indexOf("    newNote: async", actionStart);
    const action = storeSource.slice(actionStart, actionEnd);
    expect(action).toContain("await textSaves.flushAll()");
    expect(action).toContain("await restoreRecoveryEntry(root, entry)");
    expect(action).toContain("await get().openVault(root)");
  });
});
