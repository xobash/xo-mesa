// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorView } from "codemirror";
import { ensureSyntaxTree } from "@codemirror/language";
import { viewContent } from "./workspaceViews";
import { useAppStore } from "../store";
import { clearSniffedText, rememberSniffedText } from "../lib/vault";
import type { VaultFile } from "../types";

vi.mock("../lib/textCachePlan", async (original) => ({
  ...(await original<typeof import("../lib/textCachePlan")>()),
  MAX_EDITABLE_TEXT_CHARS: 64,
}));

/**
 * EVERY TEXT FILE OPENS EDITABLE IN THE MAIN PANE.
 *
 * Code, config, data and sniffed unknown-extension files use the same editor
 * and save path as notes. Opening a file without editing it never reaches the
 * save path. Read-only is used only with a reason on screen.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const initial = useAppStore.getState();

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useAppStore.setState(initial, true);
  clearSniffedText();
});

function vaultFile(relPath: string, ext: string): VaultFile {
  return { path: `/vault/${relPath}`, relPath, name: relPath.replace(/\.[^.]+$/, ""), ext, isMarkdown: false };
}

async function open(file: VaultFile, text: string, state: "ready" | "invalid-encoding" | "loading" = "ready") {
  const setContentFromEditor = vi.fn(initial.setContentFromEditor);
  act(() => {
    useAppStore.setState({
      files: [file],
      vaultPath: "/vault",
      activePath: file.relPath,
      activeContentState: state,
      content: text,
      contentCache: { [file.relPath]: text },
      setContentFromEditor,
    });
    root.render(<>{viewContent("doc")}</>);
  });
  if (state !== "loading") await vi.waitFor(() => expect(host.querySelector(".cm-content")).not.toBeNull());
  return setContentFromEditor;
}

const view = () => EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-content")!)!;
const buttonLabels = () => [...host.querySelectorAll("button")].map((b) => b.textContent?.trim());

it("edits a code file in the editor, keeping CRLF, and writes nothing until an edit", async () => {
  const setContent = await open(vaultFile("data.json", "json"), '{\r\n  "a": 1\r\n}\r\n');
  const content = host.querySelector(".cm-content")!;
  expect(content.getAttribute("aria-label")).toBe("Text editor");
  expect(content.getAttribute("contenteditable")).toBe("true");
  expect(buttonLabels()).not.toContain("Live");
  expect(setContent).not.toHaveBeenCalled();
  act(() => view().dispatch({ changes: { from: view().state.doc.line(2).to, insert: "," } }));
  expect(setContent).toHaveBeenCalledTimes(1);
  expect(useAppStore.getState().content).toBe('{\r\n  "a": 1,\r\n}\r\n');
});

it("highlights code with the shared token rules, across lines", async () => {
  await open(vaultFile("app.js", "js"), "/* one\ntwo */ const x = 'y';\n");
  const state = view().state;
  const tree = ensureSyntaxTree(state, state.doc.length, 5000)!;
  const names = (pos: number) => tree.resolveInner(pos, 1).name;
  expect(names(state.doc.line(2).from)).toBe("comment");
  expect(names(state.doc.toString().indexOf("const"))).toBe("keyword");
  expect(names(state.doc.toString().indexOf("'y'"))).toBe("string");
});

it("opens CSV as an editable table with a Raw toggle and writes nothing on open", async () => {
  const setContent = await open(vaultFile("people.csv", "csv"), "name,age\r\nAnn,30\r\n");
  expect(host.querySelector('[role="grid"]')).not.toBeNull();
  expect(buttonLabels()).toEqual(expect.arrayContaining(["Table", "Raw", "Add row"]));
  act(() => [...host.querySelectorAll("button")].find((b) => b.textContent === "Raw")!.click());
  expect(host.querySelector('[role="grid"]')).toBeNull();
  expect(setContent).not.toHaveBeenCalled();
});

it("shows a semicolon CSV as columns", async () => {
  await open(vaultFile("export.csv", "csv"), "Name;Stadt\r\nAnn;Wien\r\n");
  const cells = [...host.querySelectorAll('[role="gridcell"]')].map((cell) => cell.textContent);
  expect(cells).toEqual(["Name", "Stadt", "Ann", "Wien"]);
});

it("keeps invalid UTF-8 code read-only and says why", async () => {
  await open(vaultFile("legacy.ini", "ini"), "caf�=1\n", "invalid-encoding");
  expect(host.querySelector(".cm-content")!.getAttribute("contenteditable")).toBe("false");
  expect(host.textContent).toContain("not valid UTF-8; opened read-only");
});

it("opens a file above the edit limit read-only and says why", async () => {
  await open(vaultFile("big.log", "log"), "x".repeat(65));
  expect(host.querySelector(".cm-content")!.getAttribute("contenteditable")).toBe("false");
  expect(host.textContent).toContain("opened read-only so typing stays fast");
});

it("shows Loading while an unknown file is sniffed, then the editor once it is text", async () => {
  const file = vaultFile("init.lua", "lua");
  await open(file, "", "loading");
  expect(host.textContent).toContain("Loading document");
  rememberSniffedText(file.path);
  act(() => useAppStore.setState({ content: "print(1)\n", contentCache: { "init.lua": "print(1)\n" }, activeContentState: "ready" }));
  await vi.waitFor(() => expect(host.querySelector(".cm-content")).not.toBeNull());
  expect(host.querySelector(".cm-content")!.getAttribute("contenteditable")).toBe("true");
});
