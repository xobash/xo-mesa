import { describe, expect, it } from "vitest";
import { shouldAcceptTerminalOutput } from "./terminalOutput";

describe("terminal output guards", () => {
  it("accepts output for the active session and listener generation", () => {
    expect(
      shouldAcceptTerminalOutput({
        eventSessionId: "term-a",
        activeSessionId: "term-a",
        eventGeneration: 3,
        activeGeneration: 3,
      })
    ).toBe(true);
  });

  it("rejects output from a stopped session even if an old listener fires", () => {
    expect(
      shouldAcceptTerminalOutput({
        eventSessionId: "term-a",
        activeSessionId: "term-b",
        eventGeneration: 3,
        activeGeneration: 3,
      })
    ).toBe(false);
  });

  it("rejects output from a stale listener generation", () => {
    expect(
      shouldAcceptTerminalOutput({
        eventSessionId: "term-a",
        activeSessionId: "term-a",
        eventGeneration: 2,
        activeGeneration: 3,
      })
    ).toBe(false);
  });

  it("rejects output when no session is active", () => {
    expect(
      shouldAcceptTerminalOutput({
        eventSessionId: "term-a",
        activeSessionId: null,
        eventGeneration: 1,
        activeGeneration: 1,
      })
    ).toBe(false);
  });
});
