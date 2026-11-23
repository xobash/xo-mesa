// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildDeck, SLIDE1_TITLE, NOTES_TEXT } from "../lib/pptx/fixtures/pptxFixtures";
import { openOoxmlPackage } from "../lib/ooxml/ooxmlPackage";
import { readZipContainer } from "../lib/ooxml/zipContainer";

const disk = vi.hoisted(() => ({ bytes: new Uint8Array() as Uint8Array<ArrayBufferLike>, saves: [] as Array<{ bytes: Uint8Array; expected: Uint8Array | null }>, copies: [] as Array<{ rel: string; options: unknown }>, gate: null as Promise<void> | null }));
vi.mock("../lib/documentBytesSave", () => ({
  DocumentChangedOnDiskError: class extends Error {},
  readDocumentBytes: async () => disk.bytes,
  saveDocumentBytes: async ({ bytes, expected, validate }: { bytes: Uint8Array; expected: Uint8Array | null; validate?: (b: Uint8Array) => void }) => {
    if (disk.gate) await disk.gate;
    await validate?.(bytes);
    disk.saves.push({ bytes, expected });
    disk.bytes = bytes;
  },
}));
vi.mock("../lib/vault", () => ({
  writeVaultBinaryFile: async (_root: string, rel: string, _bytes: Uint8Array, options: unknown) => { disk.copies.push({ rel, options }); },
}));
vi.mock("../lib/confirmAction", () => ({ confirmAction: async () => true }));
vi.mock("../store", () => ({
  getStore: () => ({ vaultPath: "/vault", files: [{ relPath: "Deck.pptx" }], registerVaultFile: async () => {} }),
}));
import { PresentationView } from "./PresentationView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement("div");
let root: ReturnType<typeof createRoot>;
const file = (ext = "pptx", mtime = 1) => ({ path: `/vault/Deck.${ext}`, relPath: `Deck.${ext}`, name: "Deck", ext, mtime, size: 1, isMarkdown: false });
const decoder = new TextDecoder();

beforeEach(() => {
  disk.bytes = buildDeck();
  disk.gate = null;
  disk.saves = [];
  disk.copies = [];
  URL.createObjectURL = vi.fn(() => "blob:mesa-test");
  URL.revokeObjectURL = vi.fn();
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.replaceChildren(); });

const button = (label: string) => Array.from(host.querySelectorAll("button")).find((b) => b.textContent === label)!;

function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => { setter.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
}

async function openEditor(onDirty = vi.fn(), ext = "pptx") {
  await act(async () => root.render(<PresentationView file={file(ext)} editable onDirtyChange={onDirty} />));
  await vi.waitFor(() => expect(host.querySelector('[data-testid="pptx-view"]')).not.toBeNull());
  return onDirty;
}

it("opens read-only with slide thumbnails, hidden markers and speaker notes", async () => {
  await openEditor();
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(4);
  expect(host.querySelector(".pptx-thumb.is-hidden .pptx-hidden-tag")?.textContent).toBe("Hidden");
  expect(host.querySelector(".pptx-main")?.textContent).toContain(SLIDE1_TITLE);
  expect(host.querySelector(".pptx-notes")?.textContent).toContain(NOTES_TEXT);
  expect(host.querySelector("textarea")).toBeNull();
  expect(button("Edit").disabled).toBe(false);
});

it("edits a text box after an explicit Edit, reports dirty state and saves only that slide against the opened bytes", async () => {
  const opened = disk.bytes;
  const onDirty = await openEditor();
  act(() => button("Edit").click());
  const title = Array.from(host.querySelectorAll<HTMLElement>(".pptx-main .pptx-shape.is-editable")).find((el) => el.textContent === SLIDE1_TITLE)!;
  act(() => title.click());
  type(host.querySelector<HTMLTextAreaElement>(".pptx-field textarea")!, "Annual review");
  expect(host.textContent).toContain("Unsaved changes");
  expect(onDirty).toHaveBeenLastCalledWith(true);
  await act(async () => button("Save").click());
  await vi.waitFor(() => expect(disk.saves).toHaveLength(1));
  expect(disk.saves[0].expected).toBe(opened);
  const before = openOoxmlPackage(opened);
  const after = openOoxmlPackage(disk.saves[0].bytes);
  const changed = [...before.parts].filter(([name, bytes]) => decoder.decode(after.parts.get(name)!) !== decoder.decode(bytes)).map(([name]) => name);
  expect(changed).toEqual(["ppt/slides/slide1.xml"]);
  await vi.waitFor(() => expect(onDirty).toHaveBeenLastCalledWith(false));
});

it("typing the original text back is clean and Save stays off", async () => {
  await openEditor();
  act(() => button("Edit").click());
  const notes = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Speaker notes"]')!;
  type(notes, "Changed");
  expect(button("Save").disabled).toBe(false);
  type(notes, NOTES_TEXT);
  expect(button("Save").disabled).toBe(true);
  expect(host.textContent).not.toContain("Unsaved changes");
});

it("keeps edits and blocks Save when the file changes on disk, while Save as copy writes a new file", async () => {
  await openEditor();
  act(() => button("Edit").click());
  act(() => button("Move down").click());
  disk.bytes = buildDeck({ "docProps/extra.xml": "<x/>" });
  await act(async () => root.render(<PresentationView file={file("pptx", 2)} editable onDirtyChange={vi.fn()} />));
  await vi.waitFor(() => expect(host.textContent).toContain("changed on disk"));
  expect(button("Save").disabled).toBe(true);
  expect(host.textContent).toContain("Unsaved changes");
  await act(async () => button("Save as copy").click());
  await vi.waitFor(() => expect(disk.copies).toEqual([{ rel: "Deck copy.pptx", options: { expectedMissing: true } }]));
  expect(disk.saves).toHaveLength(0);
});

it("keeps macro-enabled presentations read-only with the reason", async () => {
  await openEditor(vi.fn(), "pptm");
  expect(button("Edit").disabled).toBe(true);
  expect(host.textContent).toContain("Read-only: It contains macros");
});

it("refuses an edit it cannot make with a visible reason and changes nothing", async () => {
  await openEditor();
  act(() => button("Edit").click());
  act(() => (host.querySelectorAll<HTMLElement>('[role="option"]')[2]).click());
  act(() => button("Duplicate").click());
  expect(host.querySelector(".pdf-status")?.textContent).toMatch(/chart part/);
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(4);
  expect(button("Save").disabled).toBe(true);
});

it("decodes thumbnail pictures only near the visible list", async () => {
  const observed: Array<{ callback: IntersectionObserverCallback; targets: Element[] }> = [];
  vi.stubGlobal("IntersectionObserver", class {
    targets: Element[] = [];
    constructor(callback: IntersectionObserverCallback) { observed.push({ callback, targets: this.targets }); }
    observe(target: Element) { this.targets.push(target); }
    disconnect() { this.targets.length = 0; }
  });
  try {
    await openEditor();
    expect(URL.createObjectURL).not.toHaveBeenCalled(); // no thumbnail reported near yet
    const latest = observed[observed.length - 1];
    const thumb = latest.targets.find((el) => (el as HTMLElement).dataset.part === "ppt/slides/slide2.xml")!;
    act(() => latest.callback([{ target: thumb, isIntersecting: true } as unknown as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(host.querySelector("#pptx-thumb-1 img")).not.toBeNull();
    expect(host.querySelector("#pptx-thumb-2 img")).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("opens a deck whose picture fails its checksum and draws that picture as missing", async () => {
  const bytes = buildDeck();
  const entry = readZipContainer(bytes).entries.find((e) => e.name === "ppt/media/image1.png")!;
  const view = new DataView(bytes.buffer);
  view.setUint32(entry.localStart + 14, entry.crc ^ 1, true);
  view.setUint32(entry.centralStart + 16, entry.crc ^ 1, true);
  disk.bytes = bytes;
  await openEditor();
  act(() => host.querySelectorAll<HTMLElement>('[role="option"]')[1].click());
  expect(host.querySelector(".pptx-main .pptx-picture.pptx-missing")).not.toBeNull();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it("fits the main slide to its pane once the deck has loaded", async () => {
  // The pane mounts only after loading; an observer attached on the first
  // render never saw it, and a 300-slide deck kept a fixed 720 px slide that
  // overflowed a half-width pane and hid its left edge.
  const observed: Element[] = [];
  vi.stubGlobal("ResizeObserver", class {
    constructor(private readonly report: (entries: Array<{ contentRect: { width: number } }>) => void) {}
    observe(el: Element) { observed.push(el); this.report([{ contentRect: { width: 432 } }]); }
    disconnect() {}
  });
  await openEditor();
  await vi.waitFor(() => expect(host.querySelector<HTMLElement>(".pptx-main .pptx-slide-frame")?.style.width).toBe("400px"));
  expect(observed).toContain(host.querySelector(".pptx-main"));
  vi.unstubAllGlobals();
});

it("refuses typing while a save writes instead of dropping it when the saved deck is adopted", async () => {
  await openEditor();
  act(() => button("Edit").click());
  const notes = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Speaker notes"]')!;
  type(notes(), "Saved notes");
  let release!: () => void;
  disk.gate = new Promise<void>((resolve) => { release = resolve; });
  await act(async () => button("Save").click());
  type(notes(), "Typed during save");
  expect(host.textContent).toContain("Mesa is saving");
  await act(async () => { release(); });
  await vi.waitFor(() => expect(disk.saves).toHaveLength(1));
  disk.gate = null;
});
