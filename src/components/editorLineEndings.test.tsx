// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { EditorView } from "codemirror";
import { Editor } from "./Editor";
import { useAppStore } from "../store";

/**
 * A FILE'S LINE ENDINGS SURVIVE AN EDIT.
 *
 * Untouched lines keep the exact break they had on disk, and new breaks take
 * the file's dominant break. Synced Mac/Windows vaults hold LF, CRLF and
 * mixed files; an edit must never rewrite lines the user did not touch.
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
});

function showNote(path: string, text: string) {
  act(() => {
    useAppStore.setState({
      activePath: path,
      content: text,
      contentCache: { ...useAppStore.getState().contentCache, [path]: text },
    });
  });
}

function mount(path: string, text: string): EditorView {
  showNote(path, text);
  act(() => root.render(<Editor />));
  return viewOf();
}

const viewOf = (): EditorView => {
  const cm = host.querySelector(".cm-content");
  const view = cm ? EditorView.findFromDOM(cm as HTMLElement) : null;
  if (!view) throw new Error("editor view not found");
  return view;
};

const content = () => useAppStore.getState().content;

function undoAsUser(view: EditorView) {
  const event = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "historyUndo" });
  view.contentDOM.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
}

it("keeps every untouched line's break when a mixed file is edited", () => {
  const view = mount("mixed.md", "a\r\nb\nc\r\nd\re");
  act(() => view.dispatch({ changes: { from: view.state.doc.line(3).to, insert: "!" } }));
  expect(content()).toBe("a\r\nb\nc!\r\nd\re");
});

it("gives a new line in a mixed file the file's dominant break", () => {
  const view = mount("mixed.md", "a\r\nb\nc\r\n");
  act(() => view.dispatch({ changes: { from: view.state.doc.line(2).to, insert: "\nnew" } }));
  expect(content()).toBe("a\r\nb\r\nnew\nc\r\n");
});

it("joins two lines of a mixed file without touching the other breaks", () => {
  const view = mount("mixed.md", "a\r\nb\nc\r\nd\n");
  // Delete the break after line 2 (an LF).
  act(() => view.dispatch({ changes: { from: view.state.doc.line(2).to, to: view.state.doc.line(3).from } }));
  expect(content()).toBe("a\r\nbc\r\nd\n");
});

it("converts pasted LF text to a CRLF file's breaks", () => {
  const view = mount("crlf.md", "one\r\ntwo\r\n");
  act(() => view.dispatch(view.state.replaceSelection("pasted\nlines\n")));
  expect(content()).toBe("pasted\r\nlines\r\none\r\ntwo\r\n");
});

it("preserves a classic-Mac CR file", () => {
  const view = mount("cr.txt", "a\rb\r");
  act(() => view.dispatch({ changes: { from: 1, insert: "\n" } }));
  expect(content()).toBe("a\r\rb\r");
});

it("keeps LF files as LF", () => {
  const view = mount("lf.md", "a\nb\n");
  act(() => view.dispatch({ changes: { from: 1, insert: "\r\nz" } }));
  expect(content()).toBe("a\nz\nb\n");
});

it("restores a mixed file's session and undo when returning to its tab", () => {
  const view = mount("mixed.md", "a\r\nb\nc");
  act(() => view.dispatch({ changes: { from: 1, insert: "x" } }));
  expect(content()).toBe("ax\r\nb\nc");
  showNote("other.md", "other");
  showNote("mixed.md", "ax\r\nb\nc");
  act(() => undoAsUser(viewOf()));
  expect(content()).toBe("a\r\nb\nc");
});

it("restores the exact breaks of deleted lines on undo, and redo removes them again", () => {
  const original = "a\r\nb\nc\rd\r\n";
  const view = mount("mixed.md", original);
  // Delete lines 2-3 with their LF and CR breaks.
  act(() => view.dispatch({ changes: { from: view.state.doc.line(2).from, to: view.state.doc.line(4).from }, userEvent: "delete" }));
  expect(content()).toBe("a\r\nd\r\n");
  // A later edit elsewhere must not disturb where the undo puts them back.
  act(() => view.dispatch({ changes: { from: 0, insert: "z" }, userEvent: "input.type" }));
  act(() => undoAsUser(viewOf()));
  act(() => undoAsUser(viewOf()));
  expect(content()).toBe(original);
  const event = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "historyRedo" });
  act(() => viewOf().contentDOM.dispatchEvent(event));
  expect(content()).toBe("a\r\nd\r\n");
});

it("restores the right breaks when quick deletes across an empty line are undone as one step", () => {
  const original = "a\r\n\nb\rc\r\n";
  const view = mount("mixed.md", original);
  // Two Delete presses at the end of line 1, close enough for history to group:
  // the first removes the CRLF after "a", the second the LF after the empty line.
  const end = view.state.doc.line(1).to;
  act(() => view.dispatch({ changes: { from: end, to: end + 1 }, userEvent: "delete.forward" }));
  expect(content()).toBe("a\nb\rc\r\n");
  act(() => viewOf().dispatch({ changes: { from: end, to: end + 1 }, userEvent: "delete.forward" }));
  expect(content()).toBe("ab\rc\r\n");
  act(() => undoAsUser(viewOf()));
  expect(content()).toBe(original);
});

it("restores the right breaks when quick backspaces across an empty line are undone as one step", () => {
  const original = "a\r\n\nb\rc\r\n";
  const view = mount("mixed.md", original);
  const start = view.state.doc.line(3).from;
  act(() => view.dispatch({ changes: { from: start - 1, to: start }, userEvent: "delete.backward" }));
  act(() => viewOf().dispatch({ changes: { from: start - 2, to: start - 1 }, userEvent: "delete.backward" }));
  expect(content()).toBe("ab\rc\r\n");
  act(() => undoAsUser(viewOf()));
  expect(content()).toBe(original);
});
