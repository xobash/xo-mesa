// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "codemirror";
import { Editor } from "./Editor";
import { useAppStore } from "../store";
import { activeEditorCommands } from "../lib/editorCommands";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const initial = useAppStore.getState();
const edits = vi.fn();

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  edits.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useAppStore.setState(initial, true);
});

function mount(text: string, state: "ready" | "failed" = "ready"): EditorView {
  act(() => {
    useAppStore.setState({
      vaultPath: "/vault",
      activePath: "Note.md",
      content: text,
      activeContentState: state,
      setContentFromEditor: edits,
    });
  });
  act(() => root.render(<Editor />));
  const view = EditorView.findFromDOM(host.querySelector(".cm-content") as HTMLElement);
  if (!view) throw new Error("editor view did not mount");
  return view;
}

const findButton = () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Find")!;

describe("in-note find and replace", () => {
  it("opens the search panel with a replace field from the toolbar", () => {
    mount("alpha beta alpha");
    act(() => findButton().click());
    expect(host.querySelector(".cm-panels-top .cm-search")).not.toBeNull();
    expect(host.querySelector('.cm-search input[name="search"]')).not.toBeNull();
    expect(host.querySelector('.cm-search input[name="replace"]')).not.toBeNull();
  });

  it("replace all edits the note through the normal save path", () => {
    mount("alpha beta alpha");
    act(() => findButton().click());
    const field = (name: string) => host.querySelector<HTMLInputElement>(`.cm-search input[name="${name}"]`)!;
    act(() => {
      field("search").value = "alpha";
      field("search").dispatchEvent(new Event("change", { bubbles: true }));
      field("replace").value = "gamma";
      field("replace").dispatchEvent(new Event("change", { bubbles: true }));
    });
    const replaceAll = host.querySelector<HTMLButtonElement>('.cm-search button[name="replaceAll"]')!;
    act(() => replaceAll.click());
    expect(edits).toHaveBeenLastCalledWith("gamma beta gamma", expect.anything());
  });

  it("disables Find while the note is not readable", () => {
    mount("", "failed");
    expect(findButton().disabled).toBe(true);
  });
});

describe("editor command bridge", () => {
  it("inserts text at the selection and reports the open document", () => {
    const view = mount("Hello world");
    act(() => view.dispatch({ selection: { anchor: 5 } }));
    const commands = activeEditorCommands();
    expect(commands?.path()).toBe("Note.md");
    let inserted = false;
    act(() => { inserted = commands!.insertText(", dear"); });
    expect(inserted).toBe(true);
    expect(edits).toHaveBeenLastCalledWith("Hello, dear world", expect.anything());
  });

  it("refuses inserts into a read-only document", () => {
    mount("", "failed");
    expect(activeEditorCommands()?.insertText("x")).toBe(false);
    expect(edits).not.toHaveBeenCalled();
  });

  it("unregisters when the editor unmounts", () => {
    mount("text");
    act(() => root.unmount());
    expect(activeEditorCommands()).toBeNull();
    root = createRoot(host);
  });
});
