// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Backlinks } from "./Backlinks";
import { useAppStore } from "../store";
import type { NoteMeta } from "../types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const initial = useAppStore.getState();
const meta = (relPath: string, title: string, rawLinks: string[] = []): NoteMeta => ({ relPath, title, rawLinks, tags: [], aliases: [] });

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  useAppStore.setState({
    activePath: "Alpha.md",
    indexingTextFiles: 0,
    notes: {
      "Alpha.md": meta("Alpha.md", "Alpha"),
      "Linked.md": meta("Linked.md", "Linked", ["Alpha"]),
      "Mentions.md": meta("Mentions.md", "Mentions"),
      "Unread.md": meta("Unread.md", "Unread"),
    },
    contentCache: { "Alpha.md": "# Alpha", "Linked.md": "[[Alpha]] and Alpha", "Mentions.md": "The alpha plan." },
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useAppStore.setState(initial, true);
});

const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(label))!;

it("keeps unlinked mentions collapsed until asked, then lists only notes that do not link", async () => {
  act(() => root.render(<Backlinks />));
  expect(host.querySelector(".backlinks-title")?.textContent).toBe("Linked mentions 1");
  expect(host.querySelector(".unlinked-mention")).toBeNull();
  const toggle = button("Unlinked mentions");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  act(() => toggle.click());
  await vi.waitFor(() => expect(host.querySelectorAll(".unlinked-mention")).toHaveLength(1));
  expect(host.querySelector(".unlinked-mention-open")?.textContent).toBe("Mentions");
  expect(host.querySelector(".unlinked-mention mark")?.textContent).toBe("alpha");
  expect(host.textContent).toContain("1 notes are not indexed yet");
});

it("links a mention through the store and rescans", async () => {
  const link = vi.fn(async () => {
    useAppStore.setState({ contentCache: { ...useAppStore.getState().contentCache, "Mentions.md": "The [[Alpha|alpha]] plan." } });
    return true;
  });
  useAppStore.setState({ linkUnlinkedMention: link });
  act(() => root.render(<Backlinks />));
  act(() => button("Unlinked mentions").click());
  await vi.waitFor(() => expect(host.querySelector(".unlinked-mention")).not.toBeNull());
  await act(async () => host.querySelector<HTMLButtonElement>(".unlinked-mention .seg-btn")!.click());
  expect(link).toHaveBeenCalledWith("Mentions.md", expect.objectContaining({ start: 4, end: 9, text: "alpha" }), "Alpha.md");
  await vi.waitFor(() => expect(host.textContent).toContain("No other note mentions Alpha without a link."));
  expect(host.querySelector(".unlinked-mention")).toBeNull();
});
