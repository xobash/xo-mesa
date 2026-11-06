// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { blockedOnlyBrowserDefault, browserKeyAction, installBrowserKeyGuard } from "./browserKeyGuard";

const key = (init: KeyboardEventInit & { target?: Element }) => {
  const { target, ...rest } = init;
  return { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, code: "", key: "", ...rest, target } as unknown as KeyboardEvent;
};

describe("browserKeyAction", () => {
  it("claims the WebView2 save, print, reload and caret-browsing keys", () => {
    expect(browserKeyAction(key({ key: "s", code: "KeyS", ctrlKey: true }))).toBe("save");
    expect(browserKeyAction(key({ key: "p", code: "KeyP", ctrlKey: true }))).toBe("palette");
    expect(browserKeyAction(key({ key: "r", code: "KeyR", ctrlKey: true }))).toBe("block");
    expect(browserKeyAction(key({ key: "R", code: "KeyR", ctrlKey: true, shiftKey: true }))).toBe("block");
    expect(browserKeyAction(key({ key: "F5", code: "F5" }))).toBe("block");
    expect(browserKeyAction(key({ key: "F5", code: "F5", ctrlKey: true }))).toBe("block");
    expect(browserKeyAction(key({ key: "F7", code: "F7" }))).toBe("block");
  });

  it("leaves typing, AltGr and other chords alone", () => {
    expect(browserKeyAction(key({ key: "s", code: "KeyS" }))).toBeNull();
    // AltGr+S on a Polish layout types "ś" and reports Ctrl+Alt.
    expect(browserKeyAction(key({ key: "ś", code: "KeyS", ctrlKey: true, altKey: true }))).toBeNull();
    expect(browserKeyAction(key({ key: "S", code: "KeyS", ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(browserKeyAction(key({ key: "f", code: "KeyF", ctrlKey: true }))).toBeNull();
  });

  it("keeps Ctrl+P for the Pi terminal instead of opening the palette", () => {
    const term = document.createElement("div");
    term.className = "xterm";
    const textarea = term.appendChild(document.createElement("textarea"));
    expect(browserKeyAction(key({ key: "p", code: "KeyP", ctrlKey: true, target: textarea }))).toBe("block");
  });
});

describe("installBrowserKeyGuard", () => {
  let remove: (() => void) | undefined;
  afterEach(() => { remove?.(); remove = undefined; document.body.replaceChildren(); });

  const press = (target: EventTarget, init: KeyboardEventInit) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };

  it("cancels the browser action, flushes once on Ctrl+S, and keeps propagation", () => {
    const onSave = vi.fn();
    remove = installBrowserKeyGuard(window, { onSave });
    const field = document.body.appendChild(document.createElement("input"));
    const later = vi.fn();
    field.addEventListener("keydown", later);
    const save = press(field, { key: "s", code: "KeyS", ctrlKey: true });
    expect(save.defaultPrevented).toBe(true);
    expect(blockedOnlyBrowserDefault(save)).toBe(true);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(later).toHaveBeenCalledTimes(1);
    expect(press(field, { key: "s", code: "KeyS", ctrlKey: true, repeat: true }).defaultPrevented).toBe(true);
    expect(onSave).toHaveBeenCalledTimes(1);
    for (const init of [{ key: "F5", code: "F5" }, { key: "F7", code: "F7" }, { key: "r", code: "KeyR", ctrlKey: true }]) {
      expect(press(field, init).defaultPrevented, init.key).toBe(true);
    }
    expect(press(field, { key: "a", code: "KeyA" }).defaultPrevented).toBe(false);
  });

  it("opens the palette only where one exists; elsewhere Ctrl+P is a no-op", () => {
    const onPalette = vi.fn();
    remove = installBrowserKeyGuard(window, { onPalette });
    const main = press(document.body, { key: "p", code: "KeyP", ctrlKey: true });
    expect(main.defaultPrevented).toBe(true);
    expect(onPalette).toHaveBeenCalledTimes(1);
    remove();
    remove = installBrowserKeyGuard(window, {});
    expect(press(document.body, { key: "p", code: "KeyP", ctrlKey: true }).defaultPrevented).toBe(true);
    expect(onPalette).toHaveBeenCalledTimes(1);
  });

  it("stops guarding once removed", () => {
    remove = installBrowserKeyGuard(window, {});
    remove();
    remove = undefined;
    expect(press(document.body, { key: "F5", code: "F5" }).defaultPrevented).toBe(false);
  });
});
