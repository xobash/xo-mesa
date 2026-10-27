// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const confirmAction = vi.hoisted(() => vi.fn<(message: string) => Promise<boolean>>());
vi.mock("../lib/confirmAction", () => ({ confirmAction }));

import { PI_TERMINAL_LINK_HANDLER } from "./AgentPanel";
import { useAppStore } from "../store";

const click = () => new MouseEvent("click");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Pi terminal OSC 8 links", () => {
  beforeEach(() => {
    confirmAction.mockReset();
    useAppStore.setState({ piBrowse: null });
  });

  it("asks xterm to drop non-HTTP links before activation", () => {
    expect(PI_TERMINAL_LINK_HANDLER.allowNonHttpProtocols).toBe(false);
  });

  it("opens a confirmed http(s) link in Mesa's reader, never a new window", async () => {
    const open = vi.spyOn(window, "open");
    confirmAction.mockResolvedValue(true);
    PI_TERMINAL_LINK_HANDLER.activate(click(), "https://example.com/a?b=1", undefined as never);
    await flush();
    expect(confirmAction).toHaveBeenCalledWith(expect.stringContaining("https://example.com/a?b=1"), expect.anything());
    expect(useAppStore.getState().piBrowse).toEqual({ url: "https://example.com/a?b=1", seq: 1 });
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("does nothing when the reader confirmation is declined", async () => {
    confirmAction.mockResolvedValue(false);
    PI_TERMINAL_LINK_HANDLER.activate(click(), "http://example.com/", undefined as never);
    await flush();
    expect(useAppStore.getState().piBrowse).toBeNull();
  });

  it("refuses other schemes without asking", async () => {
    for (const uri of ["file:///etc/passwd", "javascript:alert(1)", "tauri://localhost/", "mailto:a@example.com", "not a url"]) {
      PI_TERMINAL_LINK_HANDLER.activate(click(), uri, undefined as never);
    }
    await flush();
    expect(confirmAction).not.toHaveBeenCalled();
    expect(useAppStore.getState().piBrowse).toBeNull();
  });
});
