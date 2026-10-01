import { describe, it, expect } from "vitest";
import {
  bumpActivity,
  bumpActivityAmount,
  getActivity,
  decayActivity,
  activeRecords,
  ACTIVITY_MAX_RECORDS,
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

  it("bounds transient activity text and record retention", () => {
    const long = "x".repeat(2000);
    bumpActivityAmount("bounded-text", 1, "write", long, long);
    const bounded = getActivity("bounded-text")!;
    expect(bounded.status?.length).toBeLessThanOrEqual(512);
    expect(bounded.detail?.length).toBeLessThanOrEqual(512);

    for (let i = 0; i < ACTIVITY_MAX_RECORDS + 20; i++) {
      bumpActivityAmount(`bounded-${i}`, 0.1, "read");
    }
    expect(activeRecords(0).length).toBeLessThanOrEqual(ACTIVITY_MAX_RECORDS);
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

  /**
   * The production scan compares 2 KiB blocks first and narrows per char.
   * This is the ORIGINAL per-character implementation, kept verbatim as the
   * reference: the block scan must be indistinguishable from it on every
   * input, including edits inside repeated regions (where the non-overlap
   * clamp decides the answer), multi-byte characters, and block-boundary
   * edits.
   */
  function referenceChangedSnippet(prev: string, next: string, cap = 160): string {
    if (next === prev) return "";
    const a = prev ?? "";
    const b = next ?? "";
    let start = 0;
    const max = Math.min(a.length, b.length);
    while (start < max && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endB > start && endA > start && a[endA - 1] === b[endB - 1]) {
      endA--;
      endB--;
    }
    const slice = b.slice(start, endB).trim();
    return slice.length > cap ? slice.slice(0, cap).trim() : slice;
  }

  it("matches the per-character reference on randomized edit shapes", () => {
    // Deterministic LCG so a failure is reproducible from the seed.
    let seed = 0x2f6e2b1;
    const rnd = (n: number) => {
      seed = (seed * 48271) % 0x7fffffff;
      return seed % n;
    };
    const alphabet = "ab \n\ré世x";
    const randomText = (len: number) => {
      let s = "";
      for (let i = 0; i < len; i++) s += alphabet[rnd(alphabet.length)];
      return s;
    };
    for (let i = 0; i < 4000; i++) {
      // Lengths around the block boundary too, so both loop shapes run.
      const len = i % 5 === 0 ? 2040 + rnd(20) : rnd(300);
      const base = randomText(len);
      let edited: string;
      switch (rnd(5)) {
        case 0: // append
          edited = base + randomText(1 + rnd(3));
          break;
        case 1: {
          // insert
          const p = rnd(base.length + 1);
          edited = base.slice(0, p) + randomText(1 + rnd(3)) + base.slice(p);
          break;
        }
        case 2: {
          // delete
          const p = rnd(Math.max(1, base.length));
          edited = base.slice(0, p) + base.slice(p + 1 + rnd(3));
          break;
        }
        case 3: {
          // replace
          const p = rnd(Math.max(1, base.length));
          edited = base.slice(0, p) + randomText(1 + rnd(3)) + base.slice(p + 1);
          break;
        }
        default: // unrelated text
          edited = randomText(rnd(300));
      }
      expect(changedSnippet(base, edited)).toBe(referenceChangedSnippet(base, edited));
      expect(changedSnippet(edited, base)).toBe(referenceChangedSnippet(edited, base));
    }
    // Repeated-region edits: the answer is decided by the suffix clamp.
    const rep = "abab".repeat(1200);
    expect(changedSnippet(rep, "ab" + rep)).toBe(referenceChangedSnippet(rep, "ab" + rep));
    expect(changedSnippet(rep, rep + "ab")).toBe(referenceChangedSnippet(rep, rep + "ab"));
    expect(changedSnippet("", rep)).toBe(referenceChangedSnippet("", rep));
    expect(changedSnippet(rep, "")).toBe(referenceChangedSnippet(rep, ""));
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

  function referenceChangedLineStats(
    prev: string,
    next: string
  ): { added: number; removed: number } {
    if (prev === next) return { added: 0, removed: 0 };
    const a = prev.length ? prev.split(/\r?\n/) : [];
    const b = next.length ? next.split(/\r?\n/) : [];
    let start = 0;
    const max = Math.min(a.length, b.length);
    while (start < max && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
      endA--;
      endB--;
    }
    return {
      added: Math.max(0, endB - start),
      removed: Math.max(0, endA - start),
    };
  }

  it("matches the per-line reference on randomized edit shapes", () => {
    let seed = 0x3a1b9c7;
    const rnd = (n: number) => {
      seed = (seed * 48271) % 0x7fffffff;
      return seed % n;
    };
    const alphabet = "ab \n\ré世x";
    const randomText = (len: number) => {
      let s = "";
      for (let i = 0; i < len; i++) s += alphabet[rnd(alphabet.length)];
      return s;
    };
    for (let i = 0; i < 4000; i++) {
      const len = i % 5 === 0 ? 2040 + rnd(20) : rnd(300);
      const base = randomText(len);
      let edited: string;
      switch (rnd(5)) {
        case 0:
          edited = base + randomText(1 + rnd(3));
          break;
        case 1: {
          const p = rnd(base.length + 1);
          edited = base.slice(0, p) + randomText(1 + rnd(3)) + base.slice(p);
          break;
        }
        case 2: {
          const p = rnd(Math.max(1, base.length));
          edited = base.slice(0, p) + base.slice(p + 1 + rnd(3));
          break;
        }
        case 3: {
          const p = rnd(Math.max(1, base.length));
          edited = base.slice(0, p) + randomText(1 + rnd(3)) + base.slice(p + 1);
          break;
        }
        default:
          edited = randomText(rnd(300));
      }
      expect(changedLineStats(base, edited)).toEqual(
        referenceChangedLineStats(base, edited)
      );
      expect(changedLineStats(edited, base)).toEqual(
        referenceChangedLineStats(edited, base)
      );
    }
    const rep = "ab\nab\n".repeat(600);
    expect(changedLineStats(rep, "ab\n" + rep)).toEqual(
      referenceChangedLineStats(rep, "ab\n" + rep)
    );
    expect(changedLineStats(rep, rep + "ab\n")).toEqual(
      referenceChangedLineStats(rep, rep + "ab\n")
    );
    expect(changedLineStats("", rep)).toEqual(referenceChangedLineStats("", rep));
    expect(changedLineStats(rep, "")).toEqual(referenceChangedLineStats(rep, ""));
  });
});
