// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildOdp, buildOds, buildOdt } from "../lib/odf/fixtures/odfFixtures";

const disk = vi.hoisted(() => ({ bytes: new Uint8Array() as Uint8Array<ArrayBufferLike>, saves: [] as Array<{ bytes: Uint8Array; expected: Uint8Array | null }> }));
const confirm = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../lib/documentBytesSave", () => ({
  DocumentChangedOnDiskError: class extends Error {},
  readDocumentBytes: async () => disk.bytes,
  saveDocumentBytes: async ({ bytes, expected, validate }: { bytes: Uint8Array; expected: Uint8Array | null; validate?: (b: Uint8Array) => void }) => {
    await validate?.(bytes);
    disk.saves.push({ bytes, expected });
    disk.bytes = bytes;
  },
}));
vi.mock("../lib/vault", () => ({ writeVaultBinaryFile: async () => {} }));
vi.mock("../lib/confirmAction", () => ({ confirmAction: async (message: string) => { confirm.calls.push(message); return true; } }));
vi.mock("../store", () => ({ getStore: () => ({ vaultPath: "/vault", files: [], registerVaultFile: async () => {} }), useAppStore: () => null }));
vi.mock("./FileFallbackView", () => ({ FileFallbackView: () => <div>details view</div> }));
import { OpenDocumentView } from "./OpenDocumentView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement("div");
let root: ReturnType<typeof createRoot>;
const file = (ext: string) => ({ path: `/vault/Doc.${ext}`, relPath: `Doc.${ext}`, name: "Doc", ext, mtime: 1, size: 1, isMarkdown: false });

beforeEach(() => {
  disk.saves = [];
  confirm.calls = [];
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
async function open(ext: string, bytes: Uint8Array, testId: string, onDirty = vi.fn()) {
  disk.bytes = bytes;
  await act(async () => root.render(<OpenDocumentView file={file(ext)} editable onDirtyChange={onDirty} />));
  await vi.waitFor(() => expect(host.querySelector(`[data-testid="${testId}"]`)).not.toBeNull());
  return onDirty;
}
function changedEntries(before: Uint8Array, after: Uint8Array): string[] {
  const a = unzipSync(before);
  const b = unzipSync(after);
  return Object.keys(a).filter((name) => strFromU8(a[name]) !== strFromU8(b[name]));
}

it("opens text read-only, edits a paragraph after Edit, and saves only content.xml against the opened bytes", async () => {
  const opened = buildOdt();
  const onDirty = await open("odt", opened, "odt-view");
  expect(host.querySelector("h1")?.textContent).toBe("Report title");
  expect(host.querySelector("textarea")).toBeNull();
  act(() => button("Edit").click());
  act(() => host.querySelector<HTMLElement>("h1")!.click());
  const editorBox = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Paragraph text"]')!;
  // WebKit focuses the new box with the caret at the start; in the native app
  // typed text went in front of the paragraph.
  editorBox.setSelectionRange(0, 0);
  act(() => { editorBox.dispatchEvent(new FocusEvent("focus")); editorBox.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
  expect(editorBox.selectionStart).toBe(editorBox.value.length);
  type(editorBox, "Final report");
  expect(host.textContent).toContain("Unsaved changes");
  expect(onDirty).toHaveBeenLastCalledWith(true);
  await act(async () => button("Save").click());
  await vi.waitFor(() => expect(disk.saves).toHaveLength(1));
  expect(disk.saves[0].expected).toBe(opened);
  expect(changedEntries(opened, disk.saves[0].bytes)).toEqual(["content.xml"]);
  await vi.waitFor(() => expect(onDirty).toHaveBeenLastCalledWith(false));
  expect(host.querySelector("h1")?.textContent).toBe("Final report");
});

it("shows why a paragraph cannot be edited and keeps templates read-only", async () => {
  await open("odt", buildOdt(), "odt-view");
  act(() => button("Edit").click());
  const link = Array.from(host.querySelectorAll<HTMLElement>(".odt-para")).find((p) => p.textContent === "Visit the site.")!;
  act(() => link.click());
  expect(host.querySelector(".pptx-refusal")?.textContent).toMatch(/link/);
  act(() => root.unmount());
  root = createRoot(host);
  await open("ott", buildOdt(undefined, { mime: "application/vnd.oasis.opendocument.text-template" }), "odt-view");
  expect(button("Edit").disabled).toBe(true);
  expect(host.textContent).toContain("Read-only: It is a template.");
});

it("confirms the macro warning before saving", async () => {
  const opened = buildOdt(undefined, { extra: { "Basic/Standard/Module1.xml": "<x/>" } });
  await open("odt", opened, "odt-view");
  act(() => button("Edit").click());
  act(() => host.querySelector<HTMLElement>("h1")!.click());
  type(host.querySelector<HTMLTextAreaElement>("textarea")!, "Changed");
  await act(async () => button("Save").click());
  await vi.waitFor(() => expect(disk.saves).toHaveLength(1));
  expect(confirm.calls[0]).toMatch(/macros/);
});

it("edits a spreadsheet cell in the grid and saves only content.xml", async () => {
  const opened = buildOds();
  await open("ods", opened, "ods-view");
  const cell = (text: string) => Array.from(host.querySelectorAll<HTMLElement>('[role="gridcell"]')).find((el) => el.textContent === text)!;
  expect(cell("Name")).toBeDefined();
  act(() => button("Edit").click());
  await act(async () => cell("3").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  type(host.querySelector<HTMLTextAreaElement>("textarea")!, "7");
  await act(async () => { host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(cell("7")).toBeDefined();
  await act(async () => button("Save").click());
  await vi.waitFor(() => expect(disk.saves).toHaveLength(1));
  expect(changedEntries(opened, disk.saves[0].bytes)).toEqual(["content.xml"]);
  expect(strFromU8(unzipSync(disk.saves[0].bytes)["content.xml"])).toContain('office:value-type="float" office:value="7"><text:p>7</text:p>');
});

it("edits presentation notes and moves a slide", async () => {
  const opened = buildOdp();
  await open("odp", opened, "odp-view");
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(2);
  expect(host.querySelector(".pptx-notes")?.textContent).toContain("Speak slowly");
  act(() => button("Edit").click());
  type(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Speaker notes"]')!, "Speak clearly");
  act(() => button("Move down").click());
  expect(host.querySelector('[role="option"][aria-selected="true"] .pptx-thumb-number')?.textContent).toBe("2");
  await act(async () => button("Save").click());
  await vi.waitFor(() => expect(disk.saves).toHaveLength(1));
  const content = strFromU8(unzipSync(disk.saves[0].bytes)["content.xml"]);
  expect(content.indexOf('draw:name="page2"')).toBeLessThan(content.indexOf('draw:name="page1"'));
  expect(content).toContain("Speak clearly");
  expect(changedEntries(opened, disk.saves[0].bytes)).toEqual(["content.xml"]);
});

// The slide pane mounts only after the deck loads; an observer attached on
// the first render never saw it, so the main slide stayed 720 px wide.
it("fits the main presentation slide to its pane", async () => {
  const observed: Element[] = [];
  vi.stubGlobal("ResizeObserver", class {
    constructor(private readonly report: (entries: Array<{ contentRect: { width: number } }>) => void) {}
    observe(el: Element) { observed.push(el); this.report([{ contentRect: { width: 432 } }]); }
    disconnect() {}
  });
  await open("odp", buildOdp(), "odp-view");
  await vi.waitFor(() => expect(host.querySelector<HTMLElement>(".pptx-main .pptx-slide-frame")?.style.width).toBe("400px"));
  expect(observed).toContain(host.querySelector(".pptx-main"));
  vi.unstubAllGlobals();
});
