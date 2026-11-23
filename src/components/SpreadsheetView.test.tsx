// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildPackage } from "../lib/ooxml/fixtures/ooxmlFixtures";
import { macroWorkbookParts, plainSheet, signedWorkbookParts, workbookParts } from "../lib/ooxml/fixtures/xlsxFixtures";

/**
 * A WORKBOOK OPENS READ-ONLY, EDITS ONLY AFTER AN EXPLICIT EDIT, AND SAVES
 * AGAINST THE BYTES IT OPENED.
 */

const io = vi.hoisted(() => ({
  read: vi.fn(),
  save: vi.fn(async (_job: { bytes: Uint8Array; expected: Uint8Array | null; validate?: (b: Uint8Array) => void }) => undefined),
  copies: [] as string[],
  confirm: vi.fn(async () => true),
  file: { path: "/v/Book.xlsx", relPath: "Book.xlsx", name: "Book", ext: "xlsx", mtime: 1 } as Record<string, unknown>,
}));
vi.mock("../store", () => ({
  useAppStore: (select: (s: Record<string, unknown>) => unknown) => select({ fileFor: () => io.file }),
  getStore: () => ({ vaultPath: "/v", files: [{ relPath: "Book.xlsx" }], registerVaultFile: async () => undefined }),
}));
vi.mock("../lib/vault", () => ({ writeVaultBinaryFile: async (_root: string, rel: string) => { io.copies.push(rel); } }));
vi.mock("../lib/confirmAction", () => ({ confirmAction: io.confirm }));
vi.mock("../lib/documentBytesSave", () => ({
  readDocumentBytes: io.read,
  saveDocumentBytes: io.save,
  DocumentChangedOnDiskError: class extends Error {},
}));
vi.mock("./FileFallbackView", () => ({ FileFallbackView: () => <div>file details</div> }));
/** When set, a row move waits for `release` (the worker is still running). */
const rowGate = vi.hoisted(() => ({ wait: null as Promise<void> | null }));
vi.mock("../lib/ooxml/xlsxWorkerClient", async (original) => {
  const actual = await original<typeof import("../lib/ooxml/xlsxWorkerClient")>();
  return {
    createXlsxWorkerClient: () => {
      const client = actual.createXlsxWorkerClient();
      return { ...client, shiftRows: async (job: Parameters<typeof client.shiftRows>[0]) => { await rowGate.wait; return client.shiftRows(job); } };
    },
  };
});
import { SpreadsheetView } from "./SpreadsheetView";
import { openXlsx } from "../lib/ooxml/xlsxOpen";
import { cellView, createDraft } from "../lib/ooxml/xlsxDraft";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onDirty = vi.fn();
const BOOK = buildPackage(workbookParts());

beforeEach(() => {
  io.read.mockResolvedValue(BOOK);
  io.file = { path: "/v/Book.xlsx", relPath: "Book.xlsx", name: "Book", ext: "xlsx", mtime: 1 };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

async function mount(editable = true) {
  await act(async () => root.render(<SpreadsheetView rel="Book.xlsx" editable={editable} onDirtyChange={onDirty} />));
  await vi.waitFor(() => expect(cells().length).toBeGreaterThan(0));
}
const cells = () => [...host.querySelectorAll<HTMLElement>('[role="gridcell"]')];
const cell = (text: string) => cells().find((el) => el.textContent === text)!;
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);
const grid = () => host.querySelector<HTMLElement>('[role="grid"]')!;
const key = (target: Element, k: string) => act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
async function typeInto(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("shows values, styles, sheet tabs and the formula of the selected cell, read-only", async () => {
  await mount();
  expect(cell("25%")).toBeDefined();
  expect(cell("Name").style.fontWeight).toBe("700");
  expect([...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(["Data", "Other"]);
  await act(async () => cell("0.5").click());
  expect(host.querySelector<HTMLInputElement>('[aria-label="Cell contents"]')!.value).toBe("=B2*2");
  expect(host.textContent).toContain("Formula cells show the results saved in the file");
  await act(async () => cell("Alice & co").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(host.querySelector("textarea")).toBeNull();
  expect(button("Save")).toBeUndefined();
});

it("edits after Edit, reports dirty state, and saves verified bytes against the opened bytes", async () => {
  await mount();
  await act(async () => button("Edit")!.click());
  await act(async () => cell("25%").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await typeInto(host.querySelector("textarea")!, "40%");
  await key(host.querySelector("textarea")!, "Enter");
  expect(cell("40%")).toBeDefined();
  expect(onDirty).toHaveBeenLastCalledWith(true);
  expect(host.textContent).toContain("Unsaved changes");
  await act(async () => button("Save")!.click());
  await vi.waitFor(() => expect(io.save).toHaveBeenCalledOnce());
  const job = io.save.mock.calls[0][0];
  expect(job.expected).toBe(BOOK);
  const reopened = openXlsx(job.bytes);
  expect(cellView(reopened.session, createDraft(reopened.session), "xl/worksheets/sheet1.xml", 1, 1).display).toBe("40%");
  await vi.waitFor(() => expect(onDirty).toHaveBeenLastCalledWith(false));
});

it("keeps edits and blocks Save when the file changes on disk while dirty", async () => {
  await mount();
  await act(async () => button("Edit")!.click());
  await act(async () => cell("25%").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await typeInto(host.querySelector("textarea")!, "1");
  await key(host.querySelector("textarea")!, "Enter");
  io.read.mockResolvedValue(buildPackage(workbookParts({ calcChain: false })));
  io.file = { ...io.file, mtime: 2 };
  await act(async () => root.render(<SpreadsheetView rel="Book.xlsx" editable onDirtyChange={onDirty} />));
  await vi.waitFor(() => expect(host.textContent).toContain("changed on disk. Your edits are still here"));
  expect(cell("100%")).toBeDefined();
  expect(button("Save")!.disabled).toBe(true);
  expect(button("Save as copy")!.disabled).toBe(false);
  expect(io.save).not.toHaveBeenCalled();
});

it("refuses an edit Mesa would write wrongly and shows why", async () => {
  await mount();
  await act(async () => button("Edit")!.click());
  await act(async () => cell("Name").click());
  await key(grid(), "ArrowDown");
  await act(async () => button("Insert row")!.click());
  expect(host.textContent).toMatch(/Mesa cannot insert this row because the formula in Data!D2 would change/);
});

it("asks before editing a workbook with macros, and stays read-only for a signed workbook", async () => {
  io.read.mockResolvedValue(buildPackage(macroWorkbookParts()));
  io.confirm.mockResolvedValueOnce(false);
  await mount();
  await act(async () => button("Edit")!.click());
  expect(io.confirm).toHaveBeenCalledOnce();
  expect(button("Save")).toBeUndefined();
  await act(async () => root.unmount());
  root = createRoot(host);
  io.read.mockResolvedValue(buildPackage(signedWorkbookParts()));
  await mount();
  expect(button("Edit")!.disabled).toBe(true);
  expect(host.textContent).toMatch(/digitally signed/);
});

it("explains a file it cannot open instead of showing an empty view", async () => {
  io.read.mockResolvedValue(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]));
  await act(async () => root.render(<SpreadsheetView rel="Book.xlsx" editable />));
  await vi.waitFor(() => expect(host.textContent).toMatch(/encrypted or in the legacy binary Office format/));
  expect(host.textContent).toContain("file details");
});

it("moves rows in the worker, shows progress, and blocks other edits until the move finishes", async () => {
  io.read.mockResolvedValue(buildPackage(workbookParts({ sheets: [{ name: "Plain", xml: plainSheet(5, 2) }], calcChain: false })));
  await mount();
  await act(async () => button("Edit")!.click());
  await act(async () => cell("10").click());
  let release = () => {};
  rowGate.wait = new Promise<void>((resolve) => { release = resolve; });
  await act(async () => button("Insert row")!.click());
  expect(host.querySelector('[data-testid="sheet-row-job"]')?.textContent).toContain("Inserting row 1");
  for (const label of ["Insert row", "Delete row", "Undo", "Save", "Add sheet"]) expect(button(label)!.disabled).toBe(true);
  expect(host.querySelector<HTMLInputElement>('[aria-label="Cell contents"]')!.readOnly).toBe(true);
  await act(async () => { release(); await rowGate.wait; });
  rowGate.wait = null;
  await vi.waitFor(() => expect(host.querySelector('[data-testid="sheet-row-job"]')).toBeNull());
  expect(host.textContent).toContain("Unsaved changes");
  expect(button("Undo")!.disabled).toBe(false);
  await act(async () => button("Save")!.click());
  await vi.waitFor(() => expect(io.save).toHaveBeenCalledOnce());
  const reopened = openXlsx(io.save.mock.calls[0][0].bytes);
  const view = (row: number) => cellView(reopened.session, createDraft(reopened.session), "xl/worksheets/sheet1.xml", row, 0).display;
  expect([view(0), view(1), view(5)]).toEqual(["", "10", "50"]);
});

it("refuses a cell edit while a save writes instead of dropping it when the saved workbook is adopted", async () => {
  await mount();
  await act(async () => button("Edit")!.click());
  await act(async () => cell("25%").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await typeInto(host.querySelector("textarea")!, "40%");
  await key(host.querySelector("textarea")!, "Enter");
  let release!: () => void;
  io.save.mockImplementationOnce(() => new Promise<undefined>((resolve) => { release = () => resolve(undefined); }));
  await act(async () => button("Save")!.click());
  await vi.waitFor(() => expect(io.save).toHaveBeenCalledOnce());
  await act(async () => cell("40%").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await typeInto(host.querySelector("textarea")!, "55%");
  await key(host.querySelector("textarea")!, "Enter");
  expect(host.textContent).toContain("Mesa is saving");
  await act(async () => { release(); });
  await vi.waitFor(() => expect(onDirty).toHaveBeenLastCalledWith(false));
});

it("names a saved copy like the other editors do", async () => {
  io.copies.length = 0;
  await mount();
  await act(async () => button("Edit")!.click());
  await act(async () => cell("25%").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await typeInto(host.querySelector("textarea")!, "40%");
  await key(host.querySelector("textarea")!, "Enter");
  await act(async () => button("Save as copy")!.click());
  await vi.waitFor(() => expect(io.copies).toEqual(["Book copy.xlsx"]));
});
