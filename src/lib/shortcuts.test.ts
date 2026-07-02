import { describe, expect, it } from "vitest";
import {
  claimKeyboardShortcut,
  isPlainShiftTab,
  isTextEntryTarget,
  undoRedoShortcutAction,
} from "./shortcuts";

describe("shortcuts", () => {
  it("recognizes only unmodified Shift+Tab for the Steam overlay", () => {
    expect(
      isPlainShiftTab({
        key: "Tab",
        shiftKey: true,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
      })
    ).toBe(true);
    expect(
      isPlainShiftTab({
        key: "Tab",
        shiftKey: true,
        metaKey: true,
        ctrlKey: false,
        altKey: false,
      })
    ).toBe(false);
    expect(
      isPlainShiftTab({
        key: "Enter",
        shiftKey: true,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
      })
    ).toBe(false);
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
