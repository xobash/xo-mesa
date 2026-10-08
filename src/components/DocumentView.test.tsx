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
    onCloseRequested: async (callback: typeof mocks.onClose) => {
      mocks.onClose = callback;
      return () => { mocks.onClose = null; };
    },
  }),
}));
vi.mock("@tauri-apps/plugin-fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/plugin-fs")>()),
  watch: mocks.watch,
}));
vi.mock("../lib/vault", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/vault")>()),
  IN_TAURI: true,
  scanVault: mocks.scanVault,
  readNoteResult: mocks.readNoteResult,
}));
vi.mock("./MarkdownView", () => ({
  MarkdownView: ({ source }: { source: string }) => <article>{source}</article>,
}));
vi.mock("./PdfView", () => ({
  PdfView: ({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) => (
    <button onClick={() => onDirtyChange?.(false)}>Save test PDF</button>
  ),
}));

import { DOCUMENT_CATALOG_EVENT, DOCUMENT_CATALOG_REQUEST_EVENT, DocumentView } from "./DocumentView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "doc-test" } },
    invoke: vi.fn(async () => {}),
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
  mocks.close.mockClear();
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
