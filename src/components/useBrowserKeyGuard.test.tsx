// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useBrowserKeyGuard } from "./useBrowserKeyGuard";
import { useAppStore } from "../store";
import type { VaultFile } from "../types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const initial = useAppStore.getState();
let host: HTMLDivElement;
let root: Root;
const note = { relPath: "Notes/Plan.md", name: "Plan", ext: "md" } as VaultFile;
const pending = [{ key: "/v/Notes/Plan.md", target: note, content: "x", failed: false }];

function Harness({ main }: { main: boolean }) { useBrowserKeyGuard(main, true); return null; }
const ctrlS = () => act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true, cancelable: true })); });

beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useAppStore.setState(initial, true);
});

it("says what Ctrl+S saved, and names PDF edits it could not save", async () => {
  const flushSave = vi.fn(async () => {});
  useAppStore.setState({ flushSave, pendingTextSaves: () => pending, dirtyBinaryPaths: [] });
  act(() => root.render(<Harness main={false} />));
  ctrlS();
  await vi.waitFor(() => expect(useAppStore.getState().status).toBe("Saved Notes/Plan.md."));
  expect(flushSave).toHaveBeenCalledTimes(1);
  useAppStore.setState({ pendingTextSaves: () => [], dirtyBinaryPaths: ["Docs/Form.pdf"] });
  ctrlS();
  await vi.waitFor(() => expect(useAppStore.getState().status).toBe("All text is saved. PDF edits in Docs/Form.pdf are not saved yet."));
});

it("keeps the save failure visible instead of claiming success", async () => {
  useAppStore.setState({
    pendingTextSaves: () => pending,
    flushSave: async () => {
      useAppStore.setState({ status: "Save failed for Notes/Plan.md: disk full" });
      throw new Error("disk full");
    },
  });
  act(() => root.render(<Harness main={false} />));
  ctrlS();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(useAppStore.getState().status).toBe("Save failed for Notes/Plan.md: disk full");
  useAppStore.setState({ status: "", flushSave: async () => { throw new Error("held"); } });
  ctrlS();
  await vi.waitFor(() => expect(useAppStore.getState().status).toBe("Save failed: Error: held"));
});
