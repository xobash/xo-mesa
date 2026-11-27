import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { placeCaretAtEnd } from "../lib/caretAtEnd";
import type { OdfPackage } from "../lib/odf/odfPackage";
import { applyOdtEdit, openOdtDocument, readOdtDocument, type OdtDocument, type OdtRun } from "../lib/odf/odtDocument";
import { parseXmlTree } from "../lib/pptx/xmlTree";
import type { FormatProp } from "../lib/odf/odfText";
import type { VaultFile } from "../types";
import { OdfSheetView } from "./OdfSheetView";
import { OdfSlidesView } from "./OdfSlidesView";
import { OdfFailed as Failed, OdfToolbar, useOdfImageUrls } from "./OdfToolbar";
import { useOdfEditor, type OdfDraftSpec } from "./useOdfEditor";

// OpenDocument text, spreadsheets and presentations. One lazy chunk; the
// extension picks the view and the package's mimetype must agree.

const MAX_BLOCKS_STEP = 2000;
const UTF8 = new TextEncoder();

const TEXT_SPEC: OdfDraftSpec<string> = {
  initial: (pkg) => pkg.content.text,
  content: (_pkg, draft) => draft,
  isClean: (pkg, draft) => draft === pkg.content.text,
  check: (saved) => { openOdtDocument(saved); },
};

/** The document model for a draft; the opened model when nothing changed. */
function useDraftOdt(pkg: OdfPackage | null, draft: string | null): OdtDocument | null {
  return useMemo(() => {
    if (!pkg || draft === null) return null;
    try {
      const doc = draft === pkg.content.text ? pkg.content : parseXmlTree(UTF8.encode(draft));
      return readOdtDocument(doc, pkg.styles, pkg.policy.trackedChanges);
    } catch {
      return null;
    }
  }, [pkg, draft]);
}

function runStyle(run: OdtRun): CSSProperties | undefined {
  const decoration = [run.underline ? "underline" : "", run.strike ? "line-through" : ""].filter(Boolean).join(" ");
  if (!run.bold && !run.italic && !decoration && !run.color) return undefined;
  return { fontWeight: run.bold ? 700 : undefined, fontStyle: run.italic ? "italic" : undefined, textDecoration: decoration || undefined, color: run.color };
}

function Runs({ runs }: { runs: readonly OdtRun[] }) {
  if (!runs.length) return <br />;
  return <>{runs.map((r, i) => <span key={i} style={runStyle(r)}>{r.text}</span>)}</>;
}

function ParagraphEditor({ odt, index, onText, onFormat }: { odt: OdtDocument; index: number; onText: (text: string) => void; onFormat: (start: number, end: number, prop: FormatProp) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const p = odt.paragraphs[index];
  if (!p) return null;
  if (p.refusal) return <p className="pptx-refusal" role="note">{p.refusal}</p>;
  const format = (prop: FormatProp) => {
    const el = ref.current;
    if (el) onFormat(el.selectionStart, el.selectionEnd, prop);
  };
  return (
    <div className="odt-paragraph-editor">
      <div className="odt-format-bar" role="toolbar" aria-label="Paragraph formatting">
        <button className="btn ghost" type="button" title="Bold the selected text" onMouseDown={(e) => e.preventDefault()} onClick={() => format("bold")}><b>B</b></button>
        <button className="btn ghost" type="button" title="Italicize the selected text" onMouseDown={(e) => e.preventDefault()} onClick={() => format("italic")}><i>I</i></button>
      </div>
      <textarea ref={ref} aria-label="Paragraph text" autoFocus value={p.plain} rows={Math.min(12, p.plain.split("\n").length + 1)}
        onFocus={placeCaretAtEnd} onChange={(e) => onText(e.target.value)} />
    </div>
  );
}

function OdtTextView({ file, editable, onDirtyChange }: { file: VaultFile; editable: boolean; onDirtyChange?: (dirty: boolean) => void }) {
  const editor = useOdfEditor(file, TEXT_SPEC, onDirtyChange);
  const odt = useDraftOdt(editor.pkg, editor.draft);
  const imageUrl = useOdfImageUrls(editor.pkg);
  const [selected, setSelected] = useState<number | null>(null);
  const [limit, setLimit] = useState(MAX_BLOCKS_STEP);
  if (editor.load.state === "loading") return <div className="editor-empty">Opening document…</div>;
  if (editor.load.state === "failed") return <Failed file={file} message={editor.load.message} />;
  if (!odt) return <Failed file={file} message="This file is not an OpenDocument text document." />;
  const editing = editable && editor.editing;
  const paragraphNode = (index: number, heading: number, listLevel: number, runs: readonly OdtRun[], key: string | number): ReactNode => {
    const Tag = (heading ? `h${Math.min(6, heading)}` : "p") as "p";
    const pick = editing ? () => { editor.endCoalesce(); setSelected(index); } : undefined;
    return (
      <div key={key} className={`odt-block${editing ? " is-editable" : ""}${selected === index && editing ? " is-selected" : ""}`} style={listLevel ? { marginLeft: `${listLevel * 1.5}em` } : undefined}>
        <Tag className="odt-para" onClick={pick}>{listLevel > 0 && <span className="odt-bullet" aria-hidden="true">• </span>}<Runs runs={runs} /></Tag>
        {editing && selected === index && (
          <ParagraphEditor odt={odt} index={index}
            onText={(text) => editor.apply(() => applyOdtEdit(odt, { kind: "text", paragraph: index, text }), `p${index}`)}
            onFormat={(start, end, prop) => { editor.endCoalesce(); editor.apply(() => applyOdtEdit(odt, { kind: "format", paragraph: index, start, end, prop })); }} />
        )}
      </div>
    );
  };
  const runsAt = (index: number) => {
    const block = odt.blocks.find((b) => b.kind === "paragraph" && b.index === index);
    return block?.kind === "paragraph" ? block.runs : [];
  };
  return (
    <div className="odt-view" data-testid="odt-view">
      <OdfToolbar editor={editor} editable={editable} label="Document" />
      {editing && selected === null && <p className="pptx-hint">Click a paragraph to edit its text. Select words, then B or I, to change their formatting.</p>}
      <article className="odt-page">
        {odt.blocks.slice(0, limit).map((block) => {
          if (block.kind === "paragraph") return paragraphNode(block.index, block.heading, block.listLevel, block.runs, `p${block.index}`);
          if (block.kind === "image") {
            const url = block.part ? imageUrl(block.part) : null;
            const width = block.width ? Math.round(block.width / 9525) : undefined;
            return url ? <img key={`i${block.key}`} className="odt-image" src={url} alt="" loading="lazy" decoding="async" style={{ width, maxWidth: "100%" }} /> : <div key={`i${block.key}`} className="pptx-placeholder odt-object"><span className="pptx-label">{block.label}</span></div>;
          }
          return (
            <table key={`t${block.key}`} className="odt-table"><tbody>
              {block.rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c}>{cell.map((index) => paragraphNode(index, 0, 0, runsAt(index), index))}</td>)}</tr>)}
            </tbody></table>
          );
        })}
        {odt.blocks.length > limit && <button className="btn ghost" onClick={() => setLimit((n) => n + MAX_BLOCKS_STEP)}>Show more ({odt.blocks.length - limit} blocks left)</button>}
      </article>
    </div>
  );
}

/** The view an extension routes to. */
function odfViewKind(ext: string): "text" | "spreadsheet" | "presentation" | null {
  const lower = ext.toLowerCase();
  if (lower === "odt" || lower === "ott") return "text";
  if (lower === "ods" || lower === "ots") return "spreadsheet";
  if (lower === "odp" || lower === "otp") return "presentation";
  return null;
}

/**
 * OpenDocument viewer and, in the main pane, editor. Opens read-only; Edit is
 * a deliberate step; only content.xml changes, through the verified byte save.
 */
export function OpenDocumentView({ file, editable = false, onDirtyChange }: { file: VaultFile; editable?: boolean; onDirtyChange?: (dirty: boolean) => void }) {
  const kind = odfViewKind(file.ext);
  if (kind === "spreadsheet") return <OdfSheetView file={file} editable={editable} onDirtyChange={onDirtyChange} />;
  if (kind === "presentation") return <OdfSlidesView file={file} editable={editable} onDirtyChange={onDirtyChange} />;
  return <OdtTextView file={file} editable={editable} onDirtyChange={onDirtyChange} />;
}
