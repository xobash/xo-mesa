// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dialog = vi.hoisted(() => ({ confirm: vi.fn(async (_message: string, _options?: unknown) => true) }));
vi.mock("../lib/confirmAction", () => ({ confirmAction: dialog.confirm }));

import { FileTree } from "./FileTree";
import { getStore, useAppStore } from "../store";
import type { VaultFile } from "../types";

/** Behavior of the file tree's keyboard menu, rename, delete and reveal flows. */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const initial = useAppStore.getState();

const file = (relPath: string, ext = "md"): VaultFile => ({
  path: `/vault/${relPath}`,
  relPath,
  name: relPath.split("/").pop()!.replace(/\.[^.]+$/, ""),
  ext,
  isMarkdown: ext === "md",
  size: 10,
  mtime: 0,
});

const actions = {
  openFile: vi.fn(async () => {}),
  openToSide: vi.fn(async () => {}),
  openDocWindow: vi.fn(async () => {}),
  duplicateEntry: vi.fn(async () => {}),
  deleteEntry: vi.fn(async () => {}),
  renameNote: vi.fn(async () => {}),
  createChildNote: vi.fn(async () => {}),
  createChildFolder: vi.fn(async () => {}),
  toggleBookmark: vi.fn(),
  openRecovery: vi.fn(),
};

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockClear();
  dialog.confirm.mockReset();
  dialog.confirm.mockResolvedValue(true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    useAppStore.setState({
      ...(actions as unknown as Partial<ReturnType<typeof getStore>>),
      vaultPath: "/vault",
      files: [file("a.md"), file("docs/b.md"), file("docs/c.pdf", "pdf")],
      notes: { "a.md": { title: "Alpha" } as never },
    });
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.querySelectorAll(".context-menu").forEach((m) => m.remove());
  useAppStore.setState(initial, true);
});

function render(): void {
  act(() => root.render(<FileTree />));
}

function key(target: Element, k: string, init: KeyboardEventInit = {}): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
}

function openMenuFor(selector: string): HTMLElement {
  const row = host.querySelector<HTMLElement>(selector)!;
  expect(row).not.toBeNull();
  row.focus();
  key(row, "ContextMenu");
  const menu = document.querySelector<HTMLElement>('[role="menu"]');
  expect(menu).not.toBeNull();
  return menu!;
}

function item(menu: HTMLElement, label: RegExp): HTMLButtonElement {
  const found = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => label.test(b.textContent ?? ""));
  expect(found, `menu item ${label}`).toBeDefined();
  return found!;
}

function pick(selector: string, label: RegExp): void {
  const button = item(openMenuFor(selector), label);
  act(() => button.click());
}

async function pickAsync(selector: string, label: RegExp): Promise<void> {
  const button = item(openMenuFor(selector), label);
  await act(async () => button.click());
}

function folderRow(name: string): HTMLElement {
  return [...host.querySelectorAll<HTMLElement>(".tree-folder")].find((b) => b.textContent?.includes(name))!;
}

describe("file tree keyboard", () => {
  it("opens a file with Enter or Space and ignores key repeat", () => {
    render();
    const row = host.querySelector<HTMLElement>('[data-rel="a.md"]')!;
    key(row, "Enter");
    key(row, " ");
    key(row, "Enter", { repeat: true });
    key(row, "x");
    expect(actions.openFile).toHaveBeenCalledTimes(2);
    expect(actions.openFile).toHaveBeenCalledWith("a.md");
  });

  it("Tab in the menu closes it and returns focus to the invoking row", () => {
    render();
    const menu = openMenuFor('[data-rel="a.md"]');
    key(menu, "Tab");
    expect(document.querySelector(".context-menu")).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('[data-rel="a.md"]'));
  });

  it("ArrowUp from the first item wraps to the last; Home returns to the first", () => {
    render();
    const menu = openMenuFor('[data-rel="a.md"]');
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(document.activeElement).toBe(items[0]);
    key(items[0], "ArrowUp");
    expect(document.activeElement).toBe(items[items.length - 1]);
    key(items[items.length - 1], "Home");
    expect(document.activeElement).toBe(items[0]);
  });

  it("a window click or blur dismisses the menu", () => {
    render();
    openMenuFor('[data-rel="a.md"]');
    act(() => window.dispatchEvent(new MouseEvent("click")));
    expect(document.querySelector(".context-menu")).toBeNull();
    openMenuFor('[data-rel="a.md"]');
    act(() => window.dispatchEvent(new Event("blur")));
    expect(document.querySelector(".context-menu")).toBeNull();
  });

  it("toggles folders through the store action", () => {
    render();
    act(() => folderRow("docs").click());
    expect(getStore().collapsedFolders.docs).toBe(true);
    expect(host.querySelector('[data-rel="docs/b.md"]')).toBeNull();
  });
});

describe("file menu actions", () => {
  it("routes open actions to the matching store actions", () => {
    act(() => useAppStore.setState({ settings: { ...getStore().settings, enableTabs: true } }));
    render();
    pick('[data-rel="a.md"]', /new tab/i);
    pick('[data-rel="a.md"]', /to the side/i);
    pick('[data-rel="a.md"]', /new window/i);
    pick('[data-rel="a.md"]', /^Duplicate/);
    expect(actions.openFile).toHaveBeenCalledWith("a.md");
    expect(actions.openToSide).toHaveBeenCalledWith("a.md");
    expect(actions.openDocWindow).toHaveBeenCalledWith("a.md");
    expect(actions.duplicateEntry).toHaveBeenCalledWith("a.md");
    expect(document.querySelector(".context-menu")).toBeNull();
  });

  it("hides Open in new tab when tabs are off", () => {
    act(() => useAppStore.setState({ settings: { ...getStore().settings, enableTabs: false } }));
    render();
    const menu = openMenuFor('[data-rel="a.md"]');
    expect(menu.textContent).not.toMatch(/new tab/i);
  });

  it("labels the bookmark item by current state and toggles it", () => {
    act(() => useAppStore.setState({ settings: { ...getStore().settings, bookmarks: ["a.md"] } }));
    render();
    expect(host.querySelector('[data-rel="a.md"]')!.className).toContain("bookmarked");
    pick('[data-rel="a.md"]', /Remove from bookmarks/);
    expect(actions.toggleBookmark).toHaveBeenCalledWith("a.md");
    expect(item(openMenuFor('[data-rel="docs/b.md"]'), /Bookmark…/)).toBeTruthy();
  });

  it("copies the absolute file path", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render();
    await pickAsync('[data-rel="a.md"]', /copy path/i);
    expect(writeText).toHaveBeenCalledWith("/vault/a.md");
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  });

  it("opens recovery storage", () => {
    render();
    pick('[data-rel="a.md"]', /^Open recovery/);
    expect(actions.openRecovery).toHaveBeenCalledTimes(1);
  });
});

describe("rename", () => {
  function startRename(): HTMLInputElement {
    render();
    pick('[data-rel="a.md"]', /^Rename/);
    const input = host.querySelector<HTMLInputElement>(".tree-rename")!;
    expect(input).not.toBeNull();
    return input;
  }

  it("Enter commits a changed name", () => {
    const input = startRename();
    input.value = "Renamed";
    key(input, "Enter");
    expect(actions.renameNote).toHaveBeenCalledWith("a.md", "Renamed");
    expect(host.querySelector(".tree-rename")).toBeNull();
  });

  it("does not rename when the name equals the note title or is empty", () => {
    const input = startRename();
    input.value = "Alpha";
    key(input, "Enter");
    expect(actions.renameNote).not.toHaveBeenCalled();
    pick('[data-rel="a.md"]', /^Rename/);
    const again = host.querySelector<HTMLInputElement>(".tree-rename")!;
    again.value = "";
    key(again, "Enter");
    expect(actions.renameNote).not.toHaveBeenCalled();
  });

  it("Escape cancels without renaming", () => {
    const input = startRename();
    input.value = "Other";
    key(input, "Escape");
    expect(host.querySelector(".tree-rename")).toBeNull();
    expect(actions.renameNote).not.toHaveBeenCalled();
  });
});

describe("move to recovery", () => {
  it("asks through confirmAction with the note title and deletes on consent", async () => {
    render();
    await pickAsync('[data-rel="a.md"]', /^Move to recovery/);
    expect(dialog.confirm).toHaveBeenCalledWith('Move "Alpha" to Mesa recovery storage?', { okLabel: "Move to recovery" });
    expect(actions.deleteEntry).toHaveBeenCalledWith("a.md");
  });

  it("keeps the entry when the user cancels", async () => {
    dialog.confirm.mockResolvedValue(false);
    render();
    await pickAsync('[data-rel="a.md"]', /^Move to recovery/);
    expect(dialog.confirm).toHaveBeenCalledTimes(1);
    expect(actions.deleteEntry).not.toHaveBeenCalled();
  });

  it("refuses to delete after the vault changed during the dialog", async () => {
    let answer!: (ok: boolean) => void;
    dialog.confirm.mockImplementation(() => new Promise<boolean>((r) => { answer = r; }));
    render();
    pick('[data-rel="a.md"]', /^Move to recovery/);
    act(() => useAppStore.setState({ vaultPath: "/other" }));
    await act(async () => answer(true));
    expect(actions.deleteEntry).not.toHaveBeenCalled();
  });

  it("describes folder deletion as including its contents", async () => {
    render();
    await pickAsync(".tree-folder", /^Move to recovery/);
    expect(dialog.confirm.mock.calls[0][0]).toBe('Move folder "docs" and everything inside it to Mesa recovery storage?');
    expect(actions.deleteEntry).toHaveBeenCalledWith("docs");
  });
});

describe("folder menu", () => {
  it("creates child notes and folders and copies the folder path", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render();
    pick(".tree-folder", /^New note/);
    pick(".tree-folder", /^New folder/);
    pick(".tree-folder", /Bookmark/);
    await pickAsync(".tree-folder", /copy path/i);
    expect(actions.createChildNote).toHaveBeenCalledWith("docs");
    expect(actions.createChildFolder).toHaveBeenCalledWith("docs");
    expect(actions.toggleBookmark).toHaveBeenCalledWith("docs");
    expect(writeText).toHaveBeenCalledWith("docs");
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  });

  it("opens a folder menu with the right-click position", () => {
    render();
    act(() => {
      folderRow("docs").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 50 }));
    });
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.getAttribute("aria-label")).toBe("Actions for docs");
  });
});

describe("filters and empty states", () => {
  it("shows the hidden count and Show all clears both filters", () => {
    act(() => useAppStore.setState({ settings: { ...getStore().settings, typeFilter: "pdf" } }));
    render();
    const notice = host.querySelector(".tree-filter-notice")!;
    expect(notice.textContent).toContain("2 hidden");
    expect(host.querySelector('[data-rel="a.md"]')).toBeNull();
    act(() => notice.querySelector("button")!.click());
    expect(getStore().settings.typeFilter).toBe("all");
    expect(getStore().settings.hideGeneratedFiles).toBe(false);
    expect(host.querySelector('[data-rel="a.md"]')).not.toBeNull();
  });

  it("distinguishes an empty vault from a fully filtered one", () => {
    act(() => useAppStore.setState({ files: [] }));
    render();
    expect(host.querySelector(".tree-empty")!.textContent).toBe("No notes yet.");
    act(() => useAppStore.setState({ files: [file("a.md")], settings: { ...getStore().settings, typeFilter: "pdf" } }));
    expect(host.querySelector(".tree-empty")!.textContent).toBe("No files match the navigation filters.");
  });
});

describe("reveal", () => {
  it("expands collapsed ancestors, clears the type filter and scrolls the target row into view", () => {
    const many = Array.from({ length: 60 }, (_, i) => file(`n${String(i).padStart(2, "0")}.md`));
    act(() => useAppStore.setState({
      files: [...many, file("zz/z.md")],
      collapsedFolders: { zz: true },
      settings: { ...getStore().settings, typeFilter: "md", foldersFirst: false, sortMode: "name", sortDir: "asc" },
    }));
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    Object.defineProperty(scroller, "clientHeight", { value: 100, configurable: true });
    let scrolled = 0;
    Object.defineProperty(scroller, "scrollTop", { get: () => scrolled, set: (v: number) => { scrolled = v; }, configurable: true });
    host.appendChild(scroller);
    const inner = createRoot(scroller);
    try {
      act(() => inner.render(<FileTree />));
      // Windowed: a 100px viewport mounts only a slice of 61 rows.
      expect(scroller.querySelectorAll(".tree-row").length).toBeLessThan(61);
      act(() => useAppStore.setState({ activePath: "zz/z.md" }));
      act(() => useAppStore.setState({ revealTick: getStore().revealTick + 1 }));
      expect(getStore().collapsedFolders.zz).toBe(false);
      expect(getStore().settings.typeFilter).toBe("all");
      expect(scroller.scrollTop).toBeGreaterThan(0);
    } finally {
      act(() => inner.unmount());
    }
  });

  it("does nothing without an active path", () => {
    act(() => useAppStore.setState({ activePath: null, collapsedFolders: { docs: true } }));
    render();
    act(() => useAppStore.setState({ revealTick: getStore().revealTick + 1 }));
    expect(getStore().collapsedFolders.docs).toBe(true);
  });
});
