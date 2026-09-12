import settingsSource from "./settings.ts?raw";
import { describe, expect, it } from "vitest";
// `fileFor` answers from a Map rebuilt whenever the `files` array identity
// changes. That is only sound while every mutation REPLACES the array rather
// than editing the store's copy in place, so the invariant is pinned here.
// store.ts owns the app's mutable state and cannot be instantiated in a unit
// test (Tauri event/window imports), so its source is asserted directly — the
// same approach `textWriteContract.test.ts` uses.
import store from "../store.ts?raw";
import fileIndex from "./fileIndex.ts?raw";

describe("fileFor: identity-keyed index", () => {
  it("looks up through the index instead of scanning every file", () => {
    // 11.2 us per linear lookup at 4,165 files, and it is asked on selection,
    // on every viewer render, and up to three times per path in the watcher.
    expect(store).toContain("fileFor: (relPath) => fileIndexFor(get().files).get(relPath)");
    expect(store).not.toContain("get().files.find((f) => f.relPath === relPath)");
  });

  it("rebuilds only when the files array identity changes", () => {
    expect(fileIndex).toContain("if (source !== files) {");
    expect(fileIndex).toContain("source = files;");
  });

  it("keeps Array.find's first-match semantics", () => {
    // `new Map(files.map(...))` would keep the LAST entry for a duplicated
    // relPath; `find` returns the first. The difference is only reachable if a
    // duplicate ever slips in, which is exactly when it would matter.
    expect(fileIndex).toContain(
      "for (const file of files) if (!index.has(file.relPath)) index.set(file.relPath, file);"
    );
  });

  it("never mutates the store's files array in place", () => {
    // The one way to make the index stale: push/sort/splice the SAME array the
    // store already holds, leaving its identity unchanged. Every such call in
    // store.ts must operate on a local copy.
    const inPlace = [...store.matchAll(/get\(\)\.files\.(push|sort|splice|shift|pop|reverse)\(/g)];
    expect(inPlace.map((m) => m[0])).toEqual([]);

    // The one site that does push/sort takes a copy first.
    const importer = store.slice(store.indexOf("const files = [...get().files];"));
    expect(importer.slice(0, 2000)).toContain("files.push(f);");
    expect(store).toContain("const files = [...get().files];");
  });
});

describe("persisted sync port boundary", () => {
  it("heals loaded and programmatic values before native startup", () => {
    expect(settingsSource).toContain(
      "next.syncPort = normalizeSyncPort("
    );
    expect(store).toContain(
      'key === "syncPort"\n          ? normalizeSyncPort(value, get().settings.syncPort)'
    );
    expect(store).toContain("settings: bootSettings.settings");
    expect(store).toContain("const bootSettings = loadSettings()");
  });
});
