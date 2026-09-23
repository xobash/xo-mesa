// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const io = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }));
vi.mock("../lib/vault", async original => ({ ...await original<object>(), readNoteResult: io.read }));
import { useAppStore } from "../store";
import { useOverlayDraft } from "./useOverlayDraft";
import { overlayDraftKey, readOverlayDraft } from "../lib/overlayDraft";
const initial = useAppStore.getState();
let node: HTMLDivElement; let root: Root;
let draft: ReturnType<typeof useOverlayDraft>;
function Fixture() { draft = useOverlayDraft("scratchpad", "Scratchpad/day.md", "legacy", "day"); return <textarea readOnly value={draft.content} />; }
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; }
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useAppStore.setState({ ...initial, vaultPath: "/vault", files: [{ relPath: "Scratchpad/day.md", path: "/vault/Scratchpad/day.md", name: "day", ext: "md", isMarkdown: true }], saveOverlayArtifact: io.save });
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); useAppStore.setState(initial); });
it("a delayed initial read and file-list refresh cannot overwrite typing", async () => {
  const read = deferred<{ ok: true; text: string }>(); io.read.mockReturnValue(read.promise);
  await act(async () => root.render(<Fixture />));
  act(() => draft.edit("newer local text"));
  await act(async () => { read.resolve({ ok: true, text: "older disk" }); });
  act(() => useAppStore.setState({ files: [...useAppStore.getState().files] }));
  expect(draft.content).toBe("newer local text"); expect(io.read).toHaveBeenCalledTimes(1);
  expect(readOverlayDraft(overlayDraftKey("/vault", "Scratchpad/day.md"))).toMatchObject({ baseline: "older disk", dirty: true });
});
it("preserves edits made during save and advances only their baseline", async () => {
  io.read.mockResolvedValue({ ok: true, text: "disk" });
  await act(async () => root.render(<Fixture />));
  act(() => draft.edit("first"));
  const save = deferred<string>(); io.save.mockReturnValue(save.promise);
  let pending!: Promise<void>;
  act(() => { pending = draft.save(); });
  act(() => draft.edit("second"));
  await act(async () => { save.resolve("Scratchpad/day.md"); await pending; });
  expect(draft.content).toBe("second");
  expect(readOverlayDraft(overlayDraftKey("/vault", "Scratchpad/day.md"))).toMatchObject({ content: "second", baseline: "first", dirty: true });
});
it("failed reads preserve drafts and refuse save authority", async () => {
  localStorage.setItem("legacy", "kept"); io.read.mockResolvedValue({ ok: false, error: "offline" });
  await act(async () => root.render(<Fixture />));
  expect(draft.content).toBe("kept"); expect(draft.ready).toBe(false);
  await act(async () => draft.save()); expect(io.save).not.toHaveBeenCalled();
});
it("reopening during a save retains newer typing and the committed baseline", async () => {
  io.read.mockResolvedValue({ ok: true, text: "disk" });
  await act(async () => root.render(<Fixture />));
  act(() => draft.edit("saving"));
  const save = deferred<string>(); io.save.mockReturnValue(save.promise);
  let pending!: Promise<void>;
  act(() => { pending = draft.save(); });
  await act(async () => root.render(null));
  await act(async () => root.render(<Fixture />));
  expect(draft.ready).toBe(false);
  act(() => draft.edit("typed after reopening"));
  io.read.mockResolvedValue({ ok: true, text: "saving" });
  await act(async () => { save.resolve("Scratchpad/day.md"); await pending; });
  expect(draft.content).toBe("typed after reopening");
  expect(draft.ready).toBe(true);
  expect(readOverlayDraft(overlayDraftKey("/vault", "Scratchpad/day.md"))).toMatchObject({ content: "typed after reopening", baseline: "saving", dirty: true });
});
it("an old read cannot publish into a replacement mount", async () => {
  const old = deferred<{ ok: true; text: string }>(); io.read.mockReturnValueOnce(old.promise);
  await act(async () => root.render(<Fixture />));
  await act(async () => root.render(null));
  io.read.mockResolvedValue({ ok: true, text: "fresh" });
  await act(async () => root.render(<Fixture />));
  act(() => draft.edit("new draft"));
  await act(async () => old.resolve({ ok: true, text: "stale" }));
  expect(draft.content).toBe("new draft");
  expect(readOverlayDraft(overlayDraftKey("/vault", "Scratchpad/day.md"))).toMatchObject({ baseline: "fresh" });
});
it("a rejected save can be retried without losing the draft", async () => {
  io.read.mockResolvedValue({ ok: true, text: "disk" });
  await act(async () => root.render(<Fixture />));
  act(() => draft.edit("kept"));
  io.save.mockRejectedValueOnce(new Error("interrupted"));
  await act(async () => draft.save());
  expect(draft.saving).toBe(false); expect(draft.content).toBe("kept");
  io.save.mockResolvedValue("Scratchpad/day.md");
  await act(async () => draft.save());
  expect(io.save).toHaveBeenCalledTimes(2);
  expect(readOverlayDraft(overlayDraftKey("/vault", "Scratchpad/day.md"))).toMatchObject({ content: "kept", baseline: "kept", dirty: false });
});
