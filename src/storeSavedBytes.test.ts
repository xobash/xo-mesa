// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { useAppStore } from "./store";
import type { VaultFile } from "./types";

const initial = useAppStore.getState();
afterEach(() => useAppStore.setState(initial, true));

const rtf: VaultFile = { path: "/v/Letter.rtf", relPath: "Letter.rtf", name: "Letter", ext: "rtf", isMarkdown: false };
const png: VaultFile = { path: "/v/Photo.png", relPath: "Photo.png", name: "Photo", ext: "png", isMarkdown: false };

// The watcher skips a change whose decoded text equals the cached text. A
// byte-level save that left the old text cached was reported as "File changed
// outside Mesa" right after Mesa's own RTF save.
it("records the text of a byte-level save the way the watcher will read it", () => {
  useAppStore.setState({ files: [rtf, png], contentCache: { "Letter.rtf": "{\\rtf1 old}" } });
  const saved = new TextEncoder().encode("﻿{\\rtf1 new\\par}");
  useAppStore.getState().adoptSavedBytes("Letter.rtf", saved, rtf.path);
  expect(useAppStore.getState().contentCache["Letter.rtf"]).toBe(new TextDecoder().decode(saved));
  useAppStore.getState().adoptSavedBytes("Photo.png", new Uint8Array([137, 80, 78, 71]), png.path);
  expect(useAppStore.getState().contentCache["Photo.png"]).toBeUndefined();
});

// A save still in flight when the user switched vault finished after the new
// vault opened; its text was cached under the same relative path there.
it("ignores a finished save whose file is no longer the open one", () => {
  const other: VaultFile = { ...rtf, path: "/other/Letter.rtf" };
  useAppStore.setState({ files: [other], contentCache: { "Letter.rtf": "{\\rtf1 theirs}" } });
  useAppStore.getState().adoptSavedBytes("Letter.rtf", new TextEncoder().encode("{\\rtf1 mine}"), rtf.path);
  expect(useAppStore.getState().contentCache["Letter.rtf"]).toBe("{\\rtf1 theirs}");
  expect(useAppStore.getState().notes["Letter.rtf"]).toBeUndefined();
});

// Replacing the record dropped its title and thumbnail and gave the graph a
// new notes object on every save, even when no link or tag changed.
it("refreshes the saved file's note record instead of replacing it", () => {
  const known = { relPath: "Letter.rtf", title: "Dear Ada", rawLinks: [], rawReferences: [], tags: [], aliases: [], firstImagePath: "pics/a.png" };
  const notes = { "Letter.rtf": known } as unknown as ReturnType<typeof useAppStore.getState>["notes"];
  useAppStore.setState({ files: [rtf], notes, contentCache: {} });
  useAppStore.getState().adoptSavedBytes("Letter.rtf", new TextEncoder().encode("{\\rtf1 plain}"), rtf.path);
  expect(useAppStore.getState().notes).toBe(notes);
  useAppStore.getState().adoptSavedBytes("Letter.rtf", new TextEncoder().encode("{\\rtf1 see #tag}"), rtf.path);
  const after = useAppStore.getState().notes["Letter.rtf"];
  expect(after.title).toBe("Dear Ada");
  expect(after.firstImagePath).toBe("pics/a.png");
  expect(after.tags).toContain("tag");
});
