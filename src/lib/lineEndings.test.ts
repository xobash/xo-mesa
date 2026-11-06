import { describe, expect, it } from "vitest";
import {
  dominantLineBreak,
  joinWithLineBreaks,
  lineBreaksOf,
  lineEndingStyle,
  restoreLineBreakRun,
  restoreLineBreaks,
  trackLineBreaks,
  updateLineBreaks,
  withLineBreak,
} from "./lineEndings";

describe("line endings", () => {
  it("finds the dominant break, first-seen on a tie, LF when there is none", () => {
    expect(dominantLineBreak(lineBreaksOf("a\r\nb\nc\r\n"))).toBe("\r\n");
    expect(dominantLineBreak(lineBreaksOf("a\nb\r\n"))).toBe("\n");
    expect(dominantLineBreak(lineBreaksOf("a\rb\r\nc\r"))).toBe("\r");
    expect(dominantLineBreak([])).toBe("\n");
  });

  it("names the style of a text", () => {
    expect(lineEndingStyle("a")).toBe("none");
    expect(lineEndingStyle("a\nb\n")).toBe("LF");
    expect(lineEndingStyle("a\r\nb\r\n")).toBe("CRLF");
    expect(lineEndingStyle("a\rb")).toBe("CR");
    expect(lineEndingStyle("a\r\nb\n")).toBe("mixed");
  });

  it("splices tracked breaks for edits and counts the odd ones", () => {
    const tracked = trackLineBreaks("a\r\nb\nc\r\nd");
    expect(tracked).toMatchObject({ dominant: "\r\n", odd: 1 });
    // Replace lines 2..3 (removes the LF after b and the CRLF after c) with text holding one break.
    const next = updateLineBreaks(tracked, [{ fromLine: 2, toLine: 3, insertedBreaks: 1 }]);
    expect(next.breaks).toEqual(["\r\n", "\r\n", "\r\n"]);
    expect(next.odd).toBe(0);
    expect(joinWithLineBreaks(["a", "b", "x", "d"], next)).toBe("a\r\nb\r\nx\r\nd");
  });

  it("returns the same tracking object for an edit inside one line", () => {
    const tracked = trackLineBreaks("a\r\nb\n");
    expect(updateLineBreaks(tracked, [{ fromLine: 1, toLine: 1, insertedBreaks: 0 }])).toBe(tracked);
  });

  it("applies several edits in one transaction against old line numbers", () => {
    const tracked = trackLineBreaks("1\n2\r\n3\n4\r\n5");
    const next = updateLineBreaks(tracked, [
      { fromLine: 1, toLine: 2, insertedBreaks: 0 },
      { fromLine: 4, toLine: 4, insertedBreaks: 2 },
    ]);
    expect(next.breaks).toEqual(["\r\n", "\n", "\n", "\n", "\r\n"]);
  });

  it("restores breaks a textarea normalized, keeping untouched lines exact", () => {
    const before = "a\r\nb\nc\r\nd";
    expect(restoreLineBreaks(before, "a\nb\nc\nd")).toBe(before);
    expect(restoreLineBreaks(before, "a\nB\nc\nd")).toBe("a\r\nB\nc\r\nd");
    expect(restoreLineBreaks(before, "a\nb\nnew\nc\nd")).toBe("a\r\nb\nnew\r\nc\r\nd");
    expect(restoreLineBreaks(before, "a\nd")).toBe("a\r\nd");
    expect(restoreLineBreaks("x\r\n", "x\n")).toBe("x\r\n");
    expect(restoreLineBreaks("x\r\n", "")).toBe("");
  });

  it("leaves LF text and already-faithful values alone", () => {
    expect(restoreLineBreaks("a\nb", "a\nc")).toBe("a\nc");
    expect(restoreLineBreaks("a\r\nb", "a\r\nc")).toBe("a\r\nc");
  });

  it("rewrites every break to one style", () => {
    expect(withLineBreak("a\nb\r\nc\rd", "\r\n")).toBe("a\r\nb\r\nc\r\nd");
  });
});

describe("restoring a run of breaks", () => {
  it("puts back the exact breaks an undo reinserts and fixes the odd count", () => {
    const tracked = trackLineBreaks("a\r\nx\r\ny\r\nd");
    const restored = restoreLineBreakRun(tracked, 2, ["\n", "\r"]);
    expect(restored.breaks).toEqual(["\r\n", "\n", "\r"]);
    expect(restored.odd).toBe(2);
  });

  it("ignores a run that does not fit", () => {
    const tracked = trackLineBreaks("a\r\nb");
    expect(restoreLineBreakRun(tracked, 1, ["\n", "\n"])).toBe(tracked);
    expect(restoreLineBreakRun(tracked, 0, ["\n"])).toBe(tracked);
  });
});
