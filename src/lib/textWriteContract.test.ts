import { describe, expect, it } from "vitest";
// Mesa's note-TEXT pipeline (readNote → contentCache → writeNote) may only
// ever touch files it can round-trip as text. When it did not, a PDF open in
// the workspace was replaced with ZERO BYTES the moment the window lost focus:
// `flushSave` wrote `contentCache[active] ?? ""` for whatever file was active,
// and a PDF never has a cache entry because it is never read as text. No edit,
// no Save, no agent involved — just blur/hide/quit.
//
// `vault.test.ts` covers the decision itself (`isTextualVaultFile`,
// `flushableNoteText`, and writeNote failing closed). These contract tests pin
// the CALL SITES, because the defect was never in a helper — it was a caller
// treating "no cached text" as "empty document" for a file that has no text at
// all. store.ts owns the app's mutable state and cannot be instantiated in a
// unit test (Tauri event/window imports), so its source is asserted directly.
import store from "../store.ts?raw";
import vault from "./vault.ts?raw";

/** The body of a top-level store action, from `name: (` to the next action. */
function storeAction(name: string): string {
  const start = store.indexOf(`    ${name}: (`);
  expect(start, `${name} not found in store.ts`).toBeGreaterThan(-1);
  const rest = store.slice(start + 1);
  const end = rest.search(/\n    \}?,?\n\n {4}[A-Za-z_$][\w$]*: /);
  return end < 0 ? rest : rest.slice(0, end);
}

describe("text-write gate: writeNote is the last checkpoint", () => {
  it("writeNote refuses non-text targets before any filesystem work", () => {
    const body = vault.slice(vault.indexOf("export async function writeNote("));
    const guard = body.indexOf("if (!isTextualVaultFile(file))");
    const demoWrite = body.indexOf("demoWrite(");
    const persist = body.indexOf("persistVerifiedBytes(");
    expect(guard).toBeGreaterThan(-1);
    // The guard must come before BOTH write paths, so no caller can reach the
    // disk (or the demo vault) with a text-encoded overwrite of a binary file.
    expect(demoWrite).toBeGreaterThan(guard);
    expect(persist).toBeGreaterThan(guard);
  });

  it("keeps one definition of what Mesa may treat as text", () => {
    expect(vault).toContain("export function isTextualVaultFile(");
    expect(vault).toContain("export function flushableNoteText(");
    // The read side that decides whether to load content, and every write
    // side, ask the same question — that agreement is the whole fix.
    expect(store).toContain("const textual = isTextualVaultFile(file);");
  });
});

describe("text-write gate: crash-safety flush", () => {
  const flush = storeAction("flushSave");

  it("never invents empty content for the active file", () => {
    // The exact shape of the data-loss bug. `?? ""` here means "a file we hold
    // no text for is an empty document", which is only ever true by accident.
    expect(flush).not.toMatch(/contentCache\[[^\]]*\]\s*\?\?\s*""/);
    expect(flush).toContain("flushableNoteText(file, get().contentCache[active])");
  });

  it("writes only what flushableNoteText allows", () => {
    expect(flush).toContain("if (pending === null) return;");
    const decision = flush.indexOf("flushableNoteText(");
    const write = flush.indexOf("writeNote(");
    expect(decision).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(decision);
    // One write call, and it writes the vetted text — not the raw cache.
    expect(flush.match(/writeNote\(/g)).toHaveLength(1);
    expect(flush).toContain("writeNote(file, pending)");
  });

  it("is still wired to the events that make it crash-safe", () => {
    // Preserved behaviour: the flush must keep running on blur/hide/quit for
    // real notes. Fixing the corruption must not have disabled autosave.
    expect(store).toContain("flushSave: () => {");
    expect(flush).toContain("writeNote(");
  });
});

describe("text-write gate: debounced editor save", () => {
  const setContent = storeAction("setContentFromEditor");

  it("routes the debounced save through the same decision", () => {
    expect(setContent).toContain("flushableNoteText(file,");
    expect(setContent).toContain("pending !== null");
  });
});

describe("text-cache freshness: external modifications", () => {
  // The watcher's modify branch refreshed `contentCache` for `isMarkdown` only.
  // That was survivable while markdown was the only thing cached at vault open,
  // but `planTextCache` now caches every textual file within its budget, so an
  // external edit to a .txt/.py/.json/.html left Mesa holding the old bytes for
  // the rest of the session — searchable, openable, and re-writable over the
  // newer file, since neither save path passes an expected-bytes precondition.
  const watcher = (() => {
    const start = store.indexOf("  async function handleExternalChange(");
    expect(start, "handleExternalChange not found in store.ts").toBeGreaterThan(-1);
    const rest = store.slice(start);
    const end = rest.indexOf("\n  async function setupWatcher(");
    return end < 0 ? rest : rest.slice(0, end);
  })();

  it("re-reads a cached textual file when it changes on disk", () => {
    expect(watcher).toContain("needsCachedTextRefresh(file, get().contentCache[rel])");
    const decision = watcher.indexOf("needsCachedTextRefresh(");
    const read = watcher.indexOf("readNote(file)", decision);
    // The refreshed text must reach the cache. It is queued for the batch's
    // single commit rather than written inline — see the batching test below.
    const queued = watcher.indexOf("pendingContent.set(rel, text)", read);
    expect(decision).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(decision);
    expect(queued).toBeGreaterThan(read);
    expect(watcher).toContain("next.contentCache = cache;");
  });

  it("leaves the document being typed in alone", () => {
    // Same rule the markdown branch uses: refreshing the active doc from disk
    // would discard the user's in-flight edit.
    expect(watcher).toContain("rel !== active &&");
  });

  it("does not churn the cache identity when the bytes are unchanged", () => {
    // Mesa's own verified saves fire this watcher. A set() per save would
    // invalidate every text subscriber for no change at all.
    expect(watcher).toContain("if (text !== get().contentCache[rel])");
  });

  it("commits the batch once instead of once per changed file", () => {
    // Watcher events arrive coalesced (60 ms window in `watchVault`), so a
    // device sync, a bulk agent write, or a git checkout inside the vault
    // delivers hundreds of paths at once. Spreading the whole content cache and
    // notes map per path is O(paths x cacheKeys) and fires one React cascade
    // per path over the entire sidebar: measured at this vault's dimensions
    // (2,452 cached files), 1,500 changed files cost 576 ms of object copying
    // versus 0.5 ms committed once.
    expect(watcher).toContain("const pendingContent = new Map<string, string>()");
    expect(watcher).toContain("const pendingNotes = new Map<string, NoteMeta>()");
    // The modify branches queue, they do not commit.
    expect(watcher).toContain("pendingContent.set(rel, text)");
    expect(watcher).toContain("filesDirty = true");
    // Exactly one commit for the whole batch, and it must survive a throw so a
    // late failing path cannot discard work the earlier paths already did.
    expect(watcher.match(/^\s*set\(next\);$/m)).not.toBeNull();
    expect(watcher).toContain("} finally {");
    expect(watcher).toContain("flush();");
  });

  it("never rebuilds the whole-vault array or maps inside the path loop", () => {
    // The regression this replaced: a `set({ ... })` carrying a fresh spread of
    // contentCache/notes, or a fresh `files` array, from inside the loop.
    const loop = watcher.slice(watcher.indexOf("for (const evt of events)"));
    const body = loop.slice(0, loop.indexOf("} finally {"));
    expect(body).not.toMatch(/set\(\{[^}]*\.\.\.get\(\)\.contentCache/);
    expect(body).not.toMatch(/set\(\{\s*files: \[\.\.\.get\(\)\.files\]/);
  });

  it("builds the vault's relPath list only when a path actually needs it", () => {
    // `normalizeVaultRelPath` reads the list only for an absolute path outside
    // the vault root. Building it per event path copied every file in the vault
    // each time — 45.5 ms per 1,500-path batch at this vault's size. The cheap
    // two-argument call must come first, and the list must be memoized on the
    // `files` identity so it can never be consulted stale.
    // `vault.test.ts` proves the two call forms agree on every path shape.
    expect(watcher).toContain("let rel = normalizeVaultRelPath(p, rootRaw);");
    expect(watcher).toContain("knownFrom !== cur");
    const loop = watcher.slice(watcher.indexOf("for (const evt of events)"));
    const body = loop.slice(0, loop.indexOf("} finally {"));
    expect(body).not.toMatch(/get\(\)\.files\.map\(\(f\) => f\.relPath\)/);
  });

  it("rescans the whole vault at most once per batch", () => {
    // `refreshMissingExternalFiles` is a full `scanVault` (4,165 readDir +
    // 4,165 stat IPC round-trips on a real vault). Running it per unresolved
    // path is unbounded work inside an event handler. Every site must go
    // through the once-per-batch helper, and anything created after that
    // rescan goes to the debounced refresh instead of another full scan.
    expect(watcher).toContain("if (rescanned) return;");
    // Exactly one real call, inside the helper.
    expect(
      watcher.match(/await refreshMissingExternalFiles\(rootRaw\);/g)
    ).toHaveLength(1);
    // ...and every caller in the loop uses the helper.
    expect(watcher.match(/await rescanOnce\(\);/g)).toHaveLength(2);
    expect(watcher).toContain("if (!rel) scheduleExternalRefresh(rootRaw);");
  });

  it("ignores paths scanVault would never index, instead of rescanning for them", () => {
    // The freeze: `.git/index` passed the basename-only dot check, was absent
    // from `files`, was refused by registerExternalFile, and so fell through to
    // a whole-vault rescan — once per path, for every file a git operation
    // touches. `vault.test.ts` pins the rule against a real scanVault run.
    expect(watcher).toContain("if (!isIndexableVaultRelPath(rel)) continue;");
    expect(watcher).not.toMatch(/const relBase = rel\.replace/);
    // The registration path applies the same single definition.
    const register = store.slice(
      store.indexOf("  async function registerExternalFile("),
      store.indexOf("  async function refreshMissingExternalFiles(")
    );
    expect(register).toContain("if (!isIndexableVaultRelPath(rel)) return;");
    expect(register).not.toMatch(/p === "node_modules" \|\| p === "\.git"/);
  });
});

describe("text-write gate: content cache", () => {
  it("never caches a lossy text decode of a binary file", () => {
    // `readNote` decodes bytes as UTF-8. Caching that for a PDF/image would
    // hand every text consumer — including the flush — a corrupt "document".
    // The activity bridge calls ensureContent for whatever path an agent
    // touches, so this is a reachable path, not a hypothetical one.
    const ensure = store.slice(store.indexOf("    ensureContent: async ("));
    const guard = ensure.indexOf("if (!isTextualVaultFile(file)) return \"\";");
    const read = ensure.indexOf("readNote(file)");
    expect(guard).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(guard);
  });
});
