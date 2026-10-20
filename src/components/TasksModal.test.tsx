// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { TasksPanel } from "./TasksModal";
import { useAppStore } from "../store";

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

it("pages large task groups in list and board without losing access to later tasks", () => {
  const content = Array.from({ length: 120 }, (_, i) => `- [ ] Task ${i + 1}`).join("\n");
  act(() => {
    useAppStore.setState({
      notes: { "work.md": { relPath: "work.md", title: "Work", rawLinks: [], tags: [], aliases: [] } },
      contentCache: { "work.md": content },
    });
    root.render(<TasksPanel />);
  });

  expect(host.querySelectorAll(".task-row")).toHaveLength(50);
  expect(host.textContent).toContain("120 open");
  act(() => (Array.from(host.querySelectorAll(".seg-btn")) as HTMLButtonElement[])
    .find((button) => button.textContent === "Board")!.click());
  expect(host.querySelectorAll(".kanban-card")).toHaveLength(50);
  act(() => (Array.from(host.querySelectorAll(".seg-btn")) as HTMLButtonElement[])
    .find((button) => button.textContent === "List")!.click());
  act(() => (host.querySelector(".task-more") as HTMLButtonElement).click());
  expect(host.querySelectorAll(".task-row")).toHaveLength(100);
  act(() => (host.querySelector(".task-more") as HTMLButtonElement).click());
  expect(host.querySelectorAll(".task-row")).toHaveLength(120);

  act(() => (Array.from(host.querySelectorAll(".seg-btn")) as HTMLButtonElement[])
    .find((button) => button.textContent === "Board")!.click());
  expect(host.querySelectorAll(".kanban-card")).toHaveLength(120);
});

it("keeps the typed task until the store reports it was added", async () => {
  const results: Array<(added: boolean) => void> = [];
  act(() => {
    useAppStore.setState({
      addPersonalTask: (() => new Promise<boolean>((resolve) => results.push(resolve))) as never,
    });
    root.render(<TasksPanel />);
  });
  const input = host.querySelector(".task-add input") as HTMLInputElement;
  const type = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const submit = () => act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });

  type("Call the plumber");
  submit();
  expect(input.value).toBe("Call the plumber");
  await act(async () => results[0](false));
  expect(input.value).toBe("Call the plumber");

  submit();
  await act(async () => results[1](true));
  expect(input.value).toBe("");
  expect(results).toHaveLength(2);
});
