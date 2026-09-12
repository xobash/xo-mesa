import { describe, expect, it } from "vitest";
// Wiring checks complement behavioral cache, store lifecycle and browser tests.
// Link-bearing text documents index before graph publication; other search text
// hydrates afterwards.
import store from "../store.ts?raw";
import indexSource from "./vaultIndex.ts?raw";
import searchSurface from "../components/SearchSurface.tsx?raw";
import metadataSource from "./vaultMetadata.ts?raw";

describe("vault open indexes graph text without blocking deferred search text", () => {
  it("reads link-bearing text documents before the graph is published", () => {
    const call = store.slice(
      store.indexOf("const indexed = await loadIndexedNotes("),
      store.indexOf("const notes = indexed.notes;")
    );
    expect(indexSource).toContain('files.filter(isTextualVaultFile)');
    expect(call).toContain('loadIndexedNotes');
    // `textPlan.extra` on the blocking read is exactly the regression this
    // guards: it put 70% of the reads in front of the first frame.
    expect(call).not.toContain("textPlan.extra");
  });

  it("hands the planned extra files to background hydration", () => {
    expect(store).toContain("void hydrateSearchCorpus(");
    expect(store).toContain("textPlan.extra,");
    expect(store).toContain("isCurrentOpen,");
    // Fire-and-forget: awaiting it would put the reads back on the open path.
    const openStage = store.slice(
      store.indexOf("void hydrateSearchCorpus("),
      store.indexOf("void hydrateSearchCorpus(") + 80
    );
    expect(openStage.startsWith("void")).toBe(true);
  });

  it("publishes the pending count so partial coverage is never silent", () => {
    expect(store).toContain("indexingTextFiles: textPlan.extra.length");
    // …and clears it, so the notice cannot stick after hydration finishes.
    expect(store).toContain("indexingTextFiles: 0,");
  });

  it("defers the per-file stat pass unless the sort order depends on it", () => {
    expect(store).toMatch(
      // `let`, not `const`: a crash recovery that restores a file re-scans.
      /let files = await scanVault\(root, \{[\s\S]*metadata: needsMetadataNow,[\s\S]*stopped: \(\) => !isCurrentOpen\(\),[\s\S]*\}\);/
    );
    expect(store).toContain(
      'const SORT_MODES_NEEDING_METADATA = new Set<SortMode>(["modified", "size"]);'
    );
    expect(store).toMatch(
      /if \(!needsMetadataNow\) \{\s+void hydrateVaultMetadata\(root, files, isCurrentOpen, get, set\);\s+\}/
    );
  });

  it("publishes deferred metadata exactly once, not per batch", () => {
    const body = metadataSource;
    // In-place mutation is what `PdfView`'s primitive-mtime subscription needs;
    // a single identity swap is what keeps the sidebar from re-sorting 4,165
    // files repeatedly.
    expect(body).toContain(
      "await loadVaultMetadata(files, () => !isCurrentOpen())"
    );
    expect((body.match(/set\(\{/g) ?? []).length).toBe(1);
    expect(body).toContain("get().vaultPath !== root || get().files !== files");
  });
});

describe("background hydration cannot corrupt live state", () => {
  const body = store.slice(
    store.indexOf("async function hydrateSearchCorpus("),
    store.indexOf("export const useAppStore")
  );

  it("merges absent keys only, so a live edit always wins", () => {
    // An editor edit, a watcher refresh or a lazy `ensureContent` read can fill
    // the same key while this runs; all of them are newer than these bytes.
    expect(body).toContain("mergeAbsentText(cache, selected.accepted)");
    expect(body).not.toMatch(/contentCache:\s*\{\s*\.\.\.get\(\)\.contentCache/);
  });

  it("abandons the work when the vault changes underneath it", () => {
    expect(body).toContain("get().vaultPath !== root");
    expect(body).toContain("!isCurrentOpen()");
    // Passed as `stopped` so `streamTextBatches` polls it before every read…
    expect(body).toContain("stopped,");
    // …and re-checked on the commit side, which runs after an await.
    expect(body).toContain(
      "if (!isCurrentOpen() || get().vaultPath !== root) return;"
    );
  });

  it("treats a newer open of the same path as a different lifecycle", () => {
    expect(store).toContain("let vaultOpenGeneration = 0;");
    expect(store).toContain("const openGeneration = ++vaultOpenGeneration;");
    expect(store).toContain(
      "const isCurrentOpen = () => vaultOpenGeneration === openGeneration && requestIsCurrent();"
    );
    expect(store).toContain("stopped: () => !isCurrentOpen(),");
    expect(store).toContain("() => !isCurrentOpen()");
  });

  it("enforces the memory ceiling on real characters, not stat sizes", () => {
    // The scan's `size` metadata is no longer available on the open path, and a
    // JS string costs its length rather than its UTF-8 byte count.
    expect(body).toContain("selectTextWithinBudget(");
    expect(body).toContain("chars = selected.usedChars");
    expect(body).toContain("budgetSkipped += selected.skipped");
    expect(body).toContain("if (chars >= TEXT_CACHE_BUDGET_CHARS) overBudget = true;");
    expect(body).toMatch(
      /const stopped = \(\) =>\s+overBudget \|\| !isCurrentOpen\(\) \|\| get\(\)\.vaultPath !== root;/
    );
    expect(body).toContain("readVaultTextOptional(root, group)");
    expect(body).toContain("text == null ? null : interner.intern(text)");
    // Whatever the ceiling drops has to be reported, not silently missing.
    expect(body).toContain("unindexedTextFiles:");
    expect(body).toContain("get().unindexedTextFiles +");
    expect(body).toContain("budgetSkipped +");
  });

  it("skips an unreadable file instead of aborting the vault", () => {
    expect(body).toContain("onError:");
    expect(body).toContain("search index skipped an unreadable file");
  });

  it("shares one instance per distinct document and drops the interner after", () => {
    // The buckets would otherwise pin every distinct document a second time,
    // including any the character ceiling declined to cache.
    expect(store).toContain("const interner = createTextInterner();");
    expect(body).toContain("interner.intern(await readNote(file))");
    expect(body).toContain("interner.clear()");
  });

  it("buffers through streamTextBatches rather than inline await", () => {
    // `batch.set(key, await read(item))` binds the Map before suspending, so a
    // worker resuming after a flush writes into a discarded buffer — it lost
    // 180 of 1,731 files while still reporting completion. The batching lives
    // in `searchCorpus.ts`, where `searchCorpus.test.ts` pins it.
    expect(body).toContain("await streamTextBatches(");
    expect(body).not.toMatch(/\.set\([^)]*await /);
  });
});

describe("the search UI discloses both kinds of partial coverage", () => {
  it("shows a transient notice while the corpus is still hydrating", () => {
    expect(searchSurface).toContain(
      "const indexingTextFiles = useAppStore((s) => s.indexingTextFiles);"
    );
    expect(searchSurface).toMatch(
      /\{indexingTextFiles > 0 && \(term\.length >= 2 \|\| ext\) && \(/
    );
    expect(searchSurface).toContain("Search is ready. Results may grow while Mesa indexes");
  });

  it("keeps the permanent budget notice as a separate statement", () => {
    // The two are different facts: one resolves on its own, the other never
    // does. Collapsing them would tell the user the wrong thing.
    expect(searchSurface).toMatch(
      /\{unindexedTextFiles > 0 && \(term\.length >= 2 \|\| ext\) && \(/
    );
    expect(searchSurface).toContain("because the full-text cache budget is limited");
  });
});
