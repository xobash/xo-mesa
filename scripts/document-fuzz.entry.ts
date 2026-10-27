import { sanitizeHtml, renderMarkdown } from "../src/lib/markdown";
import { savedHtmlFrameDocument } from "../src/lib/html";
import { buildReaderHtml, READER_BRIDGE } from "../src/lib/browserReader";
import { rtfToText } from "../src/lib/rtf";
import { inspectZipForImport, ZIP_IMPORT_LIMITS } from "../src/lib/zipCodec";
import { decodeTextChunkOutcomes } from "../src/lib/vault";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function inert(markup: string, reader = false): Document {
  const doc = new DOMParser().parseFromString(markup, "text/html");
  assert(!doc.querySelector("iframe,frame,object,embed,base,form"), "active element survived");
  const scripts = [...doc.querySelectorAll("script")];
  assert(reader ? scripts.length === 1 && scripts[0].outerHTML === READER_BRIDGE : scripts.length === 0, "script survived");
  for (const element of doc.querySelectorAll("*")) {
    for (const attr of element.attributes) {
      assert(!/^on/i.test(attr.name) && !["srcdoc", "formaction", "ping"].includes(attr.name), `active attribute ${attr.name}`);
      if (["src", "href", "xlink:href", "action"].includes(attr.name)) {
        assert(!/^(?:javascript|vbscript):/i.test(attr.value.replace(/[\s\x00-\x1f]/g, "")), "executable URL survived");
      }
    }
  }
  return doc;
}

export function checkText(input: string): void {
  const sanitized = sanitizeHtml(input);
  inert(sanitized);
  inert(sanitizeHtml(sanitized)); // Reparse the sanitized bytes as the real sink does.
  inert(renderMarkdown(input));
  for (const online of [false, true]) {
    const doc = inert(savedHtmlFrameDocument(input, online));
    assert(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content")?.includes("script-src 'none'"), "saved policy missing");
    assert(!doc.querySelector("a[href]"), "saved frame retained navigation");
  }
  const reader = inert(buildReaderHtml(input, "https://example.com/research/"), true);
  for (const a of reader.querySelectorAll("a[href]")) assert(/^https?:$/.test(new URL(a.getAttribute("href")!).protocol), "reader link bypass");
  const text = rtfToText(input);
  assert(text.length <= input.length * 2 + 2, "RTF expanded beyond bound");
}

export function checkBytes(input: Uint8Array): void {
  try {
    const entries = inspectZipForImport(input);
    assert(entries.length <= ZIP_IMPORT_LIMITS.maxEntries, "ZIP count bypass");
    assert(entries.reduce((n, e) => n + e.expandedBytes, 0) <= ZIP_IMPORT_LIMITS.maxExpandedBytes, "ZIP expansion bypass");
    for (const entry of entries) assert(!entry.name.replace(/\\/g, "/").split("/").includes(".."), "ZIP traversal bypass");
  } catch (error) {
    if (!(error instanceof Error) || /bypass/.test(error.message)) throw error;
  }
  try {
    const frames = decodeTextChunkOutcomes(input);
    assert(frames.length <= Math.floor(input.length / 4), "IPC frame count bypass");
    const wire = new Uint8Array(4 + frames.reduce((n, frame) => n + 4 + (frame.kind === "content" ? new TextEncoder().encode(frame.text).length : 0), 0));
    const view = new DataView(wire.buffer);
    view.setUint32(0, frames.length, true);
    let at = 4;
    for (const frame of frames) {
      const bytes = frame.kind === "content" ? new TextEncoder().encode(frame.text) : null;
      view.setUint32(at, bytes ? bytes.length : frame.kind === "failed" ? 0xffffffff : 0xfffffffe, true);
      at += 4;
      if (bytes) { wire.set(bytes, at); at += bytes.length; }
    }
    assert(JSON.stringify(decodeTextChunkOutcomes(wire)) === JSON.stringify(frames), "IPC outcome roundtrip bypass");
  } catch (error) {
    if (!(error instanceof Error) || /bypass/.test(error.message)) throw error;
  }
}
