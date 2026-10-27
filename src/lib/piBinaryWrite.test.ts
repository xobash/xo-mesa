/**
 * Reproduction of the reported PDF corruption, and the guarantee that fixes it.
 *
 * This file reproduces the corruption end to end on real PDF bytes, then
 * executes the shipped Pi activity extension (`src-tauri/resources/mesa-activity.ts`)
 * to check the block that prevents it and the activity it reports.
 *
 * Deliberately written against web-standard APIs only (`Uint8Array`,
 * `TextDecoder`/`TextEncoder`) rather than Node's `Buffer`/`fs`: Mesa's
 * tsconfig covers `src` with DOM libs and no `@types/node`, and the Pi
 * extensions in `src-tauri/resources` are Node code that lives outside that
 * boundary on purpose. Keeping this test inside the boundary means it is
 * typechecked like the rest of the app.
 */
import { describe, expect, it, vi } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { transpileModule, ScriptTarget, ModuleKind } from "typescript";
import activityExtension from "../../src-tauri/resources/mesa-activity.ts?raw";
import { hasPdfEofMarker, sanitizePdfBytes } from "./pdfBytes";

type ToolCallResult = { block: true; reason: string } | undefined;

/** Runs the shipped extension with a fake Pi host, bridge and filesystem. */
function activityHook(existing: string[] = []) {
  const js = transpileModule(
    activityExtension
      .replace('import { resolve } from "node:path";', "")
      .replace('import { existsSync } from "node:fs";', "")
      .replace("export default function", "function"),
    { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ESNext } },
  ).outputText;
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response("ok"));
  const resolve = (cwd: string, path: string) => (path.startsWith("/") ? path : `${cwd}/${path}`);
  const existsSync = (path: string) => existing.includes(path);
  const register = new Function("process", "fetch", "resolve", "existsSync", `${js}; return mesaActivity;`)(
    { env: { MESA_ACTIVITY_PORT: "8788", MESA_ACTIVITY_TOKEN: "test-token", MESA_VAULT_PATH: "/vault" }, cwd: () => "/" },
    fetch,
    resolve,
    existsSync,
  );
  let hook: (event: { toolName?: string; input?: Record<string, unknown> }) => ToolCallResult = () => undefined;
  register({ on: (name: string, handler: typeof hook) => { if (name === "tool_call") hook = handler; } });
  return {
    call: (toolName: string, path?: unknown) => hook({ toolName, input: { path } }),
    reported: () => fetch.mock.calls.map(([, init]) => JSON.parse(String(init.body)) as { path: string; op: string }),
  };
}

/** A realistic PDF: real files carry compressed streams and embedded font
 *  programs, and that is where the non-UTF-8 bytes live. A text-only PDF with
 *  no embedded resources survives a round-trip nearly intact and would not
 *  reproduce this at all. */
async function makeRealisticPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([300, 200]).drawText("Mesa corruption regression fixture", {
    font,
    size: 14,
  });
  return doc.save();
}

/** Exactly what a text-oriented `write`/`edit` tool does to a file: decode the
 *  bytes to a string, hand that to the model, encode the result back. */
function textToolRoundTrip(bytes: Uint8Array): {
  text: string;
  bytes: Uint8Array;
} {
  const text = new TextDecoder().decode(bytes);
  return { text, bytes: new TextEncoder().encode(text) };
}

describe("Pi writing a PDF (the reported corruption)", () => {
  it("reproduces it: a text round-trip destroys a real PDF", async () => {
    const original = await makeRealisticPdf();
    const roundTripped = textToolRoundTrip(original);

    // Every byte sequence that isn't valid UTF-8 decodes to U+FFFD and can
    // never be encoded back to what it was. No malice, no bug in the tool —
    // the encode step alone is lossy and irreversible.
    const destroyed = (roundTripped.text.match(/�/g) ?? []).length;
    expect(destroyed).toBeGreaterThan(100);

    // Each destroyed sequence becomes a 3-byte U+FFFD, so the file grows even
    // though nothing was added: a size change with no edit.
    expect(roundTripped.bytes).not.toEqual(original);
    expect(roundTripped.bytes.length).toBeGreaterThan(original.length);

    // The original parses cleanly; the round-tripped bytes carry objects that
    // no longer parse. Asserted strictly on purpose — pdf-lib's default lenient
    // mode often *appears* to recover such a file, which is exactly why this
    // corruption goes unnoticed until something needs the damaged object.
    await expect(
      PDFDocument.load(original, { throwOnInvalidObject: true })
    ).resolves.toBeDefined();
    await expect(
      PDFDocument.load(roundTripped.bytes, { throwOnInvalidObject: true })
    ).rejects.toThrow();
  });

  it("is undetectable downstream — the wreckage still looks like a PDF", async () => {
    const roundTripped = textToolRoundTrip(await makeRealisticPdf()).bytes;
    // Both of Mesa's cheap structural checks pass on the corrupted bytes, so
    // nothing after the write can be relied on to notice. Refusing the write is
    // the only place this is catchable.
    expect(() => sanitizePdfBytes(roundTripped)).not.toThrow();
    expect(hasPdfEofMarker(roundTripped)).toBe(true);
  });

  it("never happens now: every content-write tool is refused on a PDF", () => {
    const ext = activityHook();
    for (const tool of ["write", "edit", "apply_patch"]) {
      expect(ext.call(tool, "/vault/report.pdf")?.block, tool).toBe(true);
    }
    // A blocked write never happens, so it is not reported as activity.
    expect(ext.reported()).toEqual([]);
  });

  it("leaves the rest of the agent workflow intact", () => {
    const ext = activityHook();
    // Reading a PDF is fine, and bash still reaches it so the agent can use a
    // real format-aware tool.
    expect(ext.call("read", "/vault/report.pdf")).toBeUndefined();
    expect(ext.call("bash", "/vault/report.pdf")).toBeUndefined();
    // Writing notes — the intended workflow — is untouched.
    for (const path of ["note.md", "data.json", "Notes/deep/nested.md", "styles.css"]) {
      expect(ext.call("write", path), path).toBeUndefined();
    }
  });
});

describe("shipped Pi activity extension", () => {
  it("names the offending path and the routes that do work", () => {
    const blocked = activityHook().call("write", "/vault/Papers/thesis.pdf");
    expect(blocked?.reason).toContain("binary file");
    expect(blocked?.reason).toContain("/vault/Papers/thesis.pdf");
    // The reason string is the model's only feedback — without these it just
    // retries the same corrupting write with different content.
    expect(blocked?.reason).toContain("Do not retry");
    expect(blocked?.reason).toContain("bash");
  });

  it("blocks regardless of tool-name case or path separator", () => {
    const ext = activityHook();
    expect(ext.call("WRITE", "C:\\vault\\Report.PDF")?.block).toBe(true);
    expect(ext.call("Edit", "/vault/scan.PdF")?.block).toBe(true);
  });

  it("covers the binary formats most likely to be in a vault and leaves text alone", () => {
    const ext = activityHook();
    for (const extension of ["pdf", "docx", "xlsx", "png", "jpg", "zip", "mp4", "sqlite"]) {
      expect(ext.call("write", `/vault/file.${extension}`)?.block, extension).toBe(true);
    }
    for (const path of ["/vault/note.md", "/vault/data.json", "/vault/a.txt", "/vault/page.svg", "/vault/doc.rtf", "/vault/rows.csv"]) {
      expect(ext.call("write", path), path).toBeUndefined();
    }
  });

  it("treats a dotfile or a trailing dot as having no extension", () => {
    const ext = activityHook();
    for (const path of ["/vault/.pdf", "/vault/README", "/vault/trailing."]) {
      expect(ext.call("write", path), path).toBeUndefined();
    }
  });

  it("never blocks reads, bash or grep, and ignores calls with no usable path", () => {
    const ext = activityHook();
    for (const tool of ["read", "bash", "grep"]) expect(ext.call(tool, "/vault/report.pdf"), tool).toBeUndefined();
    for (const path of [undefined, "", 42]) expect(ext.call("write", path)).toBeUndefined();
    expect(ext.reported()).toEqual([{ path: "/vault/report.pdf", op: "read" }]);
  });

  it("reports file tools as graph activity and ignores the rest", () => {
    const ext = activityHook(["/vault/existing.md"]);
    ext.call("read", "notes/a.md");
    ext.call("Read", "/vault/b.md");
    ext.call("edit", "/vault/c.md");
    ext.call("write", "/vault/existing.md");
    ext.call("write", "/vault/new.md");
    for (const tool of ["bash", "grep", "find", "ls", "deploy"]) ext.call(tool, "/vault/d.md");
    expect(ext.reported()).toEqual([
      { path: "/vault/notes/a.md", op: "read" },
      { path: "/vault/b.md", op: "read" },
      { path: "/vault/c.md", op: "edit" },
      { path: "/vault/existing.md", op: "write" },
      { path: "/vault/new.md", op: "create" },
    ]);
  });
});
