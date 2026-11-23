// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TableEditor } from "./TableEditor";

/**
 * CSV/TSV TABLE EDITS CHANGE ONLY WHAT THE USER CHANGED.
 *
 * The grid edits cells, rows and columns. Rows nobody touched keep their exact
 * bytes; an edit that leaves a value unchanged writes nothing.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** Feeds each change back as the new text, as the store does. */
function Harness({ initial, readOnlyReason, delimiter, onChange }: { initial: string; readOnlyReason: string | null; delimiter: string; onChange: (text: string) => void }) {
  const [text, setText] = useState(initial);
  return <TableEditor text={text} delimiter={delimiter} readOnlyReason={readOnlyReason} onChange={(next) => { onChange(next); setText(next); }} />;
}

function mount(text: string, readOnlyReason: string | null = null, delimiter = ",") {
  const onChange = vi.fn();
  act(() => root.render(<Harness initial={text} delimiter={delimiter} readOnlyReason={readOnlyReason} onChange={onChange} />));
  return onChange;
}

const cells = () => [...host.querySelectorAll<HTMLElement>('[role="gridcell"]')];
const cell = (text: string) => cells().find((el) => el.textContent === text)!;
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label)!;
const grid = () => host.querySelector<HTMLElement>('[role="grid"]')!;
const key = (target: Element, k: string, init: KeyboardEventInit = {}) =>
  act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init })); });

function typeInto(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("edits one cell and keeps every other row's bytes", () => {
  const source = '"id" ,name\r\n1,"Ann"\r\n2,Bob\n';
  const onChange = mount(source);
  act(() => cell("Bob").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
  typeInto(input, 'Bob, "Jr"');
  key(input, "Enter");
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenLastCalledWith('"id" ,name\r\n1,"Ann"\r\n2,"Bob, ""Jr"""\n');
});

it("writes nothing when a cell is opened and committed unchanged, or cancelled", () => {
  const onChange = mount("a,b\n1,2\n");
  act(() => cell("2").click());
  key(grid(), "Enter");
  key(host.querySelector("textarea")!, "Enter");
  act(() => cell("1").click());
  key(grid(), "F2");
  const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
  typeInto(input, "changed");
  key(input, "Escape");
  expect(onChange).not.toHaveBeenCalled();
  expect(cell("1")).toBeDefined();
});

it("adds and deletes rows and columns, and undoes the last change", () => {
  const onChange = mount("a,b\n1,2");
  act(() => cell("a").click());
  act(() => button("Add row").click());
  expect(onChange).toHaveBeenLastCalledWith("a,b\n,\n1,2");
  act(() => button("Undo").click());
  expect(onChange).toHaveBeenLastCalledWith("a,b\n1,2");
  act(() => cell("b").click());
  act(() => button("Delete column").click());
  expect(onChange).toHaveBeenLastCalledWith("a\n1");
  act(() => cell("1").click());
  act(() => button("Delete row").click());
  expect(onChange).toHaveBeenLastCalledWith("a");
});

it("shows why a table is read-only and refuses edits", () => {
  const onChange = mount("a,b\n", "this file is not valid UTF-8, so saving could corrupt it.");
  expect(host.textContent).toContain("Read-only: this file is not valid UTF-8");
  expect(button("Add row").disabled).toBe(true);
  act(() => cell("a").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(host.querySelector("textarea")).toBeNull();
  key(grid(), "Delete");
  expect(onChange).not.toHaveBeenCalled();
});

it("renders only the visible rows of a large file", () => {
  mount("x\ty\n".repeat(100_000), null, "\t");
  expect(host.textContent).toContain("100000 rows × 2 columns");
  expect(host.querySelectorAll('[role="row"]').length).toBeLessThan(120);
});

it("puts the caret after the value when a cell edit starts", () => {
  mount("a,b\n1,25\n");
  act(() => cell("25").click());
  key(grid(), "Enter");
  const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
  // WebKit focuses a new textarea with the caret at the start; typing then
  // prepended ("5" + "7" → "75" in the native app).
  input.setSelectionRange(0, 0);
  act(() => { input.dispatchEvent(new FocusEvent("focus")); input.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 2]);
});
