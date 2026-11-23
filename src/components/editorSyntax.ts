import type { Extension } from "@codemirror/state";
import { StreamLanguage, type StringStream } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { langForExt, langSpec, type LangSpec } from "../lib/highlight";
import { isEditableTextExt } from "../lib/vault";

// Editor-only helper: imported by Editor.tsx alone, so it stays in the lazy
// editor chunk with CodeMirror. Token rules come from lib/highlight.ts, the
// same rules the read-only code view uses.

interface StreamState {
  /** Closing marker of the block comment the line starts inside, if any. */
  block: string | null;
}

function insideBlock(stream: StringStream, state: StreamState, close: string): string {
  const end = stream.string.indexOf(close, stream.pos);
  if (end < 0) stream.skipToEnd();
  else {
    stream.pos = end + close.length;
    state.block = null;
  }
  return "comment";
}

function lineComment(stream: StringStream, spec: LangSpec): boolean {
  for (const marker of spec.line) {
    const alpha = /[A-Za-z]/.test(marker[0]);
    // Alphabetic markers (`rem`) count only at line start and as a whole word.
    if (alpha && stream.string.slice(0, stream.start).trim() !== "") continue;
    if (stream.string.slice(stream.pos, stream.pos + marker.length).toLowerCase() !== marker.toLowerCase()) continue;
    if (alpha && /[A-Za-z0-9_$]/.test(stream.string[stream.pos + marker.length] ?? " ")) continue;
    stream.skipToEnd();
    return true;
  }
  return false;
}

function quoted(stream: StringStream, quote: string): string {
  stream.next();
  let ch: string | void;
  while ((ch = stream.next()) !== undefined) {
    if (ch === "\\") stream.next();
    else if (ch === quote) break;
  }
  return "string";
}

function tokenFor(spec: LangSpec) {
  return (stream: StringStream, state: StreamState): string | null => {
    if (state.block) return insideBlock(stream, state, state.block);
    if (stream.eatSpace()) return null;
    if (spec.block && stream.match(spec.block[0])) {
      state.block = spec.block[1];
      return insideBlock(stream, state, spec.block[1]);
    }
    if (lineComment(stream, spec)) return "comment";
    const ch = stream.peek() ?? "";
    if (spec.quotes.includes(ch)) return quoted(stream, ch);
    if (/[0-9]/.test(ch)) {
      stream.match(/^[0-9._xXa-fA-F]+/);
      return "number";
    }
    const word = stream.match(/^[A-Za-z_$][A-Za-z0-9_$]*/) as RegExpMatchArray | null;
    if (word) return spec.keywords.has(word[0]) ? "keyword" : null;
    stream.next();
    return null;
  };
}

const languages = new Map<string, Extension>();

/** Incremental token highlighting for source files. CodeMirror parses
 *  lazily up to the viewport, so typing in a large file stays local. */
export function codeSyntax(lang: string): Extension {
  if (lang === "text") return [];
  const known = languages.get(lang);
  if (known) return known;
  const spec = langSpec(lang);
  const language = StreamLanguage.define<StreamState>({
    name: lang,
    startState: () => ({ block: null }),
    copyState: (state) => ({ block: state.block }),
    token: tokenFor(spec),
  });
  languages.set(lang, language);
  return language;
}

/** True for files the editor treats as prose (Markdown, plain text). */
export function isProseFile(ext: string): boolean {
  return isEditableTextExt(ext);
}

/** Language support for a file: Markdown for prose, token highlighting for code. */
export function languageFor(ext: string): Extension {
  if (isProseFile(ext)) return markdown();
  return codeSyntax(langForExt(ext));
}
