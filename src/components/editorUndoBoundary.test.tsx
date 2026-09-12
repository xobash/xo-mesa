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
 * The editor view lives for the whole app session and notes are swapped into
 * it. Before the fix, the swap was one big undoable replace transaction: after
 * switching from note A to note B, one extra Cmd+Z reverted the SWAP — the
 * editor showed A's text under B's path, the revert registered as a user edit,
 * `contentCache[B]` became A's text, and the debounced save then wrote note
 * A's content over note B on disk. Silent cross-file corruption from three
 * ordinary actions (open, switch, undo). Reproduced against the real vault
 * through the QA harness before this fix; these tests pin the boundary.
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
