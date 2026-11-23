import { defaultFormat, parseRtfDocument, sameFormat, type RtfDocument, type RtfFormat, type RtfUnit } from "./rtfDocument";

/**
 * Write-back for the RTF editor. An edit is one contiguous changed region
 * (common prefix and suffix kept). Inside that region only the source spans
 * of removed characters, paragraph breaks and objects are dropped; every
 * other token — control words, braces, destinations — stays in place, so
 * header tables and unmodelled formatting survive byte for byte. New text is
 * inserted as one braced group per format run, with explicit formatting
 * relative to the state at the insertion point. The result is parsed again
 * and must reproduce the edited content exactly before it can be saved.
 */

export type RtfEditUnit =
  | { kind: "char"; ch: string; fmt: RtfFormat }
  | { kind: "par" }
  | { kind: "atom"; id: number };

function unitEqual(a: RtfUnit, b: RtfEditUnit): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "char" && b.kind === "char") return a.ch === b.ch && sameFormat(a.fmt, b.fmt);
  if (a.kind === "atom" && b.kind === "atom") return a.id === b.id;
  return true;
}

/** Control words that set `to` from `from`; empty when nothing differs. */
export function formatDelta(from: RtfFormat, to: RtfFormat): string {
  let out = "";
  if (from.b !== to.b) out += to.b ? "\\b" : "\\b0";
  if (from.i !== to.i) out += to.i ? "\\i" : "\\i0";
  if (from.ul !== to.ul) out += to.ul ? "\\ul" : "\\ulnone";
  if (from.strike !== to.strike) out += to.strike ? "\\strike" : "\\strike0";
  if (from.fs !== to.fs) out += `\\fs${to.fs}`;
  if (from.f !== to.f) out += `\\f${to.f}`;
  if (from.cf !== to.cf) out += `\\cf${to.cf}`;
  if (from.cb !== to.cb) out += `\\cb${to.cb}`;
  if (from.hl !== to.hl) out += `\\highlight${to.hl}`;
  if (from.va !== to.va) out += to.va === "super" ? "\\super" : to.va === "sub" ? "\\sub" : "\\nosupersub";
  return out;
}

/** One character as RTF; non-ASCII uses `\uN?` (callers set `\uc1`). */
export function escapeRtfChar(ch: string): string {
  const code = ch.charCodeAt(0);
  if (ch === "\\" || ch === "{" || ch === "}") return `\\${ch}`;
  if (ch === "\t") return "\\tab ";
  if (ch === "\n") return "\\line ";
  if (ch === " ") return "\\~";
  if (ch === "‑") return "\\_";
  if (code >= 0x20 && code < 0x7f) return ch;
  if (code < 0x20) return "";
  return `\\u${code > 0x7fff ? code - 0x10000 : code}?`;
}

/** A control word without a delimiter must not run into following text. */
function joinSafely(out: string, next: string): string {
  if (!next) return out;
  if (endsWithOpenControlWord(out) && /^[A-Za-z0-9 -]/.test(next)) return `${out} ${next}`;
  return out + next;
}

/** True when `text` ends in a control word that has no delimiter yet. */
function endsWithOpenControlWord(text: string): boolean {
  const tail = text.slice(-48);
  const match = /\\[A-Za-z]{1,32}-?\d{0,10}$/.exec(tail);
  if (!match) return false;
  // An escaped backslash (`\\word`) is text, not a control word.
  let slashes = 0;
  for (let k = text.length - tail.length + match.index - 1; k >= 0 && text[k] === "\\"; k--) slashes++;
  return slashes % 2 === 0;
}

function groupFor(state: RtfFormat, fmt: RtfFormat, body: string): string {
  const delta = formatDelta(state, fmt) + (/\\u-?\d/.test(body) ? "\\uc1" : "");
  return `{${delta}${delta ? " " : ""}${body}}`;
}

/** RTF for inserted units: one group per format run, paragraph breaks outside groups. */
type Atom = Extract<RtfUnit, { kind: "atom" }>;
function atomsById(doc: RtfDocument): Map<number, Atom> {
  const out = new Map<number, Atom>();
  for (const unit of doc.units) if (unit.kind === "atom") out.set(unit.id, unit);
  return out;
}

function renderInsertion(doc: RtfDocument, atoms: ReadonlyMap<number, Atom>, units: readonly RtfEditUnit[], state: RtfFormat): string {
  let out = "";
  let run = "";
  let runFmt: RtfFormat | null = null;
  const flush = () => {
    if (runFmt && run) out = joinSafely(out, groupFor(state, runFmt, run));
    run = "";
    runFmt = null;
  };
  for (const unit of units) {
    if (unit.kind === "char") {
      if (runFmt && !sameFormat(runFmt, unit.fmt)) flush();
      runFmt = unit.fmt;
      run += escapeRtfChar(unit.ch);
      continue;
    }
    flush();
    if (unit.kind === "par") {
      out = joinSafely(out, "\\par ");
      continue;
    }
    const atom = atoms.get(unit.id);
    if (!atom) throw new Error("The edit refers to an embedded object that is no longer in the document.");
    out = joinSafely(out, groupFor(state, atom.fmt, doc.source.slice(atom.start, atom.end)));
  }
  flush();
  return out;
}

/** Bytes of [start, end) without the spans of the removed units. */
function skeleton(doc: RtfDocument, start: number, end: number, removed: readonly RtfUnit[]): string {
  let out = "";
  let at = start;
  for (const unit of removed) {
    out = joinSafely(out, doc.source.slice(at, unit.start));
    at = unit.end;
  }
  return joinSafely(out, doc.source.slice(at, end));
}

function sameContent(atoms: ReadonlyMap<number, Atom>, expected: readonly RtfEditUnit[], actual: readonly RtfUnit[]): boolean {
  if (expected.length !== actual.length) return false;
  for (let k = 0; k < expected.length; k++) {
    const want = expected[k];
    const got = actual[k];
    if (want.kind !== got.kind) return false;
    if (want.kind === "char" && got.kind === "char" && (want.ch !== got.ch || !sameFormat(want.fmt, got.fmt))) return false;
    if (want.kind === "atom" && got.kind === "atom") {
      const original = atoms.get(want.id);
      if (!original || original.text !== got.text || original.label !== got.label) return false;
    }
  }
  return true;
}

/** True when `next` differs from the document's content. */
export function rtfContentChanged(doc: RtfDocument, next: readonly RtfEditUnit[]): boolean {
  if (doc.units.length !== next.length) return true;
  for (let k = 0; k < next.length; k++) if (!unitEqual(doc.units[k], next[k])) return true;
  return false;
}

/** The edited source, or null when the content is unchanged (nothing to write). */
export function buildRtfEdit(doc: RtfDocument, next: readonly RtfEditUnit[]): string | null {
  if (doc.readOnlyReason) throw new Error(`This RTF file is read-only: ${doc.readOnlyReason}.`);
  const old = doc.units;
  let a = 0;
  while (a < old.length && a < next.length && unitEqual(old[a], next[a])) a++;
  if (a === old.length && a === next.length) return null;
  let tailOld = old.length;
  let tailNew = next.length;
  while (tailOld > a && tailNew > a && unitEqual(old[tailOld - 1], next[tailNew - 1])) {
    tailOld--;
    tailNew--;
  }
  const removed = old.slice(a, tailOld);
  const inserted = next.slice(a, tailNew);
  let start: number;
  let end: number;
  let state: RtfFormat;
  if (removed.length) {
    start = removed[0].start;
    end = removed[removed.length - 1].end;
    state = removed[0].fmt;
  } else if (a > 0) {
    start = end = old[a - 1].end;
    state = old[a - 1].fmt;
  } else if (old.length) {
    start = end = old[0].start;
    state = old[0].fmt;
  } else {
    start = end = doc.endInsert;
    state = doc.endFmt ?? defaultFormat();
  }
  const atoms = atomsById(doc);
  const middle = joinSafely(renderInsertion(doc, atoms, inserted, state), skeleton(doc, start, end, removed));
  const source = joinSafely(joinSafely(doc.source.slice(0, start), middle), doc.source.slice(end));
  const check = parseRtfDocument(source);
  if (check.readOnlyReason || !sameContent(atoms, next, check.units)) {
    throw new Error("Mesa could not encode this RTF edit exactly, so nothing was saved.");
  }
  return source;
}
