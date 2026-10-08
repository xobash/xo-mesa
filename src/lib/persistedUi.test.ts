// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { initialRecents, initialTheme, isThemeId, RECENTS_KEY, THEME_KEY, THEME_IDS } from "./persistedUi";
import { THEMES } from "../store";

describe("persisted UI state", () => {
  beforeEach(() => localStorage.clear());

  it("canonicalizes and deduplicates recent vault roots", () => {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(["C:\\Vault\\", "C:/Vault", 3, "D:/Other"]));
    expect(initialRecents()).toEqual(["C:/Vault", "D:/Other"]);
  });

  it("loads the current theme key", () => {
    localStorage.setItem(THEME_KEY, "void");
    expect(initialTheme()).toBe("void");
    expect(localStorage.getItem(THEME_KEY)).toBe("void");
  });
  it.each(THEME_IDS)("round-trips the %s theme", (id) => {
    localStorage.setItem(THEME_KEY, id);
    expect(initialTheme()).toBe(id);
    expect(isThemeId(id)).toBe(true);
    expect(localStorage.getItem(THEME_KEY)).toBe(id);
  });

  it.each(["", "VOID", "solarized", "constructor"])("defaults invalid theme %s to system", (value) => {
    localStorage.setItem(THEME_KEY, value);
    expect(initialTheme()).toBe("system");
    expect(isThemeId(value)).toBe(false);
  });

  it("rejects non-string theme values", () => {
    expect(isThemeId(null)).toBe(false);
  });

  it("keeps picker IDs in the persistence order", () => {
    expect(THEMES.map((theme) => theme.id)).toEqual([...THEME_IDS]);
  });
});
