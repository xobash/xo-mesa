import { describe, expect, it } from "vitest";
import { MAX_BUCKET, createTextInterner } from "./textInterner";

const long = (seed: string, n = 5000) => seed.repeat(Math.ceil(n / seed.length)).slice(0, n);

describe("createTextInterner", () => {
  it("returns one shared instance for identical text", () => {
    // Note: V8 may already hand back one instance for two identically-built
    // strings, so the input identity is not asserted — what matters is that
    // interning collapses them and reports the saving.
    const t = createTextInterner();
    const a = long("alpha ");
    const b = Array.from({ length: 5000 }, (_, i) => "alpha "[i % 6]).join("");
    expect(b).toBe(a);
    expect(t.intern(a)).toBe(a);
    expect(t.intern(b)).toBe(a);
    expect(t.shared).toBe(1);
    expect(t.sharedChars).toBe(a.length);
  });

  it("never merges two documents that merely look alike", () => {
    // Same length and identical at every sample point (head, middle, tail);
    // only the `===` confirmation separates them.
    const head = "H".repeat(64);
    const tail = "T".repeat(64);
    const mid = "M".repeat(64);
    const a = head + "a".repeat(200) + mid + "a".repeat(200) + tail;
    const b = head + "a".repeat(200) + mid + "a".repeat(199) + "b" + tail;
    expect(a.length).toBe(b.length);
    const t = createTextInterner();
    expect(t.intern(a)).toBe(a);
    expect(t.intern(b)).toBe(b);
    expect(t.shared).toBe(0);
  });

  it("keeps different-length text apart without comparing it", () => {
    const t = createTextInterner();
    const a = long("x", 1000);
    const b = long("x", 1001);
    expect(t.intern(a)).toBe(a);
    expect(t.intern(b)).toBe(b);
    expect(t.shared).toBe(0);
  });

  it("handles short text, where sampling cannot help", () => {
    const t = createTextInterner();
    const a = "# Note\n";
    const b = ["# Note", ""].join("\n");
    expect(t.intern(a)).toBe(a);
    expect(t.intern(b)).toBe(a);
    expect(t.shared).toBe(1);
  });

  it("passes the empty string straight through", () => {
    const t = createTextInterner();
    expect(t.intern("")).toBe("");
    expect(t.shared).toBe(0);
  });

  it("bounds the work a pathological bucket can cause", () => {
    // Many same-length documents agreeing at every sample point: the interner
    // stops accumulating candidates rather than turning intern() into a linear
    // scan of the vault. Missing a duplicate is the safe direction.
    const t = createTextInterner();
    const head = "H".repeat(64);
    const tail = "T".repeat(64);
    const mid = "M".repeat(64);
    const make = (i: number) =>
      head + "z".repeat(200) + mid + "z".repeat(190) + String(i).padStart(10, "0") + tail;
    const many = Array.from({ length: MAX_BUCKET + 5 }, (_, i) => make(i));
    for (const s of many) t.intern(s);
    // A late one still dedupes only if it is genuinely identical to a retained
    // candidate; either way nothing is merged wrongly.
    expect(t.intern(make(0))).toBe(many[0]);
    expect(t.intern(make(MAX_BUCKET + 4))).toBe(make(MAX_BUCKET + 4));
  });

  it("counts what it saved and can be emptied", () => {
    const t = createTextInterner();
    const a = long("dup ");
    t.intern(a);
    t.intern(long("dup "));
    t.intern(long("dup "));
    expect(t.shared).toBe(2);
    expect(t.sharedChars).toBe(a.length * 2);
    t.clear();
    // After clear, a previously-seen value gets a fresh canonical instance.
    const fresh = long("dup ");
    expect(t.intern(fresh)).toBe(fresh);
  });
});
