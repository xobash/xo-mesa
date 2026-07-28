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
