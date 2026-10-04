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
