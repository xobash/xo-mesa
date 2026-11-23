import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { confirmAction } from "../lib/confirmAction";
import { xmlOf, type Deck, type DeckSlide, type PartView } from "../lib/pptx/pptxDeck";
import { imageMime, renderNotes, renderSlide, type RenderShape, type RenderSlide, type TextBodyRef } from "../lib/pptx/pptxRender";
import { deleteSlide, duplicateSlide, moveSlide } from "../lib/pptx/pptxStructure";
import { editTextBody } from "../lib/pptx/pptxTextEdit";
import { encodeXmlPart } from "../lib/pptx/xmlTree";
import type { VaultFile } from "../types";
import { EncryptedOfficeGate } from "./EncryptedOfficeGate";
import { PresentationSlide, SLIDE_THUMB_WIDTH, useMainSlideWidth, type ImageUrl } from "./PresentationSlide";
import { usePresentationEditor } from "./usePresentationEditor";
import { usePartBlobUrls } from "./usePartBlobUrls";


/** Thumbnails beyond this distance from the visible list draw without pictures. */
const THUMB_PICTURE_MARGIN = "600px 0px";
const NO_PICTURES: ImageUrl = () => null;

/** Picture part bytes, or `null` when the part is missing or fails its checks (decoded on first read). */
function pictureBytes(view: PartView | null, part: string): Uint8Array | null {
  try {
    return view?.parts.get(part) ?? null;
  } catch {
    return null;
  }
}

/** Blob URLs for picture parts (`usePartBlobUrls`). */
function useImageUrls(view: PartView | null): ImageUrl {
  return usePartBlobUrls(useCallback((part: string) => {
    const bytes = pictureBytes(view, part);
    const mime = view && bytes ? imageMime(view, part) : null;
    return bytes && mime ? { bytes, mime } : null;
  }, [view]));
}

/**
 * Slide parts whose thumbnails have come near the visible list. Pictures are
 * decoded on first read, so off-screen thumbnails never decode theirs.
 * `null` (every thumbnail) where IntersectionObserver is unavailable.
 */
function useNearThumbs(listRef: React.RefObject<HTMLOListElement>, count: number): ReadonlySet<string> | null {
  const [near, setNear] = useState<ReadonlySet<string> | null>(() => (typeof IntersectionObserver === "undefined" ? null : new Set()));
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((records) => {
      const parts = records.filter((r) => r.isIntersecting).map((r) => (r.target as HTMLElement).dataset.part ?? "");
      setNear((previous) => {
        if (!previous || parts.every((part) => previous.has(part))) return previous;
        return new Set([...previous, ...parts]);
      });
    }, { root: list, rootMargin: THUMB_PICTURE_MARGIN });
    for (const item of Array.from(list.children)) observer.observe(item);
    return () => observer.disconnect();
  }, [listRef, count]);
  return near;
}

/** Render models keyed by slide part and its current bytes. */
function useSlideModels(view: PartView | null, deck: Deck | null): (slide: DeckSlide) => RenderSlide {
  const cache = useRef(new Map<string, { bytes: Uint8Array; model: RenderSlide }>());
  return useCallback((slide: DeckSlide) => {
    const bytes = view?.parts.get(slide.part);
    const hit = cache.current.get(slide.part);
    if (hit && hit.bytes === bytes) return hit.model;
    const model = view && deck ? renderSlide(view, deck, slide) : { width: 1, height: 1, background: null, shapes: [], omitted: 0 };
    if (bytes) cache.current.set(slide.part, { bytes, model });
    return model;
  }, [view, deck]);
}

function textEdit(ref: TextBodyRef, text: string) {
  return (view: PartView) => {
    const doc = xmlOf(view, ref.part);
    if (!doc) throw new Error("That slide is no longer in the presentation.");
    return new Map([[ref.part, encodeXmlPart(doc, editTextBody(doc, ref.index, text))]]);
  };
}

/**
 * PowerPoint viewer with explicit, limited editing: text of existing boxes,
 * speaker notes, slide order, delete and duplicate. Everything else in the
 * file is kept byte-for-byte. Opens read-only; Edit is a deliberate step.
 */
export function PresentationView(props: PresentationViewProps) {
  return (
    <EncryptedOfficeGate file={props.file}>
      <PresentationViewBody {...props} />
    </EncryptedOfficeGate>
  );
}

interface PresentationViewProps { file: VaultFile; editable?: boolean; onDirtyChange?: (dirty: boolean) => void }

function PresentationViewBody({ file, editable: editableProp = false, onDirtyChange }: PresentationViewProps) {
  const editor = usePresentationEditor(file, onDirtyChange);
  const editable = editableProp && !editor.readOnlyReason;
  const { view, deck, load } = editor;
  const [index, setIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<TextBodyRef | null>(null);
  const imageUrl = useImageUrls(view);
  const thumbsRef = useRef<HTMLOListElement>(null);
  const modelFor = useSlideModels(view, deck);
  const [mainRef, mainWidth] = useMainSlideWidth();
  const slides = useMemo(() => deck?.slides ?? [], [deck]);
  const nearThumbs = useNearThumbs(thumbsRef, slides.length);
  const current = slides[Math.min(index, slides.length - 1)] ?? null;
  const model = current ? modelFor(current) : null;
  const notes = useMemo(() => (view && current ? renderNotes(view, current) : null), [view, current]);
  const selectedShape = model?.shapes.find((s): s is Extract<RenderShape, { kind: "shape" }> => s.kind === "shape" && !!s.body && !!selected && s.body.part === selected.part && s.body.index === selected.index) ?? null;

  useEffect(() => { if (index >= slides.length && slides.length) setIndex(slides.length - 1); }, [index, slides.length]);
  useEffect(() => { setSelected(null); }, [current?.part]);

  if (load.state === "loading") return <div className="editor-empty">Loading presentation…</div>;
  if (load.state === "failed") return <div className="editor-empty" role="alert">{load.message}</div>;
  const policy = load.opened.policy;

  const go = (next: number) => { editor.endCoalesce(); setIndex(Math.max(0, Math.min(slides.length - 1, next))); };
  const onThumbKey = (event: KeyboardEvent<HTMLOListElement>) => {
    const moves: Record<string, number> = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: slides.length - 1 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    go(moves[event.key]);
  };
  const structural = (edit: Parameters<typeof editor.apply>[0], nextIndex: number) => {
    editor.endCoalesce();
    if (editor.apply(edit)) setIndex(nextIndex);
  };
  const remove = async () => {
    if (!current) return;
    const ok = await confirmAction(`Delete slide ${index + 1}? Its notes and any parts only it uses are removed when you save. Undo works until then.`, {
      title: "Delete slide?", okLabel: "Delete slide", cancelLabel: "Cancel", kind: "warning",
    });
    if (ok) structural((v, d) => deleteSlide(v, d, index), Math.max(0, index - 1));
  };
  const finish = async () => {
    if (editor.dirty && !(await editor.discard())) return;
    setEditing(false);
    setSelected(null);
  };
  const confirmSave = async () => {
    if (policy.warnings.length && !(await confirmAction(`Mesa will save only your edits and copy everything else unchanged.\n\n${policy.warnings.join("\n")}`, {
      title: "Save presentation?", okLabel: "Save", cancelLabel: "Cancel",
    }))) return;
    await editor.save();
  };

  return (
    <div className="pptx-view" data-testid="pptx-view">
      {editable && (
        <div className="pdf-toolbar pptx-toolbar" role="toolbar" aria-label="Presentation">
          {!editing ? (
            <button className="btn" disabled={!policy.canEdit} onClick={() => setEditing(true)}>Edit</button>
          ) : (
            <>
              <button className="btn ghost" onClick={editor.undo} disabled={!editor.canUndo}>Undo</button>
              <button className="btn ghost" onClick={editor.redo} disabled={!editor.canRedo}>Redo</button>
              <span className="pptx-sep" aria-hidden="true" />
              <button className="btn ghost" disabled={!current || index === 0} onClick={() => structural((v, d) => moveSlide(v, d, index, index - 1), index - 1)}>Move up</button>
              <button className="btn ghost" disabled={!current || index >= slides.length - 1} onClick={() => structural((v, d) => moveSlide(v, d, index, index + 1), index + 1)}>Move down</button>
              <button className="btn ghost" disabled={!current} onClick={() => structural((v, d) => duplicateSlide(v, d, index), index + 1)}>Duplicate</button>
              <button className="btn ghost" disabled={!current || slides.length <= 1} onClick={() => void remove()}>Delete</button>
              <span className="spacer" />
              {editor.dirty && <span className="pptx-dirty" role="status">Unsaved changes</span>}
              {editor.dirty && <button className="btn ghost" onClick={() => void editor.discard()}>Discard</button>}
              <button className="btn" disabled={!editor.dirty || editor.saving} onClick={() => void editor.saveCopy()}>Save as copy</button>
              <button className="btn primary" disabled={!editor.dirty || editor.saving || editor.diskChanged} onClick={() => void confirmSave()}>
                {editor.saving ? "Saving…" : "Save"}
              </button>
              <button className="btn ghost" onClick={() => void finish()}>Done</button>
            </>
          )}
        </div>
      )}
      {editable && !policy.canEdit && (
        <div className="rtf-notice" role="status">Read-only: {policy.refusals.join(" ")}</div>
      )}
      {editing && policy.warnings.length > 0 && (
        <div className="rtf-notice" role="note">Mesa edits text, notes and slide order only, and copies everything else unchanged. {policy.warnings.join(" ")}</div>
      )}
      {editor.status && <div className="pdf-status" role="status">{editor.status}</div>}
      <div className="pptx-body">
        <ol ref={thumbsRef} className="pptx-thumbs" role="listbox" aria-label="Slides" tabIndex={0} onKeyDown={onThumbKey}
          aria-activedescendant={current ? `pptx-thumb-${index}` : undefined}>
          {slides.map((s, i) => (
            <li key={`${s.sldId}-${s.part}`} id={`pptx-thumb-${i}`} data-part={s.part} role="option" aria-selected={i === index}
              className={`pptx-thumb${i === index ? " is-active" : ""}${s.hidden ? " is-hidden" : ""}`} onClick={() => go(i)}>
              <span className="pptx-thumb-number">{i + 1}</span>
              <PresentationSlide slide={modelFor(s)} width={SLIDE_THUMB_WIDTH} imageUrl={!nearThumbs || nearThumbs.has(s.part) ? imageUrl : NO_PICTURES} label={`Slide ${i + 1}${s.hidden ? " (hidden)" : ""}`} />
              {s.hidden && <span className="pptx-hidden-tag">Hidden</span>}
            </li>
          ))}
        </ol>
        <div className="pptx-main" ref={mainRef}>
          {model && current ? (
            <PresentationSlide slide={model} width={mainWidth} imageUrl={imageUrl} label={`Slide ${index + 1} of ${slides.length}`}
              selected={editing ? selected : null}
              onSelect={editing ? (shape) => { editor.endCoalesce(); setSelected(shape.kind === "shape" ? shape.body : null); } : undefined} />
          ) : <div className="editor-empty">This presentation has no slides.</div>}
          {deck && deck.missingSlides > 0 && <p className="pptx-hint" role="note">{deck.missingSlides} listed slide(s) are missing from the file and are not shown.</p>}
          {editing && model && !selectedShape && <p className="pptx-hint">Click a text box on the slide to edit its text.</p>}
          {editing && selectedShape && (
            <label className="pptx-field">
              <span>Text box (one paragraph per line)</span>
              {selectedShape.editRefusal ? <span className="pptx-refusal" role="note">{selectedShape.editRefusal}</span> : (
                <textarea value={selectedShape.plain} rows={Math.min(12, selectedShape.plain.split("\n").length + 1)}
                  onChange={(e) => editor.apply(textEdit(selectedShape.body!, e.target.value), `${selectedShape.body!.part}#${selectedShape.body!.index}`)} />
              )}
            </label>
          )}
          {notes && (
            <section className="pptx-notes" aria-label="Speaker notes">
              <h3>Notes</h3>
              {editing && notes.body && !notes.editRefusal ? (
                <textarea aria-label="Speaker notes" value={notes.text} rows={4}
                  onChange={(e) => editor.apply(textEdit(notes.body!, e.target.value), `${notes.body!.part}#${notes.body!.index}`)} />
              ) : (
                <>
                  <p className={notes.text ? "pptx-notes-text" : "pptx-hint"}>{notes.text || "No speaker notes."}</p>
                  {editing && notes.editRefusal && <p className="pptx-refusal" role="note">{notes.editRefusal}</p>}
                </>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
