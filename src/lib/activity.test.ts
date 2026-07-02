import { describe, it, expect } from "vitest";
import {
  bumpActivity,
  bumpActivityAmount,
  getActivity,
  decayActivity,
  activeRecords,
  changedSnippet,
  changedLineStats,
} from "./activity";
import { faceFor, statusLine } from "./faces";

describe("activity tracker", () => {
  it("raises intensity on a keystroke", () => {
    bumpActivity("note-a");
    const rec = getActivity("note-a");
    expect(rec).toBeDefined();
    expect(rec!.intensity).toBeGreaterThan(0);
  });

  it("treats each edit as a discrete blip, not an accumulator", () => {
    // A burst of edits must not pile into a long-tail glow. Each bump takes
    // the max of the (decayed) residual and the incoming amount, so rapid
    // typing stays crisp and ends the moment you stop.
    for (let i = 0; i < 50; i++) bumpActivityAmount("note-b", 0.6);
    expect(getActivity("note-b")!.intensity).toBeLessThanOrEqual(1);
  });

  it("decays toward zero over time", () => {
    bumpActivityAmount("note-c", 1);
    const before = getActivity("note-c")!.intensity;
    decayActivity(performance.now() + 5000); // jump well into the future
    const after = getActivity("note-c");
    expect(after === undefined || after.intensity < before).toBe(true);
  });

  it("returns undefined for unknown ids", () => {
    expect(getActivity("never-touched")).toBeUndefined();
  });

  it("records the operation and status", () => {
    bumpActivityAmount("note-op", 1, "create", "spawning…", "", {
      added: 3,
      removed: 1,
    });
    const rec = getActivity("note-op");
    expect(rec!.op).toBe("create");
    expect(rec!.status).toBe("spawning…");
    expect(rec!.added).toBe(3);
    expect(rec!.removed).toBe(1);
  });

  it("lists active records strongest first", () => {
    bumpActivityAmount("weak", 0.2, "read");
    bumpActivityAmount("strong", 2, "write");
    const ids = activeRecords(0.05).map((r) => r.id);
    expect(ids).toContain("weak");
    expect(ids).toContain("strong");
    expect(ids.indexOf("strong")).toBeLessThan(ids.indexOf("weak"));
  });
});

describe("faces", () => {
  it("gives a stable face per op+seed", () => {
    expect(faceFor("read", "a")).toBe(faceFor("read", "a"));
    expect(typeof faceFor("write", "x")).toBe("string");
  });
  it("builds a quirky status line, honoring a custom phrase", () => {
    expect(statusLine("read", "s")).toMatch(/…$/);
    expect(statusLine("edit", "s", "computing…")).toContain("computing…");
  });
});

describe("changedSnippet", () => {
  it("returns the inserted chunk between common prefix/suffix", () => {
    expect(changedSnippet("hello world", "hello brave world")).toBe("brave");
  });
  it("returns the appended text", () => {
    expect(changedSnippet("abc", "abcDEF")).toBe("DEF");
  });
  it("is empty when nothing changed", () => {
    expect(changedSnippet("same", "same")).toBe("");
  });
  it("caps long changes", () => {
    expect(changedSnippet("", "x".repeat(500)).length).toBeLessThanOrEqual(160);
  });
});

describe("changedLineStats", () => {
  it("counts the changed line span after common prefix and suffix", () => {
    expect(changedLineStats("a\nb\nc", "a\nx\ny\nc")).toEqual({
      added: 2,
      removed: 1,
    });
  });

  it("is zero when text is unchanged", () => {
    expect(changedLineStats("same", "same")).toEqual({ added: 0, removed: 0 });
  });
});
