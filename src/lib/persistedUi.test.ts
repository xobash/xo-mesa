// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { initialRecents, initialTheme, migrateLegacyKeys, RECENTS_KEY, THEME_KEY } from "./persistedUi";

describe("persisted UI state", () => {
  beforeEach(() => localStorage.clear());

  it("canonicalizes and deduplicates recent vault roots", () => {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(["C:\\Vault\\", "C:/Vault", 3, "D:/Other"]));
    expect(initialRecents()).toEqual(["C:/Vault", "D:/Other"]);
  });

  it("preserves current keys during legacy migration", () => {
    localStorage.setItem(THEME_KEY, "void");
    localStorage.setItem("telperion:theme", "darkroom");
    migrateLegacyKeys();
    expect(initialTheme()).toBe("void");
    expect(localStorage.getItem(THEME_KEY)).toBe("void");
  });
});
