// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialRecents, initialTheme, RECENTS_KEY, THEME_KEY, LAST_VAULT_KEY, loadRecentVaults, THEME_IDS, isThemeId, UI_STYLE_IDS, UI_STYLE_KEY, initialUiStyle } from "./persistedUi";

import { THEMES, UI_STYLES } from "../store";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
describe("persisted UI state", () => {
  beforeEach(() => { localStorage.clear(); native.invoke.mockReset(); });

  it("does not hydrate legacy paths into renderer state", () => {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(["C:\\Vault\\", "C:/Vault", 3, "D:/Other"]));
    expect(initialRecents()).toEqual([]);
  });

  it("loads the current theme key", () => {
    localStorage.setItem(THEME_KEY, "void");
    expect(initialTheme()).toBe("void");
    expect(localStorage.getItem(THEME_KEY)).toBe("void");
  });
});

it("migrates approved roots once and removes persistent renderer paths", async () => {
  localStorage.setItem(RECENTS_KEY, JSON.stringify(["/synthetic/vault"]));
  localStorage.setItem(LAST_VAULT_KEY, "/synthetic/vault");
  native.invoke.mockResolvedValue({ entries: [{ id: "opaque", label: "vault" }], last: "opaque" });
  expect(await loadRecentVaults()).toEqual({ entries: [{ id: "opaque", label: "vault" }], last: "opaque" });
  expect(native.invoke).toHaveBeenCalledWith("vault_recents", { action: "remember", root: "/synthetic/vault" });
  expect(localStorage.getItem(RECENTS_KEY)).toBeNull(); expect(localStorage.getItem(LAST_VAULT_KEY)).toBeNull();
});
it("does not discard legacy recents when native storage fails", async () => {
  localStorage.setItem(RECENTS_KEY, JSON.stringify(["/synthetic/vault"]));
  native.invoke.mockRejectedValue(new Error("storage unavailable"));
  await expect(loadRecentVaults()).rejects.toThrow("storage unavailable");
  expect(localStorage.getItem(RECENTS_KEY)).not.toBeNull();
});


describe("theme validation", () => {
  beforeEach(() => localStorage.clear());
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

describe("interface style validation", () => {
  beforeEach(() => localStorage.clear());
  it.each(UI_STYLE_IDS)("round-trips the %s style", (id) => {
    localStorage.setItem(UI_STYLE_KEY, id);
    expect(initialUiStyle()).toBe(id);
  });

  it.each([null, "", "Classic", "obsidian"])("defaults missing or invalid style %s to studio", (value) => {
    if (value !== null) localStorage.setItem(UI_STYLE_KEY, value);
    expect(initialUiStyle()).toBe("studio");
  });

  it("keeps picker IDs in the persistence order", () => {
    expect(UI_STYLES.map((u) => u.id)).toEqual([...UI_STYLE_IDS]);
  });
});
