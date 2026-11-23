// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  fileFor: (rel: string) => ({
    path: `/vault/${rel}`, relPath: rel, name: rel.endsWith(".png") ? rel : rel.split("/").pop()!.replace(/\.[^.]+$/, ""), ext: rel.split(".").pop() ?? "",
    size: 1234, mtime: new Date(2025, 0, 2, 3, 4).getTime(), isMarkdown: false,
  }),
  openDocWindow: vi.fn(),
  setBinaryDirty: vi.fn(),
  activePath: null as string | null,
  vaultPath: "/vault" as string | null,
  revealActiveFile: vi.fn(),
}));
const bytes = vi.hoisted(() => ({ byRel: new Map<string, Uint8Array>(), stamp: "v1" }));
vi.mock("../store", () => ({ useAppStore: (select: (value: typeof state) => unknown) => select(state) }));
vi.mock("../lib/vault", async () => ({
  ...(await import("../lib/vaultFileKinds")),
  urlForPath: (path: string) => `asset://localhost${encodeURIComponent(path)}`,
  fileKind: (ext: string) => ext === "pdf" ? "pdf" : ext === "mp3" ? "audio" : ext === "png" || ext === "svg" ? "image" : ext === "xlsx" ? "spreadsheet" : "other",
  isWordExt: (ext: string) => /^(docx|docm|dotx|dotm)$/.test(ext),
}));
vi.mock("./LazyWordView", () => ({
  WordView: ({ rel, editable }: { rel: string; editable?: boolean }) => <div data-testid="word-view-stub">{`${rel} ${editable ? "editable" : "view"}`}</div>,
}));
vi.mock("../lib/vaultByteRead", () => ({
  readVaultRange: vi.fn(async (file: { relPath: string }, offset: number, len: number) => {
    const data = bytes.byRel.get(file.relPath) ?? new Uint8Array();
    return { bytes: data.subarray(offset, offset + len), size: data.length, stamp: bytes.stamp };
  }),
}));
vi.mock("./PdfView", async () => {
  const { useEffect } = await import("react");
  return { PdfView: ({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) => {
    useEffect(() => { onDirtyChange?.(true); return () => onDirtyChange?.(false); }, [onDirtyChange]);
    return <div>PDF editor</div>;
  } };
});
vi.mock("./HtmlView", () => ({ HtmlView: () => null }));
const copy = vi.hoisted(() => ({
  makeEditableCopy: vi.fn(async (file: { relPath: string }, content: { kind: string }) => { void content; return `Created ${file.relPath}x. The original is unchanged.`; }),
}));
vi.mock("./legacyOfficeCopy", () => copy);
vi.mock("./RtfView", () => ({ RtfView: () => null }));
vi.mock("./PresentationView", () => ({
  PresentationView: ({ file, editable }: { file: { relPath: string }; editable?: boolean }) => <div>Presentation {file.relPath} {editable ? "editable" : "view-only"}</div>,
}));
vi.mock("./SpreadsheetView", async () => {
  const { useEffect } = await import("react");
  return { SpreadsheetView: ({ editable, onDirtyChange }: { editable?: boolean; onDirtyChange?: (dirty: boolean) => void }) => {
    useEffect(() => { onDirtyChange?.(true); return () => onDirtyChange?.(false); }, [onDirtyChange]);
    return <div>Workbook {editable ? "editable" : "view-only"}</div>;
  } };
});
vi.mock("./OpenDocumentView", async () => {
  const { useEffect } = await import("react");
  return { OpenDocumentView: ({ file, editable, onDirtyChange }: { file: { relPath: string }; editable?: boolean; onDirtyChange?: (dirty: boolean) => void }) => {
    useEffect(() => { onDirtyChange?.(true); return () => onDirtyChange?.(false); }, [onDirtyChange]);
    return <div>OpenDocument {file.relPath} {editable ? "editable" : "view-only"}</div>;
  } };
});
import { zipSync } from "fflate";
import { buildDoc, buildPpt, buildXls } from "../lib/legacyOffice/fixtures/legacyFixtures";
import { MediaView } from "./MediaView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement("div");
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.replaceChildren(); });

it("keeps the scoped PNG URL and shows an actionable message after decode failure", () => {
  root = createRoot(host);
  act(() => root.render(<MediaView rel="Hero Screenshot.png" />));
  const image = host.querySelector("img")!;
  expect(image.getAttribute("src")).toBe("asset://localhost%2Fvault%2FHero%20Screenshot.png");
  act(() => image.dispatchEvent(new Event("load")));
  expect(host.querySelector('[role="status"]')).toBeNull();
  act(() => image.dispatchEvent(new Event("error")));
  expect(host.querySelector("img")).toBeNull();
  expect(host.textContent).toContain("Cannot load image: Hero Screenshot.png.");
  expect(host.textContent).toContain("incomplete, unsupported, or unavailable");
  act(() => host.querySelector("button")!.click());
  expect(host.querySelector("img")).not.toBe(image);
  expect(host.querySelector('[role="status"]')).toBeNull();
});

it("does not carry an image failure into another document or accept an obsolete error", () => {
  root = createRoot(host);
  act(() => root.render(<MediaView rel="bad.png" />));
  const old = host.querySelector("img")!;
  act(() => old.dispatchEvent(new Event("error")));
  act(() => root.render(<MediaView rel="good.png" />));
  expect(host.querySelector("img")?.alt).toBe("good.png");
  act(() => old.dispatchEvent(new Event("error")));
  expect(host.querySelector('[role="status"]')).toBeNull();
});

it("keeps keyboard focus on Retry when the image fails again", () => {
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<MediaView rel="bad.png" />));
  act(() => host.querySelector("img")!.dispatchEvent(new Event("error")));
  host.querySelector("button")!.focus();
  act(() => host.querySelector("button")!.click());
  act(() => host.querySelector("img")!.dispatchEvent(new Event("error")));
  expect(document.activeElement).toBe(host.querySelector("button"));
  host.remove();
});

it("reports main-pane PDF edits to the store so close and navigation can guard them", async () => {
  root = createRoot(host);
  await act(async () => root.render(<MediaView rel="docs/Scan.pdf" />));
  await vi.waitFor(() => expect(state.setBinaryDirty).toHaveBeenCalledWith("docs/Scan.pdf", true));
  await act(async () => root.render(<MediaView rel="docs/Other.pdf" />));
  expect(state.setBinaryDirty).toHaveBeenCalledWith("docs/Scan.pdf", false);
  expect(state.setBinaryDirty).toHaveBeenLastCalledWith("docs/Other.pdf", true);
});

it("opens Word packages in the editable Word view and legacy .doc in the read-only content view", async () => {
  root = createRoot(host);
  await act(async () => root.render(<MediaView rel="inbox/Plan.docx" />));
  expect(host.querySelector('[data-testid="word-view-stub"]')?.textContent).toBe("inbox/Plan.docx editable");
  bytes.byRel.set("inbox/Old.doc", buildDoc([{ text: "Quarterly plan\rSecond paragraph\r", compressed: true }]));
  await act(async () => root.render(<MediaView rel="inbox/Old.doc" />));
  await vi.waitFor(() => expect(host.textContent).toContain("Second paragraph"));
  expect(host.querySelector('[data-testid="word-view-stub"]')).toBeNull();
  expect(host.querySelector(".file-format-note")?.textContent).toContain("never changes this file");
  expect([...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(["Content", "Bytes"]);
  const convert = [...host.querySelectorAll("button")].find((b) => b.textContent === "Make editable .docx copy…")!;
  await act(async () => convert.click());
  await vi.waitFor(() => expect(host.querySelector('[role="status"]')?.textContent).toBe("Created inbox/Old.docx. The original is unchanged."));
  expect(copy.makeEditableCopy).toHaveBeenCalledTimes(1);
  const [file, content] = copy.makeEditableCopy.mock.calls[0];
  expect(file.relPath).toBe("inbox/Old.doc");
  expect(content.kind).toBe("word");
});

it("names the reason when a legacy file is encrypted or damaged, and keeps the bytes view", async () => {
  bytes.byRel.set("inbox/Locked.doc", buildDoc([{ text: "secret\r", compressed: true }], { encrypted: true }));
  root = createRoot(host);
  await act(async () => root.render(<MediaView rel="inbox/Locked.doc" />));
  await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain("password-protected"));
  expect(host.textContent).not.toContain("Make editable");
  bytes.byRel.set("inbox/Broken.doc", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  await act(async () => root.render(<MediaView rel="inbox/Broken.doc" />));
  await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain("damaged or not a valid Office file"));
  await act(async () => ([...host.querySelectorAll('[role="tab"]')].find((t) => t.textContent === "Bytes") as HTMLButtonElement).click());
  await vi.waitFor(() => expect(host.querySelector('[data-offset="0"]')).not.toBeNull());
});

it("shows details, a mislabel warning and bytes instead of an empty card for an unknown file", async () => {
  bytes.byRel.set("inbox/Report.odg", new TextEncoder().encode("<!DOCTYPE html><html><body>Sign in to continue</body></html>"));
  root = createRoot(host);
  await act(async () => root.render(<MediaView rel="inbox/Report.odg" />));
  await vi.waitFor(() => expect(host.querySelector('[data-offset="0"]')).not.toBeNull());
  const details = host.querySelector('[aria-label="File details"]')!;
  expect(details.textContent).toContain("Report.odg");
  expect(details.textContent).toContain("HTML page");
  // The size comes from the native read, not the older catalog entry.
  expect(details.textContent).toContain("60 B (60 bytes)");
  expect(details.textContent).toContain("2025-01-02 03:04");
  expect(details.textContent).toContain("inbox/Report.odg");
  expect(host.querySelector('[role="note"]')?.textContent).toContain("Named .odg, but the contents look like an HTML page");
  expect(host.querySelector('[data-offset="0"] .hex-ascii')?.textContent).toBe("<!DOCTYPE html><");
  const open = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Open in a new window")!;
  act(() => open.click());
  expect(state.openDocWindow).toHaveBeenCalledWith("inbox/Report.odg");
});

it("offers no new window where there is no vault to open it in (a detached document window)", async () => {
  bytes.byRel.set("blob.bin", new Uint8Array([0, 1, 2, 3]));
  state.vaultPath = null;
  root = createRoot(host);
  await act(async () => root.render(<MediaView rel="blob.bin" />));
  await vi.waitFor(() => expect(host.querySelector('[data-offset="0"]')).not.toBeNull());
  expect(host.querySelector('[aria-label="File details"]')?.textContent).toContain("blob.bin");
  expect(host.textContent).not.toContain("Open in a new window");
  state.vaultPath = "/vault";
});

it("reads bytes past the first read by range and says when the file changed on disk", async () => {
  const big = new Uint8Array(100 * 1024).fill(0x41);
  bytes.byRel.set("data.bin", big);
  bytes.stamp = "v1";
  root = createRoot(host);
  await act(async () => root.render(<MediaView rel="data.bin" />));
  await vi.waitFor(() => expect(host.querySelector('[data-offset="0"]')).not.toBeNull());
  expect(host.querySelector('.hex-view [role="status"]')).toBeNull();
  // The file is replaced before the view reads its first full window.
  bytes.byRel.set("data.bin", new Uint8Array(200 * 1024).fill(0x42));
  bytes.stamp = "v2";
  await vi.waitFor(() => expect(host.querySelector('.hex-view [role="status"]')?.textContent).toContain("changed on disk"));
  expect(host.querySelector('[data-offset="0"] .hex-ascii')?.textContent).toBe("BBBBBBBBBBBBBBBB");
  expect(host.querySelector('[aria-label="File details"]')?.textContent).toContain("200.0 KiB");
  const { readVaultRange } = await import("../lib/vaultByteRead");
  expect(vi.mocked(readVaultRange).mock.calls.every(([, , len]) => len <= 1024 * 1024)).toBe(true);
  bytes.stamp = "v1";
});

it("lists a ZIP's contents, flags traversal names and previews text read-only", async () => {
  const enc = new TextEncoder();
  bytes.byRel.set("pack.zip", zipSync({ "notes/a.txt": enc.encode("inside the archive"), "../evil.sh": enc.encode("rm") }, { level: 0 }));
  root = createRoot(host);
  await act(async () => root.render(<MediaView rel="pack.zip" />));
  await vi.waitFor(() => expect(host.querySelector('[aria-label="Archive contents"]')?.textContent).toContain("notes/a.txt"));
  expect(host.textContent).toContain("Unsafe: climbs out of the archive");
  expect(host.textContent).toContain("never extracts them");
  const entry = Array.from(host.querySelectorAll<HTMLButtonElement>(".zip-open")).find((b) => b.textContent === "notes/a.txt")!;
  act(() => entry.click());
  await vi.waitFor(() => expect(host.querySelector(".zip-text")?.textContent).toBe("inside the archive"));
  const bytesTab = Array.from(host.querySelectorAll('[role="tab"]')).find((b) => b.textContent === "Bytes") as HTMLButtonElement;
  act(() => bytesTab.click());
  await vi.waitFor(() => expect(host.querySelector('[data-offset="0"]')).not.toBeNull());
});

it("plays audio files with a player instead of the generic file card", () => {
  root = createRoot(host);
  act(() => root.render(<MediaView rel="Voice memo.mp3" />));
  expect(host.querySelector("audio")?.getAttribute("src")).toBe("asset://localhost%2Fvault%2FVoice%20memo.mp3");
  expect(host.textContent).not.toContain("Open in a new window");
});

it("explains why an SVG cannot be edited and keeps showing it", () => {
  root = createRoot(host);
  act(() => root.render(<MediaView rel="logo.svg" />));
  const edit = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Edit image")!;
  act(() => edit.click());
  expect(host.querySelector('[role="status"]')!.textContent).toContain("vector format");
  expect(host.querySelector("img")).not.toBeNull();
});

it("opens PowerPoint packages in the presentation view, editable in the main pane", async () => {
  root = createRoot(host);
  await act(async () => root.render(<MediaView rel="talks/Deck.pptx" />));
  await vi.waitFor(() => expect(host.textContent).toBe("Presentation talks/Deck.pptx editable"));
  await act(async () => root.render(<MediaView rel="talks/Show.ppsx" />));
  await vi.waitFor(() => expect(host.textContent).toBe("Presentation talks/Show.ppsx editable"));
});

it("shows legacy .ppt slide text and notes read-only with an editable-copy offer", async () => {
  bytes.byRel.set("old.ppt", buildPpt([{ title: "Kickoff", body: "Goals\rRisks", notes: "Mention budget" }]));
  root = createRoot(host);
  await act(async () => root.render(<MediaView rel="old.ppt" />));
  await vi.waitFor(() => expect(host.querySelector(".legacy-slide-title")?.textContent).toBe("Kickoff"));
  expect(host.querySelector(".legacy-slide-notes")?.textContent).toBe("Mention budget");
  expect(host.querySelector(".file-format-note")?.textContent).toContain("editable .pptx copy");
  expect(host.textContent).toContain("Make editable .pptx copy…");
});

it("opens OpenDocument text, spreadsheets, presentations and templates in the OpenDocument view and reports unsaved edits", async () => {
  root = createRoot(host);
  for (const rel of ["a/Notes.odt", "a/Plan.ods", "a/Talk.odp", "a/Form.ott", "a/Grid.ots", "a/Deck.otp"]) {
    await act(async () => root.render(<MediaView rel={rel} />));
    await vi.waitFor(() => expect(host.textContent).toBe(`OpenDocument ${rel} editable`));
    expect(state.setBinaryDirty).toHaveBeenCalledWith(rel, true);
  }
});

it("opens .xlsx in the editable workbook view and reports its unsaved edits to the store", async () => {
  root = createRoot(host);
  await act(async () => root.render(<MediaView rel="books/Budget.xlsx" />));
  await vi.waitFor(() => expect(host.textContent).toContain("Workbook editable"));
  expect(state.setBinaryDirty).toHaveBeenCalledWith("books/Budget.xlsx", true);
});

it("shows legacy .xls cells read-only in the shared grid and explains flat .fods", async () => {
  bytes.byRel.set("old/Budget.xls", buildXls([{ name: "Costs", cells: [{ kind: "sst", row: 0, col: 0, index: 0 }, { kind: "formulaNumber", row: 1, col: 0, value: 12 }] }], { strings: ["Rent"] }));
  root = createRoot(host);
  await act(async () => root.render(<MediaView rel="old/Budget.xls" />));
  await vi.waitFor(() => expect(host.querySelector('[aria-label="Sheet Costs, read-only"]')).not.toBeNull());
  expect(host.textContent).toContain("Rent");
  expect(host.textContent).toContain("Formula cells show their last calculated value.");
  expect(host.querySelector('[title="Last calculated value of a formula"]')?.textContent).toBe("12");
  expect(host.textContent).not.toContain("Mesa does not open legacy (.xls)");
  bytes.byRel.set("old/Plan.fods", new TextEncoder().encode("<?xml version=\"1.0\"?><office:document/>"));
  await act(async () => root.render(<MediaView rel="old/Plan.fods" />));
  await vi.waitFor(() => expect(host.textContent).toContain("flat XML"));
});
