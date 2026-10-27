import { beforeEach, describe, expect, it } from "vitest";
import {
  claimPlainShiftTabToggle,
  claimKeyboardShortcut,
  isPlainShiftTab,
  isTextEntryTarget,
  isWindowTransferShortcut,
  notePlainShiftTabKeyUp,
  resetPlainShiftTabChord,
  undoRedoShortcutAction,
} from "./shortcuts";

describe("shortcuts", () => {
  beforeEach(() => resetPlainShiftTabChord());

  it("recognizes only unmodified Shift+Tab for the Steam overlay", () => {
    expect(
      isPlainShiftTab({
        key: "Tab",
        code: "Tab",
        shiftKey: true,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
      })
    ).toBe(true);
    expect(
      isPlainShiftTab({
        key: "Tab",
        code: "Tab",
        shiftKey: true,
        metaKey: true,
        ctrlKey: false,
        altKey: false,
      })
    ).toBe(false);
    expect(
      isPlainShiftTab({
        key: "Enter",
        code: "Enter",
        shiftKey: true,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
      })
    ).toBe(false);
    expect(
      isPlainShiftTab({
        key: "ISO_Left_Tab",
        code: "Tab",
        shiftKey: true,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
      })
    ).toBe(true);
  });

  it("uses the same modified Enter chord for tear-off and dock-back", () => {
    const chord = {
      key: "Enter",
      shiftKey: true,
      metaKey: true,
      ctrlKey: false,
      altKey: false,
    };
    expect(isWindowTransferShortcut(chord)).toBe(true);
    expect(isWindowTransferShortcut({ ...chord, metaKey: false, ctrlKey: true })).toBe(true);
    expect(isWindowTransferShortcut({ ...chord, shiftKey: false })).toBe(false);
    expect(isWindowTransferShortcut({ ...chord, altKey: true })).toBe(false);
    expect(isWindowTransferShortcut({ ...chord, key: " " })).toBe(false);
  });

  it("claims one Shift+Tab toggle while Tab is held, regardless of release order", () => {
    const tab = { key: "Tab", code: "Tab", type: "keydown", shiftKey: true, metaKey: false, ctrlKey: false, altKey: false, repeat: false };
    expect(claimPlainShiftTabToggle(tab)).toBe(true);
    expect(claimPlainShiftTabToggle(tab)).toBe(false);

    notePlainShiftTabKeyUp({ key: "Shift", code: "ShiftLeft", shiftKey: false, metaKey: false, ctrlKey: false, altKey: false });
    expect(claimPlainShiftTabToggle(tab)).toBe(false);
    notePlainShiftTabKeyUp({ key: "Tab", code: "Tab", shiftKey: false, metaKey: false, ctrlKey: false, altKey: false });
    expect(claimPlainShiftTabToggle(tab)).toBe(true);

    notePlainShiftTabKeyUp({ key: "Tab", code: "Tab", shiftKey: true, metaKey: false, ctrlKey: false, altKey: false });
    expect(claimPlainShiftTabToggle(tab)).toBe(true);
  });

  it("does not treat Tab keyup as a second Shift+Tab press", () => {
    const keydown = {
      key: "Tab",
      code: "Tab",
      type: "keydown",
      shiftKey: true,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      repeat: false,
    };
    const keyup = { ...keydown, type: "keyup" as const };

    expect(claimPlainShiftTabToggle(keydown)).toBe(true);
    expect(claimPlainShiftTabToggle(keyup)).toBe(false);

    notePlainShiftTabKeyUp(keyup);
    expect(claimPlainShiftTabToggle(keydown)).toBe(true);
  });

  it("recovers when the browser misses Tab keyup before the next physical press", () => {
    const first = {
      key: "Tab",
      code: "Tab",
      shiftKey: true,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      repeat: false,
      timeStamp: 100,
    };
    const duplicate = { ...first, timeStamp: 110 };
    const repeat = { ...first, repeat: true, timeStamp: 160 };
    const nextPress = { ...first, timeStamp: 220 };

    expect(claimPlainShiftTabToggle(first)).toBe(true);
    expect(claimPlainShiftTabToggle(duplicate)).toBe(false);
    expect(claimPlainShiftTabToggle(repeat)).toBe(false);
    expect(claimPlainShiftTabToggle(nextPress)).toBe(true);
  });

  it("treats editor and terminal surfaces as owned text-entry targets", () => {
    const xterm = {
      tagName: "DIV",
      isContentEditable: false,
      closest: (selector: string) => (selector === ".xterm" ? {} : null),
    } as unknown as Element;
    const input = {
      tagName: "INPUT",
      isContentEditable: false,
      closest: () => null,
    } as unknown as Element;
    const plain = {
      tagName: "BUTTON",
      isContentEditable: false,
      closest: () => null,
    } as unknown as Element;

    expect(isTextEntryTarget(xterm)).toBe(true);
    expect(isTextEntryTarget(input)).toBe(true);
    expect(isTextEntryTarget(plain)).toBe(false);
  });

  it("claims handled keyboard shortcuts so duplicate listeners cannot re-toggle", () => {
    const calls: string[] = [];
    claimKeyboardShortcut({
      preventDefault: () => calls.push("prevent"),
      stopImmediatePropagation: () => calls.push("immediate"),
      stopPropagation: () => calls.push("stop"),
    });

    expect(calls).toEqual(["prevent", "immediate", "stop"]);
  });

  it("maps common undo/redo shortcuts without accepting unrelated chords", () => {
    const base = {
      key: "z",
      shiftKey: false,
      metaKey: false,
      ctrlKey: true,
      altKey: false,
    };

    expect(undoRedoShortcutAction(base)).toBe("undo");
    expect(undoRedoShortcutAction({ ...base, shiftKey: true })).toBe("redo");
    expect(undoRedoShortcutAction({ ...base, key: "y" })).toBe("redo");
    expect(undoRedoShortcutAction({ ...base, ctrlKey: false, metaKey: true })).toBe("undo");
    expect(undoRedoShortcutAction({ ...base, altKey: true })).toBeNull();
    expect(undoRedoShortcutAction({ ...base, key: "x" })).toBeNull();
  });
});
