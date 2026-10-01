// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { initialRecents, initialTheme, RECENTS_KEY, THEME_KEY } from "./persistedUi";

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
});
