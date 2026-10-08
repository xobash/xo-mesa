// @vitest-environment jsdom
import { act } from "react";
import { THEME_IDS } from "../lib/persistedUi";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  emit: vi.fn(async () => {}),
  scanVault: vi.fn(async () => []),
  readNoteResult: vi.fn(async () => ({ ok: true, text: "A live document" })),
  watch: vi.fn(async (_path: string, _callback: (event: { paths: string[] }) => void) => () => {}),
  close: vi.fn(async () => {}),
  invoke: vi.fn(async (_command: string, _args?: unknown, _options?: unknown) => {}),
  disposeDock: vi.fn(),
  installNativeDragDock: vi.fn<(payload: { kind: string; relPath: string }) => Promise<() => void>>(),
  onClose: null as null | ((event: { preventDefault(): void }) => Promise<void>),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: mocks.emit,
  listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, callback);
    return () => mocks.listeners.delete(name);
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "doc-test",
    close: mocks.close,
    setTitle: (title: string) => mocks.invoke("plugin:window|set_title", { label: "doc-test", value: title }, undefined),
    onCloseRequested: async (callback: typeof mocks.onClose) => {
      mocks.onClose = callback;
      return () => { mocks.onClose = null; };
    },
  }),
}));
vi.mock("@tauri-apps/plugin-fs", () => {
  const unexpected = () => { throw new Error("Unexpected filesystem call in document window test"); };
  return {
    watch: mocks.watch,
    readDir: unexpected, readTextFile: unexpected, readFile: unexpected,
    writeFile: unexpected, remove: unexpected, rename: unexpected,
    mkdir: unexpected, exists: unexpected, stat: unexpected, open: unexpected,
  };
});
vi.mock("../lib/vault", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/vault")>()),
  IN_TAURI: true,
  scanVault: mocks.scanVault,
  readNoteResult: mocks.readNoteResult,
}));
vi.mock("../lib/windowDock", () => ({ installNativeDragDock: mocks.installNativeDragDock }));
vi.mock("./MarkdownView", () => ({
  MarkdownView: ({ source, onWikiClick }: { source: string; onWikiClick?: (target: string) => void }) => (
    <article>{source}<button onClick={() => onWikiClick?.("Other")}>Open wikilink</button></article>
  ),
}));
vi.mock("./PdfView", () => ({
  PdfView: ({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) => (
    <div>
      <button onClick={() => onDirtyChange?.(true)}>Edit test PDF</button>
      <button onClick={() => onDirtyChange?.(false)}>Save test PDF</button>
    </div>
  ),
}));

import { DOCUMENT_CATALOG_EVENT, DOCUMENT_CATALOG_REQUEST_EVENT, DocumentView } from "./DocumentView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  await import("@tauri-apps/api/window");
  (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "doc-test" } },
    invoke: mocks.invoke,
  };
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  mocks.listeners.clear();
  mocks.emit.mockClear();
  mocks.scanVault.mockClear();
  mocks.readNoteResult.mockClear();
  mocks.watch.mockClear();
  mocks.close.mockReset();
  mocks.invoke.mockClear();
  mocks.disposeDock.mockClear();
  mocks.installNativeDragDock.mockReset().mockResolvedValue(mocks.disposeDock);
  mocks.readNoteResult.mockResolvedValue({ ok: true, text: "A live document" });
  mocks.onClose = null;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

describe("detached document window", () => {
  it("uses the main window catalog and reads only the selected file", async () => {
    let onFileChange: ((event: { paths: string[] }) => void) | undefined;
    mocks.watch.mockImplementation(async (_path: string, callback: (event: { paths: string[] }) => void) => {
      onFileChange = callback;
      return () => {};
    });
    history.replaceState(null, "", "/?doc=note.md&vault=%2Fvault");
    await act(async () => { root.render(<DocumentView />); });
    await vi.waitFor(() => expect(mocks.emit).toHaveBeenCalledWith(
      DOCUMENT_CATALOG_REQUEST_EVENT,
      { label: "doc-test", vault: "/vault" },
    ));
    const response = mocks.listeners.get(DOCUMENT_CATALOG_EVENT);
    expect(response).toBeDefined();
    await act(async () => response?.({ payload: {
      vault: "/vault",
      files: [{ path: "/vault/note.md", relPath: "note.md", name: "note", ext: "md", isMarkdown: true }],
    } }));
    expect(mocks.scanVault).not.toHaveBeenCalled();
    expect(mocks.readNoteResult).toHaveBeenCalledWith(expect.objectContaining({ path: "/vault/note.md" }));
    expect(host.textContent).toContain("A live document");
    mocks.readNoteResult.mockResolvedValue({ ok: true, text: "Changed outside Mesa" });
    await act(async () => onFileChange?.({ paths: ["/vault/note.md"] }));
    expect(host.textContent).toContain("Changed outside Mesa");
    mocks.readNoteResult.mockResolvedValue({ ok: false, text: "" });
    await act(async () => onFileChange?.({ paths: ["/vault/note.md"] }));
    expect(host.textContent).toContain("Changed outside Mesa");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("unavailable");
    expect(mocks.scanVault).not.toHaveBeenCalled();
  });
});


describe("native document controls", () => {
  it("has no Mesa header and follows wikilinks with the native title and dock target", async () => {
    history.replaceState(null, "", "/?doc=Notes%2FINDEX.md&vault=%2Fvault");
    await act(async () => { root.render(<DocumentView />); });
    expect(host.querySelector("header")).toBeNull();
    expect(host.querySelector('[aria-label="Close"]')).toBeNull();
    expect(document.title).toBe("INDEX");
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("plugin:window|set_title", { label: "doc-test", value: "INDEX" }, undefined));
    expect(mocks.installNativeDragDock).toHaveBeenLastCalledWith({ kind: "doc", relPath: "Notes/INDEX.md" });
    await act(async () => mocks.listeners.get(DOCUMENT_CATALOG_EVENT)?.({ payload: {
      vault: "/vault",
      files: [
        { path: "/vault/Notes/INDEX.md", relPath: "Notes/INDEX.md", name: "INDEX", ext: "md", isMarkdown: true },
        { path: "/vault/Other.md", relPath: "Other.md", name: "Other", ext: "md", isMarkdown: true },
      ],
    } }));
    await act(async () => host.querySelector("button")?.click());
    expect(document.title).toBe("Other");
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("plugin:window|set_title", { label: "doc-test", value: "Other" }, undefined));
    expect(mocks.disposeDock).toHaveBeenCalledTimes(1);
    expect(mocks.installNativeDragDock).toHaveBeenLastCalledWith({ kind: "doc", relPath: "Other.md" });
  });

  it("disposes docking when registration completes after unmount", async () => {
    let resolve!: (cleanup: () => void) => void;
    mocks.installNativeDragDock.mockReturnValue(new Promise((done) => { resolve = done; }));
    history.replaceState(null, "", "/?doc=note.md&vault=%2Fvault");
    await act(async () => { root.render(<DocumentView />); });
    await act(async () => { root.render(null); });
    await act(async () => resolve(mocks.disposeDock));
    expect(mocks.disposeDock).toHaveBeenCalledTimes(1);
  });

  it("blocks native close for unsaved PDF edits and admits close after save", async () => {
    history.replaceState(null, "", "/?doc=sample.pdf&vault=%2Fvault");
    await act(async () => { root.render(<DocumentView />); });
    const button = (text: string) => Array.from(host.querySelectorAll("button")).find((item) => item.textContent === text)!;
    await act(async () => button("Edit test PDF").click());
    const preventDefault = vi.fn();
    await act(async () => mocks.onClose?.({ preventDefault }));
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(mocks.close).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Close stopped: Error: Save the PDF");
    await act(async () => button("Save test PDF").click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    const finalPreventDefault = vi.fn();
    mocks.close.mockImplementation(async () => { await mocks.onClose?.({ preventDefault: finalPreventDefault }); });
    await act(async () => mocks.onClose?.({ preventDefault }));
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(finalPreventDefault).not.toHaveBeenCalled();
  });
});

describe("standalone document theme validation", () => {
  it.each(THEME_IDS)("applies the %s theme from the URL", async (theme) => {
    history.replaceState(null, "", `/?doc=note.md&vault=%2Fvault&theme=${theme}`);
    await act(async () => { root.render(<DocumentView />); });
    expect(document.documentElement.dataset.theme).toBe(theme);
  });

  it.each(["", "VOID", "solarized", "constructor"])("falls back to void for invalid URL theme %s", async (value) => {
    history.replaceState(null, "", `/?doc=note.md&vault=%2Fvault&theme=${value}`);
    await act(async () => { root.render(<DocumentView />); });
    expect(document.documentElement.dataset.theme).toBe("void");
  });
});
