// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileTree } from "./FileTree";
import { useAppStore } from "../store";
import type { VaultFile } from "../types";

/**
 * The file/folder context menu must dismiss on Escape like every native
 * context menu — it used to close only on click/blur, stranding keyboard
 * users with an open menu. The Escape keydown is consumed in the capture
 * phase so it cannot simultaneously close a modal stacked behind the menu.
 */

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const initial = useAppStore.getState();

const file = (relPath: string): VaultFile => ({
  path: `/vault/${relPath}`,
  relPath,
  name: relPath.split("/").pop()!.replace(/\.md$/, ""),
  ext: "md",
  isMarkdown: true,
  size: 10,
  mtime: 0,
});

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    useAppStore.setState({
      files: [file("a.md"), file("b.md")],
    });
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useAppStore.setState(initial, true);
});

function openMenu(): void {
  act(() => {
    root.render(<FileTree />);
  });
  const row = host.querySelector('[data-rel="a.md"]');
  expect(row).not.toBeNull();
  act(() => {
    row!.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 40,
      })
    );
  });
  expect(document.querySelector(".context-menu")).not.toBeNull();
}

describe("file tree context menu", () => {
  it("closes on Escape", () => {
    openMenu();
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      );
    });
    expect(document.querySelector(".context-menu")).toBeNull();
  });

  it("opens from the keyboard, moves focus through items and returns focus on Escape", () => {
    act(() => root.render(<FileTree />));
    const row = host.querySelector<HTMLElement>('[data-rel="a.md"]')!;
    row.focus();
    act(() => {
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }));
    });
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu).not.toBeNull();
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.length).toBeGreaterThan(2);
    expect(document.activeElement).toBe(items[0]);
    act(() => { items[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(items[1]);
    act(() => { items[1].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(items[items.length - 1]);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(document.querySelector(".context-menu")).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it("names the inline rename field", () => {
    openMenu();
    const rename = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent?.startsWith("Rename"))!;
    act(() => rename.click());
    expect(host.querySelector(".tree-rename")?.getAttribute("aria-label")).toBe("Rename a");
  });

  it("reports a clipboard failure instead of ignoring the click", async () => {
    document.execCommand = () => false;
    openMenu();
    const copy = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => /copy path/i.test(b.textContent ?? ""))!;
    await act(async () => copy.click());
    expect(useAppStore.getState().status).toBe("Could not copy to the clipboard.");
  });

  it("returns focus to the row when a menu item runs, so dialogs can restore it", async () => {
    act(() => root.render(<FileTree />));
    const row = host.querySelector<HTMLElement>('[data-rel="a.md"]')!;
    row.focus();
    act(() => { row.dispatchEvent(new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true })); });
    const open = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => /recovery storage/i.test(b.textContent ?? "") && !/^Move/.test(b.textContent ?? ""))!;
    expect(document.activeElement).not.toBe(row);
    await act(async () => open.click());
    expect(document.querySelector(".context-menu")).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it("ignores other keys", () => {
    openMenu();
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true })
      );
    });
    expect(document.querySelector(".context-menu")).not.toBeNull();
  });
});


describe("file extension badge palette", () => {
  it("keeps green-hued extensions neutral and other hues theme-controlled", () => {
    act(() => {
      useAppStore.setState({
        files: ["svg", "txt", "pdf"].map((ext) => ({
          ...file(`example.${ext}`), ext, isMarkdown: false,
        })),
      });
      root.render(<FileTree />);
    });
    for (const ext of ["svg", "txt"]) {
      const badge = host.querySelector(`[data-rel="example.${ext}"] .tree-ext`) as HTMLElement;
      expect(badge).not.toBeNull();
      expect(badge.classList.contains("tree-ext-neutral")).toBe(true);
      expect(badge.style.getPropertyValue("--ext-hue")).not.toBe("");
      expect(badge.style.color).toBe("");
    }
    const pdfBadge = host.querySelector('[data-rel="example.pdf"] .tree-ext') as HTMLElement;
    expect(pdfBadge.classList.contains("tree-ext-neutral")).toBe(false);
  });
});
