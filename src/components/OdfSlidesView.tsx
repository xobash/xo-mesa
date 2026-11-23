import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { OdfPackage } from "../lib/odf/odfPackage";
import { editContainerText, moveOdpSlide, odpNotes, openOdpDeck, readOdpDeck, renderOdpSlide, type OdpDeck } from "../lib/odf/odpDeck";
import type { RenderShape, RenderSlide, TextBodyRef } from "../lib/pptx/pptxRender";
import { parseXmlTree } from "../lib/pptx/xmlTree";
import type { VaultFile } from "../types";
import { OdfFailed, OdfToolbar, useOdfImageUrls } from "./OdfToolbar";
import { PresentationSlide, SLIDE_THUMB_WIDTH, useMainSlideWidth } from "./PresentationSlide";
import { useOdfEditor, type OdfDraftSpec } from "./useOdfEditor";

const UTF8 = new TextEncoder();

const SLIDES_SPEC: OdfDraftSpec<string> = {
  initial: (pkg) => pkg.content.text,
  content: (_pkg, draft) => draft,
  isClean: (pkg, draft) => draft === pkg.content.text,
  check: (saved) => { openOdpDeck(saved); },
};

function useDeck(pkg: OdfPackage | null, draft: string | null): OdpDeck | null {
  return useMemo(() => {
    if (!pkg || draft === null || pkg.kind !== "presentation") return null;
    try {
      return readOdpDeck(draft === pkg.content.text ? pkg.content : parseXmlTree(UTF8.encode(draft)), pkg.styles);
    } catch {
      return null;
    }
  }, [pkg, draft]);
}

type TextShape = Extract<RenderShape, { kind: "shape" }>;

/** OpenDocument presentation: slides, text and notes edits, and slide order. */
export function OdfSlidesView({ file, editable, onDirtyChange }: { file: VaultFile; editable: boolean; onDirtyChange?: (dirty: boolean) => void }) {
  const editor = useOdfEditor(file, SLIDES_SPEC, onDirtyChange);
  const deck = useDeck(editor.pkg, editor.draft);
  const imageUrl = useOdfImageUrls(editor.pkg);
  const [mainRef, mainWidth] = useMainSlideWidth();
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<TextBodyRef | null>(null);
  const models = useMemo(() => (deck ? deck.slides.map((s) => renderOdpSlide(deck, s)) : []), [deck]);
  const count = deck?.slides.length ?? 0;
  const current = Math.min(index, Math.max(0, count - 1));
  useEffect(() => { setSelected(null); }, [current]);

  if (editor.load.state === "loading") return <div className="editor-empty">Opening presentation…</div>;
  if (editor.load.state === "failed") return <OdfFailed file={file} message={editor.load.message} />;
  if (!deck) return <OdfFailed file={file} message="This file is not an OpenDocument presentation." />;

  const editing = editable && editor.editing;
  const model: RenderSlide | null = models[current] ?? null;
  const notes = deck.slides[current] ? odpNotes(deck, deck.slides[current]) : null;
  const shape = model?.shapes.find((s): s is TextShape => s.kind === "shape" && !!s.body && !!selected && s.body.index === selected.index) ?? null;
  const go = (next: number) => { editor.endCoalesce(); setIndex(Math.max(0, Math.min(count - 1, next))); };
  const move = (to: number) => { editor.endCoalesce(); if (editor.apply(() => moveOdpSlide(deck, current, to))) setIndex(to); };
  const setText = (body: TextBodyRef, text: string) => editor.apply(() => editContainerText(deck, body.index, text), `box${body.index}`);
  const onThumbKey = (event: KeyboardEvent<HTMLOListElement>) => {
    const moves: Record<string, number> = { ArrowDown: current + 1, ArrowUp: current - 1, Home: 0, End: count - 1 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    go(moves[event.key]);
  };

  return (
    <div className="pptx-view" data-testid="odp-view">
      <OdfToolbar editor={editor} editable={editable} label="Presentation">
        <button className="btn ghost" disabled={current === 0} onClick={() => move(current - 1)}>Move up</button>
        <button className="btn ghost" disabled={current >= count - 1} onClick={() => move(current + 1)}>Move down</button>
      </OdfToolbar>
      <div className="pptx-body">
        <ol className="pptx-thumbs" role="listbox" aria-label="Slides" tabIndex={0} onKeyDown={onThumbKey} aria-activedescendant={count ? `odp-thumb-${current}` : undefined}>
          {deck.slides.map((s, i) => (
            <li key={`${i}-${s.el.start}`} id={`odp-thumb-${i}`} role="option" aria-selected={i === current}
              className={`pptx-thumb${i === current ? " is-active" : ""}${s.hidden ? " is-hidden" : ""}`} onClick={() => go(i)}>
              <span className="pptx-thumb-number">{i + 1}</span>
              <PresentationSlide slide={models[i]} width={SLIDE_THUMB_WIDTH} imageUrl={imageUrl} label={`Slide ${i + 1}${s.hidden ? " (hidden)" : ""}`} />
              {s.hidden && <span className="pptx-hidden-tag">Hidden</span>}
            </li>
          ))}
        </ol>
        <div className="pptx-main" ref={mainRef}>
          {model ? (
            <PresentationSlide slide={model} width={mainWidth} imageUrl={imageUrl} label={`Slide ${current + 1} of ${count}`}
              selected={editing ? selected : null}
              onSelect={editing ? (s) => { editor.endCoalesce(); setSelected(s.kind === "shape" ? s.body : null); } : undefined} />
          ) : <div className="editor-empty">This presentation has no slides.</div>}
          {editing && model && !shape && <p className="pptx-hint">Click a text box on the slide to edit its text.</p>}
          {editing && shape && (
            <label className="pptx-field">
              <span>Text box (one paragraph per line)</span>
              {shape.editRefusal ? <span className="pptx-refusal" role="note">{shape.editRefusal}</span> : (
                <textarea value={shape.plain} rows={Math.min(12, shape.plain.split("\n").length + 1)} onChange={(e) => setText(shape.body!, e.target.value)} />
              )}
            </label>
          )}
          {notes && (
            <section className="pptx-notes" aria-label="Speaker notes">
              <h3>Notes</h3>
              {editing && notes.body && !notes.editRefusal ? (
                <textarea aria-label="Speaker notes" value={notes.text} rows={4} onChange={(e) => setText(notes.body!, e.target.value)} />
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
