// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditorView } from "codemirror";
import { Editor } from "./Editor";
import { useAppStore } from "../store";

/**
 * UNDO MUST NEVER CROSS A DOCUMENT BOUNDARY.
 *
 * The editor view lives for the whole app session. Swapping documents must
 * stay outside undo history, so undo cannot write one note's text under
 * another note's path.
 */

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

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

function mountWithNote(path: string, text: string): EditorView {
  act(() => {
    useAppStore.setState({
      activePath: path,
      content: text,
      contentCache: { ...useAppStore.getState().contentCache, [path]: text },
    });
  });
  act(() => {
    root.render(<Editor />);
  });
  const cm = host.querySelector(".cm-content");
  const view = cm ? EditorView.findFromDOM(cm as HTMLElement) : null;
  if (!view) throw new Error("editor view did not mount");
  return view;
}

function switchToNote(path: string, text: string) {
  act(() => {
    useAppStore.setState({
      activePath: path,
      content: text,
      contentCache: { ...useAppStore.getState().contentCache, [path]: text },
    });
  });
}

const viewOf = (): EditorView => {
  const cm = host.querySelector(".cm-content");
  const view = cm ? EditorView.findFromDOM(cm as HTMLElement) : null;
  if (!view) throw new Error("editor view not found");
  return view;
};

function undoAsUser(view: EditorView): void {
  const event = new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    inputType: "historyUndo",
  });
  view.contentDOM.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
}

describe("editor undo document boundary", () => {
  it("sends change-range activity and does not scan a closed outline", () => {
    const body = "# Heading\n" + "ordinary prose\n".repeat(80_000);
    const view = mountWithNote("large.md", body);
    const originalSet = useAppStore.getState().setContentFromEditor;
    const calls: unknown[][] = [];
    useAppStore.setState({ setContentFromEditor: (...args) => { calls.push(args); originalSet(...args); } });
    const originalSplit = String.prototype.split;
    String.prototype.split = function (this: string, separator: string | RegExp, limit?: number) {
      if (String(this).length > 1_000_000) throw new Error("closed-outline scan");
      return (originalSplit as (this: string, separator: string | RegExp, limit?: number) => string[]).call(String(this), separator, limit);
    } as typeof String.prototype.split;
    try {
      act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "x" } }));
    } finally {
      String.prototype.split = originalSplit;
      useAppStore.setState({ setContentFromEditor: originalSet });
    }
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({ snippet: "x", tasksUnchanged: true });
  });
  it("undo after a note switch cannot revert to the previous note's text", () => {
    mountWithNote("a.md", "note A body");
    switchToNote("b.md", "note B body");
    const view = viewOf();
    expect(view.state.doc.toString()).toBe("note B body");

    // The corrupting keystroke: undo with no B-local edits.
    act(() => {
      undoAsUser(view);
    });

    expect(view.state.doc.toString()).toBe("note B body");
    const s = useAppStore.getState();
    expect(s.contentCache["b.md"]).toBe("note B body");
    expect(s.content).toBe("note B body");
  });

  it("undo still works within a note after switching", () => {
    mountWithNote("a.md", "alpha");
    switchToNote("b.md", "bravo");
    const view = viewOf();

    // A real user edit in note B...
    act(() => {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: " typed" },
        userEvent: "input.type",
      });
    });
    expect(useAppStore.getState().contentCache["b.md"]).toBe("bravo typed");

    // ...one undo reverts the edit, a second undo has nowhere further to go.
    act(() => {
      undoAsUser(view);
    });
    expect(view.state.doc.toString()).toBe("bravo");
    act(() => {
      undoAsUser(view);
    });
    expect(view.state.doc.toString()).toBe("bravo");
    expect(useAppStore.getState().contentCache["b.md"]).toBe("bravo");
  });

  it("a same-note external refresh is not undoable back to the stale text", () => {
    mountWithNote("a.md", "old on-disk text");
    // Watcher/agent refresh of the SAME note: content changes, path does not.
    switchToNote("a.md", "newer on-disk text");
    const view = viewOf();
    expect(view.state.doc.toString()).toBe("newer on-disk text");

    act(() => {
      undoAsUser(view);
    });

    // Undoing must not resurrect the stale pre-refresh text — saving that
    // would overwrite the newer file (the watcher data-loss class).
    expect(view.state.doc.toString()).toBe("newer on-disk text");
    expect(useAppStore.getState().contentCache["a.md"]).toBe("newer on-disk text");
  });
});

it("reopens externally changed text and types only into the current revision", () => {
  const view = mountWithNote("a.md", "original");
  act(() => view.dispatch({ changes: { from: 8, insert: " local" } }));
  switchToNote("b.md", "bravo");
  switchToNote("a.md", "external replacement");
  expect(view.state.doc.toString()).toBe("external replacement");
  act(() => undoAsUser(view));
  expect(view.state.doc.toString()).toBe("external replacement");
  act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "!" } }));
  expect(useAppStore.getState().contentCache["a.md"]).toBe("external replacement!");
});

it("retains history and selection when a revisited document is unchanged", () => {
  const view = mountWithNote("a.md", "alpha");
  act(() => view.dispatch({ changes: { from: 5, insert: "!" }, selection: { anchor: 3 } }));
  switchToNote("b.md", "bravo");
  switchToNote("a.md", "alpha!");
  expect(view.state.selection.main.anchor).toBe(3);
  act(() => undoAsUser(view));
  expect(view.state.doc.toString()).toBe("alpha");
});

it("drops old edit history after an external replacement of the active note", () => {
  const view = mountWithNote("a.md", "alpha");
  act(() => view.dispatch({ changes: { from: 5, insert: "!" } }));
  switchToNote("a.md", "new disk body");
  act(() => undoAsUser(view));
  expect(view.state.doc.toString()).toBe("new disk body");
});

it("isolates identical note paths and text across vaults", () => {
  act(() => useAppStore.setState({ vaultPath: "/first" }));
  const view = mountWithNote("a.md", "alpha");
  act(() => view.dispatch({ changes: { from: 5, insert: "!" } }));
  act(() => useAppStore.setState({ vaultPath: "/second", content: "alpha!" }));
  act(() => undoAsUser(view));
  expect(view.state.doc.toString()).toBe("alpha!");
  switchToNote("b.md", "bravo");
  switchToNote("a.md", "second vault update");
  expect(view.state.doc.toString()).toBe("second vault update");
});
