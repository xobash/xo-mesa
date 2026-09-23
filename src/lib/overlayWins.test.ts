import { describe, expect, it } from "vitest";
import { fitWin, keyboardWinPatch, mergeStoredWins, type OverlayWinRec } from "./overlayWins";

const rec = (over: Partial<OverlayWinRec> = {}): OverlayWinRec => ({
  open: false,
  x: 90,
  y: 76,
  w: 760,
  h: 640,
  ...over,
});

const DESKTOP = { width: 1600, height: 1000 };

describe("fitWin", () => {
  it("leaves an in-viewport window untouched", () => {
    expect(fitWin(rec(), DESKTOP)).toEqual(rec());
  });

  it("clamps size and position into a small viewport", () => {
    const fitted = fitWin(rec(), { width: 600, height: 500 });
    expect(fitted.w).toBe(600 - 24);
    expect(fitted.h).toBe(500 - 56 - 96);
    expect(fitted.x + fitted.w).toBeLessThanOrEqual(600 - 12);
    expect(fitted.y).toBeGreaterThanOrEqual(56);
  });

  it("degrades to minimum size at a zero viewport without mutating its input", () => {
    const input = rec();
    const fitted = fitWin(input, { width: 0, height: 0 });
    expect(fitted.w).toBe(280);
    expect(fitted.h).toBe(220);
    expect(input).toEqual(rec()); // pure — caller's stored state is untouched
  });
});

describe("mergeStoredWins", () => {
  const defaults = { calendar: rec({ open: true }), tasks: rec({ x: 180, w: 860 }) };

  it("returns stored geometry verbatim — no viewport involved", () => {
    const merged = mergeStoredWins(defaults, {
      calendar: { open: false, x: 40, y: 60, w: 500, h: 400 },
    });
    expect(merged.calendar).toEqual({ open: false, x: 40, y: 60, w: 500, h: 400 });
    expect(merged.tasks).toEqual(defaults.tasks);
    expect(merged.tasks).not.toBe(defaults.tasks); // fresh copies, not aliases
  });

  it("survives a small-viewport session: stored size stays remembered", () => {
    // A squashed session renders windows fitted, but what is persisted is the
    // raw geometry — merging it back later must return the original size.
    const stored = { calendar: { open: true, x: 90, y: 76, w: 760, h: 640 } };
    const merged = mergeStoredWins(defaults, stored);
    expect(merged.calendar.w).toBe(760);
    expect(merged.calendar.h).toBe(640);
  });

  it("falls back to defaults for corrupt storage", () => {
    const merged = mergeStoredWins(defaults, {
      calendar: { open: "yes", x: Number.NaN, y: Infinity, w: "wide" },
      tasks: null,
    });
    expect(merged.calendar).toEqual(defaults.calendar);
    expect(merged.tasks).toEqual(defaults.tasks);
    expect(mergeStoredWins(defaults, "junk")).toEqual(defaults);
  });
});

describe("keyboardWinPatch", () => {
  it("moves with arrows and resizes with Shift+Arrow semantics", () => {
    expect(keyboardWinPatch(rec(), "ArrowRight", false, DESKTOP)).toEqual({ x: 106 });
    expect(keyboardWinPatch(rec(), "ArrowUp", false, DESKTOP)).toEqual({ y: 60 });
    expect(keyboardWinPatch(rec(), "ArrowRight", true, DESKTOP)).toEqual({ w: 776 });
    expect(keyboardWinPatch(rec(), "ArrowUp", true, DESKTOP)).toEqual({ h: 624 });
  });

  it("keeps keyboard movement and resizing inside the visible overlay area", () => {
    const edge = rec({ x: 12, y: 56, w: 560, h: 340 });
    expect(keyboardWinPatch(edge, "ArrowLeft", false, { width: 600, height: 500 })).toEqual({ x: 12 });
    expect(keyboardWinPatch(edge, "ArrowUp", false, { width: 600, height: 500 })).toEqual({ y: 56 });
    expect(keyboardWinPatch(edge, "ArrowRight", true, { width: 600, height: 500 })).toEqual({ w: 576 });
    expect(keyboardWinPatch(edge, "Enter", false, DESKTOP)).toBeNull();
  });
});
