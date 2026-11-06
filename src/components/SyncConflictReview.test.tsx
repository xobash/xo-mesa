// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VaultFile } from "../types";
import { useAppStore } from "../store";
import { SyncConflictReview } from "./SyncConflictReview";

const reads = vi.hoisted(() => ({ text: new Map<string, string>(), calls: [] as string[] }));
vi.mock("../lib/vault", async (original) => ({
  ...(await original<typeof import("../lib/vault")>()),
  readReviewText: async (file: VaultFile) => {
    reads.calls.push(file.relPath);
    const text = reads.text.get(file.relPath);
    if (text === undefined) throw new Error(`unreadable ${file.relPath}`);
    return text;
  },
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const initial = useAppStore.getState();
let host: HTMLDivElement;
let root: Root;
const file = (relPath: string, size?: number): VaultFile => {
  const ext = relPath.split(".").pop() ?? "";
  return { path: `/vault/${relPath}`, relPath, name: relPath, ext, isMarkdown: ext === "md", size };
};
const copyOf = (rel: string, peer = "Laptop", date = "2026-10-20") => rel.replace(/(\.[^.]*)$/, ` (conflict from ${peer} ${date})$1`);
const actions = () => ({
  flushSave: vi.fn(async () => true),
  saveConflictReview: vi.fn(async () => "Saved reviewed text. The previous original was kept."),
  setSyncOpen: vi.fn(),
  openFile: vi.fn(async () => undefined),
});
let store: ReturnType<typeof actions>;

function render(files: VaultFile[], vaultPath = "/vault") {
  act(() => {
    useAppStore.setState({ files, vaultPath, syncBusy: false, ...store } as never);
    root.render(<SyncConflictReview />);
  });
}
const button = (name: string) => {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent === name || b.getAttribute("aria-label") === name);
  expect(found, name).toBeDefined();
  return found!;
};
const click = async (name: string) => { await act(async () => { button(name).click(); }); };
const status = () => host.querySelector('[role="status"]')?.textContent ?? "";
const textareas = () => [...host.querySelectorAll("textarea")] as HTMLTextAreaElement[];

beforeEach(() => {
  reads.text.clear();
  reads.calls = [];
  store = actions();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useAppStore.setState(initial, true);
});

it("renders nothing when the vault has no conflict copies", () => {
  render([file("Note.md"), file("Other.md")]);
  expect(host.innerHTML).toBe("");
});

it("lists conflict copies ten at a page with their peer and date", async () => {
  const files = Array.from({ length: 12 }, (_, i) => [file(`Note ${String(i).padStart(2, "0")}.md`), file(copyOf(`Note ${String(i).padStart(2, "0")}.md`))]).flat();
  render(files);
  expect(host.textContent).toContain("Review conflict copies (12)");
  expect(host.querySelectorAll(".sync-conflict-row strong")).toHaveLength(10);
  expect(host.textContent).toContain("Copy from Laptop · 2026-10-20");
  expect(host.textContent).toContain("1–10 of 12");
  expect(button("Previous copies").disabled).toBe(true);
  await click("Next copies");
  expect(host.textContent).toContain("11–12 of 12");
  expect(host.querySelectorAll(".sync-conflict-row strong")).toHaveLength(2);
  expect(button("Next copies").disabled).toBe(true);
});

it("compares both copies, applies one change and saves the reviewed text", async () => {
  const copy = copyOf("Note.md");
  reads.text.set("Note.md", "title\nmine\nend\n");
  reads.text.set(copy, "title\ntheirs\nend\n");
  render([file("Note.md"), file(copy)]);
  await click(`Compare ${copy}`);
  expect(store.flushSave).toHaveBeenCalledOnce();
  expect(reads.calls.sort()).toEqual([copy, "Note.md"].sort());
  const [original, other, draft] = textareas();
  expect(original.value).toBe("title\nmine\nend\n");
  expect(other.value).toBe("title\ntheirs\nend\n");
  expect(draft.value).toBe("title\nmine\nend\n");
  expect(document.activeElement).toBe(draft);
  expect(host.querySelector(".sync-diff-original")?.textContent).toBe("mine\n");
  expect(host.querySelector(".sync-diff-other")?.textContent).toBe("theirs\n");

  await click("Use conflict for this change");
  expect(textareas()[2].value).toBe("title\ntheirs\nend\n");
  await click("Save reviewed text");
  expect(store.saveConflictReview).toHaveBeenCalledWith("/vault", "Note.md", "title\nmine\nend\n", "title\ntheirs\nend\n", copy);
  expect(status()).toBe("Saved reviewed text. The previous original was kept.");
  expect(textareas()).toHaveLength(0);
  expect(document.activeElement).toBe(button(`Compare ${copy}`));
});

it("says plainly when two copies differ only in line endings", async () => {
  const copy = copyOf("Note.md");
  reads.text.set("Note.md", "title\r\nbody\r\n");
  reads.text.set(copy, "title\nbody\n");
  render([file("Note.md"), file(copy)]);
  await click(`Compare ${copy}`);
  expect(host.querySelectorAll(".sync-diff-change")).toHaveLength(0);
  const note = host.querySelector(".sync-diff-eol")?.textContent ?? "";
  expect(note).toContain("Only the line endings differ");
  expect(note).toContain("CRLF (Windows)");
  expect(note).toContain("LF (macOS and Linux)");
  expect(note).toContain("2 lines");
});

it("notes line-ending-only lines next to real changes and keeps the draft's endings", async () => {
  const copy = copyOf("Note.md");
  reads.text.set("Note.md", "title\r\nmine\r\nend\r\n");
  reads.text.set(copy, "title\ntheirs\nend\n");
  render([file("Note.md"), file(copy)]);
  await click(`Compare ${copy}`);
  expect(host.querySelectorAll(".sync-diff-change")).toHaveLength(1);
  const note = host.querySelector(".sync-diff-eol")?.textContent ?? "";
  expect(note).toContain("2 lines differ only in their line endings");
  expect(note).not.toContain("Only the line endings differ");
  await click("Use conflict for this change");
  await click("Save reviewed text");
  expect(store.saveConflictReview).toHaveBeenCalledWith("/vault", "Note.md", "title\r\nmine\r\nend\r\n", "title\r\ntheirs\r\nend\r\n", copy);
});

it("keeps CRLF line endings when the reviewed text is typed in", async () => {
  const copy = copyOf("Note.md");
  reads.text.set("Note.md", "a\r\nb\nc\r\n");
  reads.text.set(copy, "a\r\nx\nc\r\n");
  render([file("Note.md"), file(copy)]);
  await click(`Compare ${copy}`);
  const draft = textareas()[2];
  // A textarea reports its value with LF breaks only.
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(draft, "a\nB\nc\n");
    draft.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Save reviewed text");
  expect(store.saveConflictReview).toHaveBeenCalledWith("/vault", "Note.md", "a\r\nb\nc\r\n", "a\r\nB\nc\r\n", copy);
});

it("shows the reviewed text with LF breaks so React never rewrites the field under the caret", async () => {
  // A textarea's value is always LF. Handing React a CRLF value makes it
  // reassign the DOM value on every render, which moves the caret to the end.
  const writes: string[] = [];
  const readOnlyWrites: string[] = [];
  const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!;
  Object.defineProperty(HTMLTextAreaElement.prototype, "value", {
    configurable: true,
    get: descriptor.get,
    set(this: HTMLTextAreaElement, value: string) {
      if (this.closest("label")?.textContent?.startsWith("Reviewed text")) writes.push(value);
      else readOnlyWrites.push(value);
      descriptor.set!.call(this, value);
    },
  });
  try {
    const copy = copyOf("Note.md");
    reads.text.set("Note.md", "a\r\nb\r\n");
    reads.text.set(copy, "a\r\nc\r\n");
    render([file("Note.md"), file(copy)]);
    await click(`Compare ${copy}`);
    expect(writes.every((value) => !value.includes("\r"))).toBe(true);
    const draft = textareas()[2];
    writes.length = 0;
    readOnlyWrites.length = 0;
    await act(async () => {
      descriptor.set!.call(draft, "a\nbx\n");
      draft.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // The user's own value stands; React writes nothing different back.
    expect(writes.filter((value) => value !== "a\nbx\n")).toEqual([]);
    // Nor does it reset the read-only copies (and any selection in them).
    expect(readOnlyWrites).toEqual([]);
    await click("Save reviewed text");
    expect(store.saveConflictReview).toHaveBeenCalledWith("/vault", "Note.md", "a\r\nb\r\n", "a\r\nbx\r\n", copy);
  } finally {
    Object.defineProperty(HTMLTextAreaElement.prototype, "value", descriptor);
  }
});

it("keeps both copies without writing, and reports a failed save", async () => {
  const copy = copyOf("Note.md");
  reads.text.set("Note.md", "a\n");
  reads.text.set(copy, "b\n");
  render([file("Note.md"), file(copy)]);
  await click(`Compare ${copy}`);
  await click("Keep both");
  expect(status()).toBe("Both copies kept. No files changed.");
  expect(store.saveConflictReview).not.toHaveBeenCalled();

  store.saveConflictReview.mockRejectedValueOnce(new Error("disk changed"));
  await click(`Compare ${copy}`);
  await click("Use conflict text");
  await click("Save reviewed text");
  expect(status()).toBe("Review not saved: Error: disk changed");
  expect(textareas()).toHaveLength(3);
});

it("refuses inline review for other formats and files over 1 MiB without reading them", async () => {
  const pdfCopy = copyOf("Paper.pdf");
  const bigCopy = copyOf("Big.md");
  render([file("Paper.pdf"), file(pdfCopy), file("Big.md", 2 * 1024 * 1024), file(bigCopy)]);
  for (const copy of [pdfCopy, bigCopy]) {
    await click(`Compare ${copy}`);
    expect(status()).toContain("Inline merging is limited to Markdown and plain text up to 1 MiB.");
  }
  expect(reads.calls).toEqual([]);
  expect(store.flushSave).not.toHaveBeenCalled();
});

it("reports an unreadable copy and keeps the files untouched", async () => {
  const copy = copyOf("Note.md");
  reads.text.set("Note.md", "a\n");
  render([file("Note.md"), file(copy)]);
  await click(`Compare ${copy}`);
  expect(status()).toBe(`Error: unreadable ${copy}`);
  expect(textareas()).toHaveLength(0);
});

it("opens either copy in the workspace and closes Sync", async () => {
  const copy = copyOf("Note.md");
  render([file("Note.md"), file(copy)]);
  await click("Open original");
  await click("Open copy");
  expect(store.setSyncOpen).toHaveBeenCalledWith(false);
  expect(store.openFile.mock.calls).toEqual([["Note.md"], [copy]]);
});

it("drops an open review when the vault changes", async () => {
  const copy = copyOf("Note.md");
  reads.text.set("Note.md", "a\n");
  reads.text.set(copy, "b\n");
  render([file("Note.md"), file(copy)]);
  await click(`Compare ${copy}`);
  expect(textareas()).toHaveLength(3);
  render([file("Note.md"), file(copy)], "/other-vault");
  expect(textareas()).toHaveLength(0);
  expect(status()).toBe("");
});
