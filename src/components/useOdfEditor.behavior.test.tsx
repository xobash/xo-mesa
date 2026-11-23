// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildOdf, buildOdt } from "../lib/odf/fixtures/odfFixtures";
import type { OdfPackage } from "../lib/odf/odfPackage";
import type { VaultFile } from "../types";

const disk = vi.hoisted(() => ({
  bytes: new Uint8Array() as Uint8Array<ArrayBufferLike>,
  readError: null as Error | null,
  saveError: null as Error | null,
  saves: [] as Array<{ path: string; bytes: Uint8Array; expected: Uint8Array | null }>,
  gate: null as Promise<void> | null,
}));
const confirm = vi.hoisted(() => ({ answer: true, calls: [] as string[] }));
const store = vi.hoisted(() => ({
  vaultPath: "/vault" as string | null,
  files: [{ relPath: "Doc.odt" }] as Array<{ relPath: string }>,
  registered: [] as string[],
  writes: [] as Array<{ root: string; rel: string; options: unknown }>,
  writeError: null as Error | null,
  switchVaultDuringWrite: false,
}));

vi.mock("../lib/documentBytesSave", () => {
  class DocumentChangedOnDiskError extends Error {}
  return {
    DocumentChangedOnDiskError,
    readDocumentBytes: async () => {
      if (disk.readError) throw disk.readError;
      return disk.bytes;
    },
    saveDocumentBytes: async ({ path, bytes, expected, validate }: { path: string; bytes: Uint8Array; expected: Uint8Array | null; validate?: (b: Uint8Array) => void }) => {
      if (disk.gate) await disk.gate;
      if (disk.saveError) throw disk.saveError;
      validate?.(bytes);
      disk.saves.push({ path, bytes, expected });
      disk.bytes = bytes;
    },
  };
});
vi.mock("../lib/vault", () => ({
  writeVaultBinaryFile: async (root: string, rel: string, _bytes: Uint8Array, options: unknown) => {
    if (store.writeError) throw store.writeError;
    store.writes.push({ root, rel, options });
    if (store.switchVaultDuringWrite) store.vaultPath = "/other";
  },
}));
vi.mock("../lib/confirmAction", () => ({
  confirmAction: async (message: string) => { confirm.calls.push(message); return confirm.answer; },
}));
vi.mock("../store", () => ({
  getStore: () => ({
    vaultPath: store.vaultPath,
    files: store.files,
    registerVaultFile: async (rel: string) => { store.registered.push(rel); },
  }),
}));

import { DocumentChangedOnDiskError } from "../lib/documentBytesSave";
import { useOdfEditor, type OdfDraftSpec, type OdfEditor } from "./useOdfEditor";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The draft is the content.xml text itself, so edits are plain string replaces.
const contentText = (pkg: OdfPackage) => strFromU8(pkg.parts.get("content.xml")!);
const checks: Array<(saved: OdfPackage, draft: string) => void> = [];
const spec: OdfDraftSpec<string> = {
  initial: contentText,
  content: (_pkg, draft) => draft,
  isClean: (pkg, draft) => draft === contentText(pkg),
  check: (saved, draft) => { for (const c of checks) c(saved, draft); },
};
const rename = (to: string) => (text: string) => text.replace(/>[^<]*<\/text:h>/, `>${to}</text:h>`);

const host = document.createElement("div");
let root: ReturnType<typeof createRoot>;
let editor: OdfEditor<string>;
const fileOf = (mtime = 1, path = "/vault/Doc.odt"): VaultFile => ({ path, relPath: "Doc.odt", name: "Doc.odt", ext: "odt", mtime, size: 1, isMarkdown: false } as VaultFile);

function Harness({ file, onDirty }: { file: VaultFile; onDirty?: (dirty: boolean) => void }) {
  editor = useOdfEditor(file, spec, onDirty);
  return null;
}

async function mount(file = fileOf(), onDirty?: (dirty: boolean) => void) {
  await act(async () => root.render(<Harness file={file} onDirty={onDirty} />));
  await vi.waitFor(() => expect(editor.load.state).not.toBe("loading"));
}
const headingOf = (bytes: Uint8Array) => /<text:h[^>]*>([^<]*)<\/text:h>/.exec(strFromU8(unzipSync(bytes)["content.xml"]))![1];

beforeEach(() => {
  disk.bytes = buildOdt();
  disk.readError = null;
  disk.saveError = null;
  disk.saves = [];
  disk.gate = null;
  confirm.answer = true;
  confirm.calls = [];
  store.vaultPath = "/vault";
  store.files = [{ relPath: "Doc.odt" }];
  store.registered = [];
  store.writes = [];
  store.writeError = null;
  store.switchVaultDuringWrite = false;
  checks.length = 0;
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); });

it("reports dirty through the callback, undoes and redoes drafts, and clears dirty on unmount", async () => {
  const onDirty = vi.fn();
  await mount(fileOf(), onDirty);
  expect(editor.load.state).toBe("ready");
  expect(editor.dirty).toBe(false);
  act(() => { expect(editor.apply(rename("Changed"))).toBe(true); });
  expect(editor.dirty).toBe(true);
  expect(onDirty).toHaveBeenLastCalledWith(true);
  expect(editor.canUndo).toBe(true);
  act(() => editor.undo());
  expect(editor.dirty).toBe(false);
  expect(editor.canRedo).toBe(true);
  act(() => editor.redo());
  expect(editor.draft).toContain(">Changed</text:h>");
  expect(editor.canRedo).toBe(false);
  act(() => root.unmount());
  expect(onDirty).toHaveBeenLastCalledWith(false);
  root = createRoot(host);
});

it("merges consecutive edits with one coalesce key into one undo step until endCoalesce", async () => {
  await mount();
  act(() => { editor.apply(rename("A"), "typing"); });
  act(() => { editor.apply(rename("AB"), "typing"); });
  act(() => editor.undo());
  expect(editor.dirty).toBe(false);
  expect(editor.canUndo).toBe(false);
  act(() => { editor.apply(rename("A"), "typing"); });
  act(() => editor.endCoalesce());
  act(() => { editor.apply(rename("AB"), "typing"); });
  act(() => editor.undo());
  expect(editor.draft).toContain(">A</text:h>");
});

it("keeps at most 50 undo steps", async () => {
  await mount();
  for (let i = 0; i < 60; i += 1) act(() => { editor.apply(rename(`v${i}`)); });
  let undos = 0;
  while (editor.canUndo && undos < 100) { act(() => editor.undo()); undos += 1; }
  expect(undos).toBe(50);
  expect(editor.draft).toContain(">v9</text:h>");
});

it("an edit that throws shows its message and changes nothing; an identical draft adds no undo step", async () => {
  await mount();
  let result = true;
  act(() => { result = editor.apply(() => { throw new Error("That cell is locked."); }); });
  expect(result).toBe(false);
  expect(editor.status).toBe("That cell is locked.");
  act(() => { result = editor.apply((d) => d); });
  expect(result).toBe(true);
  expect(editor.canUndo).toBe(false);
});

it("saves the edited content against the opened bytes and re-adopts the saved package", async () => {
  await mount();
  const opened = disk.bytes;
  act(() => { editor.apply(rename("Saved title")); });
  await act(async () => editor.save());
  expect(disk.saves).toHaveLength(1);
  expect(disk.saves[0].expected).toBe(opened);
  expect(disk.saves[0].path).toBe("/vault/Doc.odt");
  expect(headingOf(disk.saves[0].bytes)).toBe("Saved title");
  expect(editor.status).toBe("Saved.");
  expect(editor.dirty).toBe(false);
  expect(editor.canUndo).toBe(false);
});

it("a clean save writes nothing and says so", async () => {
  await mount();
  await act(async () => editor.save());
  expect(disk.saves).toHaveLength(0);
  expect(editor.status).toBe("No changes to save.");
});

it("asks before saving a document with macros and writes nothing when cancelled", async () => {
  disk.bytes = buildOdf("text", strFromU8(unzipSync(buildOdt())["content.xml"]), { extra: { "Basic/Standard/Module1.xml": "<m/>" } });
  await mount();
  expect(editor.pkg?.policy.warnings.length).toBeGreaterThan(0);
  act(() => { editor.apply(rename("Macro doc")); });
  confirm.answer = false;
  await act(async () => editor.save());
  expect(confirm.calls).toHaveLength(1);
  expect(confirm.calls[0]).toContain("macros");
  expect(disk.saves).toHaveLength(0);
  expect(editor.dirty).toBe(true);
  confirm.answer = true;
  await act(async () => editor.save());
  expect(disk.saves).toHaveLength(1);
});

it("a disk-changed refusal keeps edits and blocks later saves; other failures report Save failed", async () => {
  await mount();
  act(() => { editor.apply(rename("Edit")); });
  disk.saveError = new Error("disk full");
  await act(async () => editor.save());
  expect(editor.status).toBe("Save failed: disk full");
  expect(editor.diskChanged).toBe(false);
  expect(editor.saving).toBe(false);
  disk.saveError = new DocumentChangedOnDiskError("The file changed on disk.");
  await act(async () => editor.save());
  expect(editor.status).toBe("The file changed on disk.");
  expect(editor.diskChanged).toBe(true);
  expect(editor.dirty).toBe(true);
  disk.saveError = null;
  await act(async () => editor.save());
  expect(disk.saves).toHaveLength(0);
  expect(editor.status).toContain("Save is blocked");
});

it("a failing kind-specific check stops the save with its message", async () => {
  await mount();
  checks.push(() => { throw new Error("Mesa stopped the save: heading lost."); });
  act(() => { editor.apply(rename("Bad")); });
  await act(async () => editor.save());
  expect(disk.saves).toHaveLength(0);
  expect(editor.status).toBe("Mesa stopped the save: heading lost.");
  await act(async () => editor.saveCopy());
  expect(store.writes).toHaveLength(0);
  expect(editor.status).toBe("Mesa stopped the save: heading lost.");
});

it("a read failure or unreadable bytes on first open shows a failed load", async () => {
  disk.readError = new Error("permission denied");
  await mount();
  expect(editor.load).toEqual({ state: "failed", message: "Could not read this file: permission denied" });
  act(() => root.unmount());
  root = createRoot(host);
  disk.readError = null;
  disk.bytes = new TextEncoder().encode("not a zip");
  await mount(fileOf(1, "/vault/Other.odt"));
  expect(editor.load.state).toBe("failed");
  expect(editor.load.state === "failed" && editor.load.message).toMatch(/^Mesa cannot open this file: /);
});

it("on a disk change ignores its own echo, reloads a clean document and keeps a dirty one", async () => {
  await mount();
  const firstPkg = editor.pkg;
  // Same bytes (own save echo): nothing changes.
  await act(async () => root.render(<Harness file={fileOf(2)} />));
  expect(editor.pkg).toBe(firstPkg);
  expect(editor.status).toBe("");
  // Clean document: newer bytes reload.
  disk.bytes = buildOdt('<text:h text:outline-level="1">Newer</text:h>');
  await act(async () => root.render(<Harness file={fileOf(3)} />));
  await vi.waitFor(() => expect(editor.status).toBe("Reloaded: this file changed on disk."));
  expect(editor.draft).toContain(">Newer</text:h>");
  // Dirty document: keeps edits, blocks Save.
  act(() => { editor.apply(rename("Mine")); });
  disk.bytes = buildOdt('<text:h text:outline-level="1">Theirs</text:h>');
  await act(async () => root.render(<Harness file={fileOf(4)} />));
  await vi.waitFor(() => expect(editor.diskChanged).toBe(true));
  expect(editor.draft).toContain(">Mine</text:h>");
  expect(editor.status).toContain("Save as copy works");
});

it("keeps the open document when the newer disk version cannot be opened", async () => {
  await mount();
  const pkg = editor.pkg;
  disk.bytes = new TextEncoder().encode("garbage");
  await act(async () => root.render(<Harness file={fileOf(2)} />));
  await vi.waitFor(() => expect(editor.status).toMatch(/^The newer version on disk cannot be opened: /));
  expect(editor.load.state).toBe("ready");
  expect(editor.pkg).toBe(pkg);
});

it("saves a copy beside the file without replacing it, and registers it only in the same vault", async () => {
  await mount();
  await act(async () => editor.saveCopy());
  expect(editor.status).toBe("No changes to save.");
  act(() => { editor.apply(rename("Copy")); });
  await act(async () => editor.saveCopy());
  expect(store.writes).toEqual([{ root: "/vault", rel: "Doc copy.odt", options: { expectedMissing: true } }]);
  expect(store.registered).toEqual(["Doc copy.odt"]);
  expect(editor.status).toBe("Saved a copy as Doc copy.odt. Your edits are still open here.");
  expect(editor.dirty).toBe(true);
  store.switchVaultDuringWrite = true;
  await act(async () => editor.saveCopy());
  expect(store.writes).toHaveLength(2);
  expect(store.registered).toEqual(["Doc copy.odt"]);
  expect(editor.saving).toBe(false);
  store.vaultPath = "/vault";
  store.switchVaultDuringWrite = false;
  store.writeError = new Error("exists");
  await act(async () => editor.saveCopy());
  expect(editor.status).toBe("Save as copy failed: exists");
});

it("does nothing on Save as copy without an open vault", async () => {
  await mount();
  act(() => { editor.apply(rename("X")); });
  store.vaultPath = null;
  await act(async () => editor.saveCopy());
  expect(store.writes).toHaveLength(0);
});

it("discard confirms only when dirty, keeps edits on cancel, and reloads from disk on confirm", async () => {
  await mount();
  let kept: boolean | undefined;
  await act(async () => { kept = await editor.discard(); });
  expect(kept).toBe(true);
  expect(confirm.calls).toHaveLength(0);
  act(() => { editor.apply(rename("Draft")); });
  confirm.answer = false;
  await act(async () => { kept = await editor.discard(); });
  expect(kept).toBe(false);
  expect(editor.dirty).toBe(true);
  confirm.answer = true;
  disk.readError = new Error("gone");
  await act(async () => { kept = await editor.discard(); });
  expect(kept).toBe(false);
  expect(editor.status).toBe("Could not reload this file: gone");
  expect(editor.dirty).toBe(true);
  disk.readError = null;
  await act(async () => { kept = await editor.discard(); });
  expect(kept).toBe(true);
  expect(editor.status).toBe("Edits discarded.");
  expect(editor.dirty).toBe(false);
});

it("enters edit mode only for an editable package and Done leaves it after a clean discard", async () => {
  await mount();
  act(() => editor.startEditing());
  expect(editor.editing).toBe(true);
  act(() => { editor.apply(rename("D")); });
  confirm.answer = false;
  await act(async () => editor.finish());
  expect(editor.editing).toBe(true);
  confirm.answer = true;
  await act(async () => editor.finish());
  expect(editor.editing).toBe(false);
  act(() => root.unmount());
  root = createRoot(host);
  disk.bytes = buildOdf("text", strFromU8(unzipSync(buildOdt())["content.xml"]), { mime: "application/vnd.oasis.opendocument.text-template" });
  await mount(fileOf(1, "/vault/Template.ott"));
  expect(editor.pkg?.policy.canEdit).toBe(false);
  act(() => editor.startEditing());
  expect(editor.editing).toBe(false);
});

it("refuses an edit made while a save is writing, so adopting the saved bytes cannot drop it", async () => {
  await mount();
  act(() => { editor.apply(rename("Saved")); });
  let release!: () => void;
  disk.gate = new Promise<void>((resolve) => { release = resolve; });
  let saving!: Promise<void>;
  act(() => { saving = editor.save(); });
  await vi.waitFor(() => expect(editor.saving).toBe(true));
  act(() => { expect(editor.apply(rename("Typed during save"))).toBe(false); });
  expect(editor.status).toMatch(/saving/i);
  await act(async () => { release(); await saving; });
  expect(headingOf(disk.saves[0].bytes)).toBe("Saved");
  expect(editor.draft).toContain(">Saved</text:h>");
  expect(editor.dirty).toBe(false);
  act(() => { expect(editor.apply(rename("After"))).toBe(true); });
});
