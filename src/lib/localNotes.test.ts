import { describe, expect, it } from "vitest";
import {
  LOCAL_NOTE_MAX_BYTES,
  localNoteBytes,
  readLocalNote,
  writeLocalNote,
  type LocalNoteStore,
} from "./localNotes";

describe("browser scratch storage", () => {
  it("counts UTF-16 units and refuses an oversized entry without replacing old content", () => {
    expect(localNoteBytes("🙂")).toBe(4);
    const values = new Map<string, string>([["scratch", "keep me"]]);
    const store: LocalNoteStore = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
    };
    expect(writeLocalNote("scratch", "x".repeat(LOCAL_NOTE_MAX_BYTES / 2 + 1), store))
      .toMatchObject({ ok: false, reason: "too-large" });
    expect(readLocalNote("scratch", store)).toBe("keep me");
  });

  it("reports quota and unavailable storage separately", () => {
    const full: LocalNoteStore = {
      getItem: () => null,
      setItem: () => { throw Object.assign(new Error("full"), { name: "QuotaExceededError" }); },
    };
    expect(writeLocalNote("scratch", "new", full)).toMatchObject({ ok: false, reason: "quota" });
    expect(writeLocalNote("scratch", "new", null)).toMatchObject({ ok: false, reason: "unavailable" });
  });
});
