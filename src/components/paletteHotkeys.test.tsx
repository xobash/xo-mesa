// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";
import { HotkeySettings } from "./HotkeySettings";
import { useCustomHotkeys } from "./useCustomHotkeys";
import { useAppStore } from "../store";
import { registerEditorCommands } from "../lib/editorCommands";
import type { VaultFile } from "../types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const initial = useAppStore.getState();
const file = (relPath: string): VaultFile => ({
  path: `/vault/${relPath}`, relPath, name: relPath.split("/").pop()!.replace(/\.md$/, ""), ext: "md", isMarkdown: true,
});

beforeEach(() => {
  // jsdom has no layout; the palette scrolls the selected row into view.
  Element.prototype.scrollIntoView ??= () => {};
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useAppStore.setState(initial, true);
});

const press = (target: EventTarget, init: KeyboardEventInit) =>
  act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });

describe("template picker", () => {
  it("lists templates from the configured folder and inserts the filled template", async () => {
    const insertText = vi.fn(() => true);
    const unregister = registerEditorCommands({ path: () => "Note.md", openFind: () => true, insertText });
    const renderTemplate = vi.fn(async () => "# Note\n");
    useAppStore.setState({
      files: [file("Templates/Meeting.md"), file("Templates/Weekly.md"), file("Note.md")],
      settings: { ...initial.settings, templatesFolder: "Templates" },
      renderTemplate,
    });
    act(() => useAppStore.getState().openTemplatePicker());
    act(() => root.render(<CommandPalette />));
    const names = [...host.querySelectorAll(".palette-name")].map((node) => node.textContent);
    expect(names).toEqual(["Meeting", "Weekly"]);
    await act(async () => (host.querySelector(".palette-item") as HTMLButtonElement).click());
    expect(renderTemplate).toHaveBeenCalledWith("Templates/Meeting.md");
    expect(insertText).toHaveBeenCalledWith("# Note\n");
    expect(useAppStore.getState().paletteOpen).toBe(false);
    unregister();
  });

  it("explains how to add templates when the folder is empty", () => {
    useAppStore.setState({ files: [file("Note.md")], settings: { ...initial.settings, templatesFolder: "Snippets" } });
    act(() => useAppStore.getState().openTemplatePicker());
    act(() => root.render(<CommandPalette />));
    expect(host.querySelector(".palette-empty")?.textContent).toContain("“Snippets” folder");
  });

  it("reports when no editable note can receive the template", async () => {
    useAppStore.setState({
      files: [file("Templates/Meeting.md")],
      settings: { ...initial.settings, templatesFolder: "Templates" },
      renderTemplate: async () => "text",
    });
    act(() => useAppStore.getState().openTemplatePicker());
    act(() => root.render(<CommandPalette />));
    await act(async () => (host.querySelector(".palette-item") as HTMLButtonElement).click());
    expect(useAppStore.getState().status).toBe("Open an editable note to insert a template.");
  });

  it("shows a user hotkey beside its command", () => {
    useAppStore.setState({ settings: { ...initial.settings, hotkeys: { theme: "Mod+Shift+T" } } });
    act(() => useAppStore.getState().setPalette(true));
    act(() => root.render(<CommandPalette />));
    const input = host.querySelector<HTMLInputElement>(".palette-input")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, ">cycle theme");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const row = [...host.querySelectorAll(".palette-item")].find((item) => item.textContent?.includes("Cycle theme"));
    expect(row?.querySelector(".palette-hint")?.textContent).toMatch(/Ctrl\+Shift\+T|⌘⇧T/);
  });
});

describe("hotkey settings", () => {
  const recorder = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

  it("records, rejects conflicts, and clears a hotkey", () => {
    useAppStore.setState({ settings: { ...initial.settings, hotkeys: { graph: "Mod+J" } } });
    act(() => root.render(<HotkeySettings />));
    act(() => recorder("Set shortcut for Cycle theme").click());
    const active = recorder("Press a shortcut for Cycle theme");
    expect(active.hasAttribute("data-hotkey-recorder")).toBe(true);
    press(active, { key: "p", code: "KeyP", ctrlKey: true });
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/Command palette/);
    press(active, { key: "j", code: "KeyJ", ctrlKey: true });
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/Toggle full graph/);
    press(active, { key: "T", code: "KeyT", ctrlKey: true, shiftKey: true });
    expect(useAppStore.getState().settings.hotkeys).toEqual({ graph: "Mod+J", theme: "Mod+Shift+T" });
    act(() => recorder("Clear shortcut for Toggle full graph").click());
    expect(useAppStore.getState().settings.hotkeys).toEqual({ theme: "Mod+Shift+T" });
  });

  it("cancels recording with Escape", () => {
    act(() => root.render(<HotkeySettings />));
    act(() => recorder("Set shortcut for Cycle theme").click());
    press(recorder("Press a shortcut for Cycle theme"), { key: "Escape", code: "Escape" });
    expect(recorder("Set shortcut for Cycle theme")).not.toBeNull();
    expect(useAppStore.getState().settings.hotkeys).toEqual({});
  });
});

describe("custom hotkey listener", () => {
  function Harness() { useCustomHotkeys(); return <input aria-label="field" />; }

  it("runs the bound command before other handlers and leaves other keys alone", async () => {
    const setTasksOpen = vi.fn();
    useAppStore.setState({ setTasksOpen, settings: { ...initial.settings, hotkeys: { tasks: "Alt+T" } } });
    act(() => root.render(<Harness />));
    const later = vi.fn();
    window.addEventListener("keydown", later);
    press(host.querySelector("input")!, { key: "†", code: "KeyT", altKey: true });
    await vi.waitFor(() => expect(setTasksOpen).toHaveBeenCalledWith(true));
    expect(later).not.toHaveBeenCalled();
    press(host.querySelector("input")!, { key: "t", code: "KeyT" });
    expect(setTasksOpen).toHaveBeenCalledTimes(1);
    expect(later).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", later);
  });
});
