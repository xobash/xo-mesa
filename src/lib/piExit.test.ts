import { describe, expect, it } from "vitest";
import { piExitMessage, retireExitedPiSession, type PiSessionFields } from "./piExit";

const live = (): PiSessionFields => ({ sessionId: "s1", vaultPath: "/v", contextText: "c", lastOutputSeq: 9 });

describe("Pi exit handling", () => {
  it("clears the shared session so the next start spawns a new one", () => {
    const session = live();
    expect(retireExitedPiSession(session, { sessionId: "s1", code: 3 })).toBe(true);
    expect(session).toEqual({ sessionId: null, vaultPath: null, contextText: null, lastOutputSeq: 0 });
  });

  it("ignores exits for another or already-cleared session", () => {
    const session = live();
    expect(retireExitedPiSession(session, { sessionId: "other", code: 0 })).toBe(false);
    expect(session.sessionId).toBe("s1");
    expect(retireExitedPiSession({ ...live(), sessionId: null }, { sessionId: "s1", code: 0 })).toBe(false);
  });

  it("describes the exit", () => {
    expect(piExitMessage(0)).toBe("Pi exited (code 0)");
    expect(piExitMessage(null)).toBe("Pi exited");
  });
});
