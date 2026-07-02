import { describe, it, expect } from "vitest";
import {
  localISO,
  applyTemplate,
  monthMatrix,
  weekMatrix,
  parseEvents,
  serializeEvents,
  holidaysForYear,
} from "./daily";

describe("localISO", () => {
  it("formats a local date as YYYY-MM-DD", () => {
    expect(localISO(new Date(2026, 5, 23))).toBe("2026-06-23"); // month is 0-based
    expect(localISO(new Date(2026, 0, 1))).toBe("2026-01-01");
  });
});

describe("applyTemplate", () => {
  it("substitutes date/time/title (case-insensitive, spaced)", () => {
    const out = applyTemplate("# {{title}}\n{{ DATE }} at {{time}}", {
      date: "2026-06-23",
      time: "09:30",
      title: "Hello",
    });
    expect(out).toBe("# Hello\n2026-06-23 at 09:30");
  });
});

describe("monthMatrix", () => {
  it("returns 6 weeks of 7 Monday-first days covering the month", () => {
    const m = monthMatrix(2026, 5); // June 2026; June 1 2026 is a Monday
    expect(m).toHaveLength(6);
    expect(m.every((w) => w.length === 7)).toBe(true);
    expect(m[0][0]).toBe("2026-06-01"); // Monday in the first cell
    expect(m.flat()).toContain("2026-06-30");
  });
});

describe("weekMatrix", () => {
  it("returns the Monday-first week containing the date", () => {
    const w = weekMatrix("2026-06-24"); // Wed
    expect(w).toHaveLength(7);
    expect(w[0]).toBe("2026-06-22"); // Monday
    expect(w[6]).toBe("2026-06-28"); // Sunday
    expect(w).toContain("2026-06-24");
  });
  it("crosses month boundaries", () => {
    const w = weekMatrix("2026-07-01"); // Wed; week starts Jun 29
    expect(w[0]).toBe("2026-06-29");
    expect(w[6]).toBe("2026-07-05");
  });
  it("supports a Sunday-first week", () => {
    const w = weekMatrix("2026-06-24", 0); // Wed; Sunday-first week starts Jun 21
    expect(w[0]).toBe("2026-06-21");
    expect(w[6]).toBe("2026-06-27");
  });
});

describe("monthMatrix Sunday-first", () => {
  it("starts the grid on Sunday when weekStartsOn=0", () => {
    const m = monthMatrix(2026, 5, 0); // June 2026; Jun 1 is Mon → grid starts May 31 (Sun)
    expect(m[0][0]).toBe("2026-05-31");
    expect(m.flat()).toContain("2026-06-30");
  });
});

describe("calendar events", () => {
  it("parses valid events and drops malformed entries", () => {
    const json = JSON.stringify([
      { date: "2026-07-01", title: "Launch" },
      { date: "bad", title: "nope" },
      { date: "2026-07-02", title: "  " },
      { nope: true },
      { date: "2026-07-03", title: "Review" },
    ]);
    expect(parseEvents(json)).toEqual([
      { date: "2026-07-01", title: "Launch" },
      { date: "2026-07-03", title: "Review" },
    ]);
    expect(parseEvents("not json")).toEqual([]);
    expect(parseEvents("{}")).toEqual([]);
  });

  it("serializes date-sorted and round-trips", () => {
    const evs = [
      { date: "2026-07-03", title: "B" },
      { date: "2026-07-01", title: "A" },
    ];
    const json = serializeEvents(evs);
    expect(parseEvents(json)).toEqual([
      { date: "2026-07-01", title: "A" },
      { date: "2026-07-03", title: "B" },
    ]);
  });
});

describe("holidaysForYear", () => {
  it("includes fixed and correctly-computed floating holidays", () => {
    const h = holidaysForYear(2026);
    expect(h["2026-12-25"]).toBe("Christmas Day");
    expect(h["2026-01-01"]).toBe("New Year's Day");
    expect(h["2026-11-26"]).toBe("Thanksgiving"); // 4th Thursday of Nov 2026
    expect(h["2026-05-25"]).toBe("Memorial Day"); // last Monday of May 2026
    expect(h["2026-01-19"]).toBe("Martin Luther King Jr. Day"); // 3rd Mon Jan
  });
});
