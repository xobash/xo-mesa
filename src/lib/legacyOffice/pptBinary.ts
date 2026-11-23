import { LegacyOfficeError, malformed, type CompoundFile } from "./cfb";

// Slide text of a PowerPoint 97-2003 file ([MS-PPT]). `Current User` points
// at the newest UserEditAtom; the chain of edits gives the persist directory
// (newest entry wins) and the DocumentContainer. Slide order and placeholder
// text come from the slide list (SlideListWithTextContainer); text boxes come
// from TextCharsAtom/TextBytesAtom records inside each slide's drawing.
// Notes come from the notes list and the notes slide. Records are walked
// with an explicit stack and depth, count and offset limits.

export interface LegacyTextBlock {
  /** TextHeaderAtom type: 0 title, 6 centre title, others body or notes. */
  readonly type: number;
  /** Paragraphs; `\n` is a manual line break. */
  readonly paragraphs: readonly string[];
}

export interface LegacySlideText {
  readonly title: string;
  readonly body: readonly string[];
  readonly notes: readonly string[];
}

export interface LegacyPresentation {
  readonly slides: readonly LegacySlideText[];
  /** Slide size in EMU, when the file states a usable one. */
  readonly width: number | null;
  readonly height: number | null;
}

const MAX_SLIDES = 10_000;
const MAX_EDITS = 4096;
const MAX_DEPTH = 32;
const MAX_WALK_RECORDS = 500_000;
const RT = {
  document: 0x03e8, documentAtom: 0x03e9, slide: 0x03ee, slideAtom: 0x03ef, notes: 0x03f0, slidePersist: 0x03f3,
  outlineTextRef: 0x0f9e, textHeader: 0x0f9f, textChars: 0x0fa0, textBytes: 0x0fa8, slideListWithText: 0x0ff0,
  userEdit: 0x0ff5, currentUser: 0x0ff6, persistDirectory: 0x1772,
} as const;
const HEADER_TOKEN_PLAIN = 0xe391c05f;
const HEADER_TOKEN_ENCRYPTED = 0xf3d1c4df;
const EMU_PER_MASTER_UNIT = 914_400 / 576;

interface Rec {
  readonly type: number;
  readonly instance: number;
  readonly container: boolean;
  readonly start: number;
  readonly body: number;
  readonly end: number;
}

function u16(b: Uint8Array, at: number): number {
  return b[at] | (b[at + 1] << 8);
}

function u32(b: Uint8Array, at: number): number {
  return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
}

function recordAt(b: Uint8Array, at: number, limit = b.length): Rec {
  if (at < 0 || at + 8 > limit) malformed("a presentation record lies outside its stream.");
  const verInstance = u16(b, at);
  const len = u32(b, at + 4);
  if (at + 8 + len > limit) malformed("a presentation record is longer than its container.");
  return { type: u16(b, at + 2), instance: verInstance >> 4, container: (verInstance & 0x0f) === 0x0f, start: at, body: at + 8, end: at + 8 + len };
}

/** Direct children of a container, in order. */
function childrenOf(b: Uint8Array, parent: Rec): Rec[] {
  const out: Rec[] = [];
  let at = parent.body;
  for (let guard = 0; at < parent.end && guard < MAX_WALK_RECORDS; guard++) {
    const rec = recordAt(b, at, parent.end);
    out.push(rec);
    at = rec.end;
  }
  return out;
}

function decodeText(b: Uint8Array, rec: Rec): string {
  const len = rec.end - rec.body;
  const chars: string[] = [];
  if (rec.type === RT.textChars) {
    for (let i = 0; i + 1 < len; i += 2) chars.push(String.fromCharCode(u16(b, rec.body + i)));
  } else {
    for (let i = 0; i < len; i++) chars.push(String.fromCharCode(b[rec.body + i]));
  }
  return chars.join("");
}

function paragraphsOf(text: string): string[] {
  // eslint-disable-next-line no-control-regex -- PowerPoint uses CR between paragraphs and VT for line breaks.
  return text.split("\r").map((p) => p.replace(/\x0b/g, "\n").replace(/[\u0000-\u0008\u000c-\u001f]/g, ""));
}

interface PersistState {
  readonly offsets: Map<number, number>;
  readonly docRef: number;
}

function readPersist(doc: Uint8Array, firstEdit: number): PersistState {
  const offsets = new Map<number, number>();
  const seen = new Set<number>();
  let edit = firstEdit;
  let docRef = -1;
  for (let n = 0; n < MAX_EDITS && edit !== 0; n++) {
    if (seen.has(edit)) malformed("its edit history loops back on itself.");
    seen.add(edit);
    const user = recordAt(doc, edit);
    if (user.type !== RT.userEdit || user.end - user.body < 28) malformed("its edit record is missing.");
    if (user.end - user.body >= 32 && u32(doc, user.body + 28) !== 0) {
      throw new LegacyOfficeError("encrypted", "This presentation is password-protected. Mesa cannot read encrypted presentations; remove the password in PowerPoint, then open it again.");
    }
    if (docRef < 0) docRef = u32(doc, user.body + 16);
    const dir = recordAt(doc, u32(doc, user.body + 12));
    if (dir.type !== RT.persistDirectory) malformed("its persist directory is missing.");
    let at = dir.body;
    for (let guard = 0; at + 4 <= dir.end && guard < dir.end - dir.body; guard++) {
      const head = u32(doc, at);
      const first = head & 0xfffff;
      const count = head >>> 20;
      at += 4;
      if (at + count * 4 > dir.end) malformed("its persist directory is cut off.");
      for (let k = 0; k < count; k++) if (!offsets.has(first + k)) offsets.set(first + k, u32(doc, at + k * 4));
      at += count * 4;
    }
    edit = u32(doc, user.body + 8);
  }
  if (edit !== 0) malformed("its edit history is too long.");
  return { offsets, docRef };
}

interface ListEntry { readonly persistRef: number; readonly slideId: number; readonly texts: LegacyTextBlock[] }

/** Slide or notes list: SlidePersistAtom followed by its text records. */
function readSlideList(b: Uint8Array, list: Rec): ListEntry[] {
  const out: ListEntry[] = [];
  let current: ListEntry | null = null;
  let type = 4;
  for (const rec of childrenOf(b, list)) {
    if (rec.type === RT.slidePersist && rec.end - rec.body >= 16) {
      if (out.length >= MAX_SLIDES) malformed("it lists too many slides.");
      current = { persistRef: u32(b, rec.body), slideId: u32(b, rec.body + 12), texts: [] };
      out.push(current);
      type = 4;
    } else if (rec.type === RT.textHeader && rec.end - rec.body >= 4) {
      type = u32(b, rec.body);
    } else if ((rec.type === RT.textChars || rec.type === RT.textBytes) && current) {
      current.texts.push({ type, paragraphs: paragraphsOf(decodeText(b, rec)) });
    }
  }
  return out;
}

/** Text blocks of a slide or notes container in drawing order; outline references pull from `listTexts`. */
function containerTexts(b: Uint8Array, root: Rec, listTexts: readonly LegacyTextBlock[]): { texts: LegacyTextBlock[]; notesId: number } {
  const texts: LegacyTextBlock[] = [];
  const used = new Set<number>();
  let notesId = 0;
  let type = 4;
  const stack: { recs: Rec[]; index: number }[] = [{ recs: childrenOf(b, root), index: 0 }];
  for (let steps = 0; stack.length > 0; steps++) {
    if (steps > MAX_WALK_RECORDS) malformed("a slide has too many records.");
    const top = stack[stack.length - 1];
    if (top.index >= top.recs.length) { stack.pop(); continue; }
    const rec = top.recs[top.index++];
    if (rec.container) {
      if (stack.length >= MAX_DEPTH) malformed("a slide's records are nested too deeply.");
      stack.push({ recs: childrenOf(b, rec), index: 0 });
    } else if (rec.type === RT.slideAtom && rec.end - rec.body >= 20) {
      notesId = u32(b, rec.body + 16);
    } else if (rec.type === RT.textHeader && rec.end - rec.body >= 4) {
      type = u32(b, rec.body);
    } else if (rec.type === RT.textChars || rec.type === RT.textBytes) {
      texts.push({ type, paragraphs: paragraphsOf(decodeText(b, rec)) });
    } else if (rec.type === RT.outlineTextRef && rec.end - rec.body >= 4) {
      const index = u32(b, rec.body);
      if (index < listTexts.length && !used.has(index)) { used.add(index); texts.push(listTexts[index]); }
    }
  }
  listTexts.forEach((t, i) => { if (!used.has(i)) texts.push(t); });
  return { texts, notesId };
}

function slideOf(texts: readonly LegacyTextBlock[], notes: readonly LegacyTextBlock[]): LegacySlideText {
  const titleBlock = texts.find((t) => t.type === 0 || t.type === 6);
  const body: string[] = [];
  for (const t of texts) if (t !== titleBlock) body.push(...t.paragraphs);
  const noteParagraphs: string[] = [];
  for (const t of notes) noteParagraphs.push(...t.paragraphs);
  const trimEnd = (list: string[]) => { while (list.length > 0 && list[list.length - 1].trim() === "") list.pop(); return list; };
  return { title: titleBlock ? titleBlock.paragraphs.join(" ").replace(/\n/g, " ").trim() : "", body: trimEnd(body), notes: trimEnd(noteParagraphs) };
}

function readCurrentEdit(cfb: CompoundFile): number {
  const cu = cfb.stream("Current User");
  if (!cu) malformed("it has no Current User stream.");
  const rec = recordAt(cu, 0);
  if (rec.type !== RT.currentUser || rec.end - rec.body < 12) malformed("its Current User record is missing.");
  const token = u32(cu, rec.body + 4);
  if (token === HEADER_TOKEN_ENCRYPTED) {
    throw new LegacyOfficeError("encrypted", "This presentation is password-protected. Mesa cannot read encrypted presentations; remove the password in PowerPoint, then open it again.");
  }
  if (token !== HEADER_TOKEN_PLAIN) malformed("its Current User record is not a PowerPoint 97-2003 one.");
  return u32(cu, rec.body + 8);
}

/** Reads slide titles, text and notes. Throws `LegacyOfficeError`. */
export function readPowerPointBinary(cfb: CompoundFile): LegacyPresentation {
  const doc = cfb.stream("PowerPoint Document");
  if (!doc) malformed("it has no PowerPoint Document stream.");
  const persist = readPersist(doc, readCurrentEdit(cfb));
  const docOffset = persist.offsets.get(persist.docRef);
  if (docOffset === undefined) malformed("its document record is missing.");
  const document = recordAt(doc, docOffset);
  if (document.type !== RT.document) malformed("its document record is missing.");
  let slideList: ListEntry[] = [];
  let notesList: ListEntry[] = [];
  let width: number | null = null;
  let height: number | null = null;
  for (const rec of childrenOf(doc, document)) {
    if (rec.type === RT.slideListWithText && rec.instance === 0) slideList = readSlideList(doc, rec);
    else if (rec.type === RT.slideListWithText && rec.instance === 2) notesList = readSlideList(doc, rec);
    else if (rec.type === RT.documentAtom && rec.end - rec.body >= 8) {
      const w = Math.round((u32(doc, rec.body) | 0) * EMU_PER_MASTER_UNIT);
      const h = Math.round((u32(doc, rec.body + 4) | 0) * EMU_PER_MASTER_UNIT);
      if (w >= 914_400 && h >= 914_400 && w <= 51_206_400 && h <= 51_206_400) { width = w; height = h; }
    }
  }
  const notesById = new Map(notesList.map((n) => [n.slideId, n]));
  const slides: LegacySlideText[] = [];
  for (const entry of slideList) {
    const offset = persist.offsets.get(entry.persistRef);
    const container = offset === undefined ? null : recordAt(doc, offset);
    const own = container && container.type === RT.slide ? containerTexts(doc, container, entry.texts) : { texts: entry.texts, notesId: 0 };
    const notesEntry = own.notesId ? notesById.get(own.notesId) : undefined;
    let notes: LegacyTextBlock[] = [];
    if (notesEntry) {
      const notesOffset = persist.offsets.get(notesEntry.persistRef);
      const notesRec = notesOffset === undefined ? null : recordAt(doc, notesOffset);
      notes = notesRec && notesRec.type === RT.notes ? containerTexts(doc, notesRec, notesEntry.texts).texts : notesEntry.texts;
    }
    slides.push(slideOf(own.texts, notes));
  }
  return { slides, width, height };
}
