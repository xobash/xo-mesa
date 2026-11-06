import { describe, expect, it } from "vitest";
import { commandForEvent, formatHotkey, hotkeyConflict, hotkeyFromEvent, isAppModifier, normalizeHotkey, terminalOwnsChord, normalizeHotkeys, reservedBy } from "./hotkeys";

const key = (init: Partial<KeyboardEvent> & { key: string; code?: string }) => ({
  code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init,
});

describe("hotkeyFromEvent", () => {
  it("reads Mod as Cmd on macOS and Ctrl elsewhere, never the other key", () => {
    expect(hotkeyFromEvent(key({ key: "k", code: "KeyK", metaKey: true, shiftKey: true }), true)).toBe("Mod+Shift+K");
    expect(hotkeyFromEvent(key({ key: "k", code: "KeyK", ctrlKey: true }), false)).toBe("Mod+K");
    // Ctrl+K on macOS (terminal kill-line) and Win+K elsewhere are not chords.
    expect(hotkeyFromEvent(key({ key: "k", code: "KeyK", ctrlKey: true }), true)).toBeNull();
    expect(hotkeyFromEvent(key({ key: "k", code: "KeyK", metaKey: true }), false)).toBeNull();
  });
  it("never reads AltGr typing as a chord", () => {
    // AltGr+Q types "@" on a German Windows layout and reports Ctrl+Alt.
    const altGr = { ...key({ key: "@", code: "KeyQ", ctrlKey: true, altKey: true }), getModifierState: (name: string) => name === "AltGraph" };
    expect(hotkeyFromEvent(altGr, false)).toBeNull();
    expect(commandForEvent({ theme: "Mod+Alt+Q" }, altGr, false)).toBeNull();
  });
  it("reads letters, digits and punctuation from the physical key", () => {
    // Option+K types "˚" on a US Mac layout.
    expect(hotkeyFromEvent(key({ key: "˚", code: "KeyK", altKey: true }), true)).toBe("Alt+K");
    expect(hotkeyFromEvent(key({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true }), false)).toBe("Mod+Shift+1");
    expect(hotkeyFromEvent(key({ key: "/", code: "Slash", metaKey: true }), true)).toBe("Mod+/");
    expect(hotkeyFromEvent(key({ key: "F5", code: "F5" }))).toBe("F5");
  });
  it("ignores a bare modifier press", () => {
    expect(hotkeyFromEvent(key({ key: "Shift", code: "ShiftLeft", shiftKey: true }))).toBeNull();
  });
});

describe("normalizeHotkey", () => {
  it("accepts platform spellings and orders modifiers", () => {
    expect(normalizeHotkey("shift+cmd+k")).toBe("Mod+Shift+K");
    expect(normalizeHotkey("Option+Ctrl+arrowup")).toBe("Mod+Alt+ArrowUp");
    expect(normalizeHotkey("F12")).toBe("F12");
  });
  it("rejects chords that would capture ordinary typing or are malformed", () => {
    for (const value of ["K", "Shift+K", "Mod+", "Mod+Mod+K", "Hyper+K", "Mod++", "Mod+KK", 7, null]) {
      expect(normalizeHotkey(value)).toBeNull();
    }
  });
});

describe("normalizeHotkeys", () => {
  it("drops invalid ids, invalid chords, reserved chords and duplicates", () => {
    expect(normalizeHotkeys({
      theme: "mod+shift+t", graph: "Mod+Shift+T", "Bad Id": "Mod+J", today: "Mod+P", help: "J", tasks: "Alt+T",
    })).toEqual({ theme: "Mod+Shift+T", tasks: "Alt+T" });
    expect(normalizeHotkeys(["Mod+K"])).toEqual({});
    expect(normalizeHotkeys(null)).toEqual({});
  });
});

describe("reservedBy", () => {
  it("reserves editor keys, caret movement and every variant of Mesa's own keys", () => {
    for (const chord of ["Mod+D", "Mod+/", "Mod+Shift+K", "Mod+Shift+P", "Mod+Alt+N", "Mod+Shift+W", "Alt+ArrowUp", "Mod+Backspace", "Alt+Shift+ArrowLeft"]) {
      expect(reservedBy(chord), chord).not.toBeNull();
    }
    expect(reservedBy("Mod+Shift+T")).toBeNull();
    expect(reservedBy("Alt+T")).toBeNull();
  });

  it("reserves Ctrl+S for the save guard only off macOS", () => {
    expect(reservedBy("Mod+S", false)).toBe("Save now");
    expect(reservedBy("Mod+S", true)).toBeNull();
  });
});

describe("isAppModifier", () => {
  it("treats AltGr (Ctrl+Alt) as typing off macOS and keeps macOS chords", () => {
    expect(isAppModifier(key({ key: "p", ctrlKey: true }), false)).toBe(true);
    expect(isAppModifier(key({ key: "@", ctrlKey: true, altKey: true }), false)).toBe(false);
    expect(isAppModifier(key({ key: "π", metaKey: true, altKey: true }), true)).toBe(true);
    expect(isAppModifier(key({ key: "p", ctrlKey: true }), true)).toBe(true);
  });
});

describe("hotkeyConflict", () => {
  const labels = (id: string) => ({ theme: "Cycle theme" })[id] ?? id;
  it("explains reserved and already-assigned chords", () => {
    expect(hotkeyConflict({}, "theme", "Mod+P", labels)).toMatch(/Command palette/);
    expect(hotkeyConflict({ theme: "Mod+J" }, "graph", "Mod+J", labels)).toMatch(/assigned to Cycle theme/);
    expect(hotkeyConflict({ theme: "Mod+J" }, "theme", "Mod+J", labels)).toBeNull();
    expect(hotkeyConflict({}, "theme", "Shift+J", labels)).toMatch(/Ctrl\/Cmd or Alt/);
  });
});

describe("commandForEvent and formatHotkey", () => {
  it("finds the bound command and formats per platform", () => {
    expect(commandForEvent({ theme: "Mod+Shift+T" }, key({ key: "T", code: "KeyT", metaKey: true, shiftKey: true }), true)).toBe("theme");
    expect(commandForEvent({ theme: "Mod+Shift+T" }, key({ key: "t", code: "KeyT", metaKey: true }), true)).toBeNull();
    expect(formatHotkey("Mod+Alt+Shift+K", true)).toBe("⌘⌥⇧K");
    expect(formatHotkey("Mod+Shift+K", false)).toBe("Ctrl+Shift+K");
  });
});

describe("terminalOwnsChord", () => {
  it("gives Pi the Ctrl chords readline uses off macOS only", () => {
    for (const chord of ["Mod+E", "Mod+Shift+R", "Mod+[", "Mod+\\", "Mod+Space"]) expect(terminalOwnsChord(chord, false), chord).toBe(true);
    for (const chord of ["Alt+T", "F5", "Mod+1", "Mod+Alt+E"]) expect(terminalOwnsChord(chord, false), chord).toBe(false);
    expect(terminalOwnsChord("Mod+E", true)).toBe(false);
  });
});
