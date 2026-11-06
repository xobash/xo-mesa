import { describe, expect, it, vi } from "vitest";
import { copyTerminalSelection, terminalClipboardKey, windowsPtyOption } from "./terminalPlatform";

const key = (init: Partial<KeyboardEvent>) => ({
  type: "keydown", key: "", code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init,
});

describe("terminalClipboardKey", () => {
  it("copies on Ctrl+C only with a selection off macOS; otherwise Ctrl+C stays SIGINT", () => {
    expect(terminalClipboardKey(key({ key: "c", code: "KeyC", ctrlKey: true }), true, false)).toBe("copy");
    expect(terminalClipboardKey(key({ key: "c", code: "KeyC", ctrlKey: true }), false, false)).toBeNull();
    expect(terminalClipboardKey(key({ type: "keyup", key: "c", code: "KeyC", ctrlKey: true }), true, false)).toBeNull();
  });

  it("pastes on Ctrl+V and Ctrl+Shift+V off macOS", () => {
    expect(terminalClipboardKey(key({ key: "v", code: "KeyV", ctrlKey: true }), false, false)).toBe("paste");
    expect(terminalClipboardKey(key({ key: "V", code: "KeyV", ctrlKey: true, shiftKey: true }), false, false)).toBe("paste");
  });

  it("keeps macOS and AltGr keys going to Pi", () => {
    expect(terminalClipboardKey(key({ key: "c", code: "KeyC", ctrlKey: true }), true, true)).toBeNull();
    expect(terminalClipboardKey(key({ key: "v", code: "KeyV", ctrlKey: true }), false, true)).toBeNull();
    expect(terminalClipboardKey(key({ key: "@", code: "KeyV", ctrlKey: true, altKey: true }), false, false)).toBeNull();
  });
});

describe("windowsPtyOption", () => {
  const nav = (userAgent: string, platformVersion?: string) => ({
    userAgent,
    userAgentData: { getHighEntropyValues: async () => ({ platformVersion }) },
  });
  const win = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/131";

  it("tells xterm whether ConPTY reflows on its own", async () => {
    expect(await windowsPtyOption(nav(win, "15.0.0"))).toEqual({ backend: "conpty", buildNumber: 22000 });
    expect(await windowsPtyOption(nav(win, "10.0.0"))).toEqual({ backend: "conpty", buildNumber: 19045 });
    expect(await windowsPtyOption({ userAgent: win })).toEqual({ backend: "conpty" });
    expect(await windowsPtyOption({ userAgent: win, userAgentData: { getHighEntropyValues: async () => { throw new Error("blocked"); } } })).toEqual({ backend: "conpty" });
  });

  it("sets nothing outside Windows", async () => {
    expect(await windowsPtyOption(nav("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", "15.0.0"))).toBeUndefined();
  });
});

describe("copyTerminalSelection", () => {
  const term = (selection: string) => ({ getSelection: () => selection, clearSelection: vi.fn() });

  it("writes the selection and clears it only after the clipboard accepted it", async () => {
    const t = term("npm test");
    const order: string[] = [];
    t.clearSelection.mockImplementation(() => order.push("clear"));
    const writeText = vi.fn(async () => { order.push("write"); });
    expect(await copyTerminalSelection(t, { writeText })).toBeNull();
    expect(writeText).toHaveBeenCalledWith("npm test");
    expect(order).toEqual(["write", "clear"]);
  });

  it("keeps the selection and reports a failed or missing clipboard", async () => {
    const t = term("npm test");
    expect(await copyTerminalSelection(t, { writeText: async () => { throw new Error("denied"); } })).toMatch(/denied/);
    expect(await copyTerminalSelection(t, undefined)).toMatch(/no clipboard/);
    expect(t.clearSelection).not.toHaveBeenCalled();
  });
});
