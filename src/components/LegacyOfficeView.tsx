import { useCallback, useEffect, useMemo, useState } from "react";
import type { VaultFile } from "../types";
import { ByteSource } from "../lib/byteSource";
import { readVaultRange } from "../lib/vaultByteRead";
import { LEGACY_OFFICE_MAX_BYTES } from "../lib/legacyOffice/cfb";
import { LegacyOfficeError, openLegacyOffice, type LegacyOfficeContent } from "../lib/legacyOffice/legacyOffice";
import { legacyCellText, type LegacyCell, type LegacyWorkbook } from "../lib/legacyOffice/excelBinary";
import type { LegacyWordDocument } from "../lib/legacyOffice/wordBinary";
import type { LegacyPresentation } from "../lib/legacyOffice/pptBinary";
import { LEGACY_COPY_EXT } from "../lib/officeFallbackReason";
import { DataGrid, type GridCell } from "./DataGrid";

// Read-only content of a legacy .doc, .xls or .ppt file, read through the
// bounded range reader (one file version), plus "Make editable copy". The
// original file is never written from here.

type Load =
  | { state: "loading" }
  | { state: "failed"; message: string; encrypted: boolean }
  | { state: "ready"; content: LegacyOfficeContent };

const BLOCK_STEP = 2000;

async function readLegacy(file: VaultFile): Promise<LegacyOfficeContent> {
  const source = await ByteSource.open((offset, len) => readVaultRange(file, offset, len));
  if (source.size > LEGACY_OFFICE_MAX_BYTES) {
    throw new LegacyOfficeError("tooLarge", `This file is larger than ${LEGACY_OFFICE_MAX_BYTES / 1024 / 1024} MiB, the most Mesa reads from an older Office file.`);
  }
  return openLegacyOffice(await source.read(0, source.size), file.ext);
}

function summary(content: LegacyOfficeContent): string {
  if (content.kind === "word") return `${content.document.blocks.length.toLocaleString("en-US")} paragraphs and tables, read-only.`;
  if (content.kind === "excel") {
    const wb = content.workbook;
    const formulas = wb.formulaCells ? ` Formula cells show their last calculated value.` : "";
    const skipped = wb.skippedSheets.length ? ` Chart and macro sheets (${wb.skippedSheets.length}) are not shown.` : "";
    return `${wb.sheets.length} worksheet${wb.sheets.length === 1 ? "" : "s"}, read-only.${formulas}${skipped}`;
  }
  return `${content.presentation.slides.length} slide${content.presentation.slides.length === 1 ? "" : "s"}, text only, read-only.`;
}

function WordContent({ document }: { document: LegacyWordDocument }) {
  const [shown, setShown] = useState(BLOCK_STEP);
  const blocks = document.blocks;
  return (
    <div className="legacy-doc">
      {blocks.slice(0, shown).map((block, i) => block.kind === "table" ? (
        <div key={i} className="legacy-doc-table" role="table" aria-label="Table">
          {block.rows.map((row, r) => <p key={r} role="row">{row.join("\t")}</p>)}
        </div>
      ) : (
        <p key={i} className={block.pageBreakBefore ? "legacy-doc-page-break" : undefined}>{block.text || " "}</p>
      ))}
      {shown < blocks.length && (
        <button type="button" className="btn" onClick={() => setShown((n) => n + BLOCK_STEP)}>
          Show more ({(blocks.length - shown).toLocaleString("en-US")} left)
        </button>
      )}
    </div>
  );
}

function SheetGrid({ workbook }: { workbook: LegacyWorkbook }) {
  const [index, setIndex] = useState(0);
  const sheet = workbook.sheets[Math.min(index, workbook.sheets.length - 1)];
  const lookup = useMemo(() => {
    const map = new Map<number, LegacyCell>();
    for (const cell of sheet?.cells ?? []) map.set(cell.row * 256 + cell.col, cell);
    return map;
  }, [sheet]);
  const cell = useCallback((row: number, col: number): GridCell => {
    const found = lookup.get(row * 256 + col);
    if (!found) return { text: "" };
    const text = legacyCellText(found, workbook.date1904);
    return found.formula ? { text, title: "Last calculated value of a formula" } : { text, className: found.value.kind === "number" ? "is-number" : undefined };
  }, [lookup, workbook.date1904]);
  if (!sheet) return <div className="editor-empty">This workbook has no worksheets with cells.</div>;
  return (
    <div className="legacy-sheet">
      {workbook.sheets.length > 1 && (
        <div className="file-mode-switch legacy-sheet-tabs" role="tablist" aria-label="Sheets">
          {workbook.sheets.map((s, i) => (
            <button key={i} type="button" role="tab" aria-selected={s === sheet} className={"btn" + (s === sheet ? " is-active" : "")} onClick={() => setIndex(i)}>
              {s.name}{s.hidden ? " (hidden)" : ""}
            </button>
          ))}
        </div>
      )}
      <DataGrid
        key={index}
        rowCount={Math.max(1, sheet.rowCount)}
        columnCount={Math.max(1, sheet.columnCount)}
        cell={cell}
        editText={() => ""}
        editable={false}
        onCommit={() => undefined}
        ariaLabel={`Sheet ${sheet.name}, read-only`}
      />
    </div>
  );
}

function Slides({ presentation }: { presentation: LegacyPresentation }) {
  if (presentation.slides.length === 0) return <div className="editor-empty">This presentation has no slides.</div>;
  return (
    <ol className="legacy-slides">
      {presentation.slides.map((slide, i) => (
        <li key={i} className="legacy-slide">
          <div className="legacy-slide-title">{slide.title || `Slide ${i + 1}`}</div>
          {slide.body.map((p, j) => <p key={j}>{p || " "}</p>)}
          {slide.notes.length > 0 && (
            <div className="legacy-slide-notes" aria-label="Speaker notes">
              {slide.notes.map((p, j) => <p key={j}>{p || " "}</p>)}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

export function LegacyOfficeView({ file }: { file: VaultFile }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoad({ state: "loading" });
    setStatus("");
    readLegacy(file).then(
      (content) => { if (alive) setLoad({ state: "ready", content }); },
      (error: unknown) => {
        if (!alive) return;
        setLoad({ state: "failed", message: error instanceof Error ? error.message : String(error), encrypted: error instanceof LegacyOfficeError && error.reason === "encrypted" });
      },
    );
    return () => { alive = false; };
  }, [file]);

  const convert = useCallback(async () => {
    if (load.state !== "ready" || busy) return;
    setBusy(true);
    try {
      const { makeEditableCopy } = await import("./legacyOfficeCopy");
      const result = await makeEditableCopy(file, load.content);
      if (result) setStatus(result);
    } catch (error) {
      setStatus(`Could not make the editable copy: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [load, busy, file]);

  if (load.state === "loading") return <div className="editor-empty">Reading this older Office file…</div>;
  if (load.state === "failed") {
    return (
      <div className="legacy-office-view">
        <p className="file-details-warning" role="alert">
          {load.encrypted ? "Mesa cannot show this file: " : "Mesa cannot show this file's content: "}{load.message}
        </p>
      </div>
    );
  }
  const content = load.content;
  return (
    <div className="legacy-office-view">
      <div className="legacy-office-bar">
        <span className="legacy-office-summary">{summary(content)}</span>
        <button type="button" className="btn" disabled={busy} onClick={() => void convert()}>
          {busy ? "Creating copy…" : `Make editable .${LEGACY_COPY_EXT[content.kind]} copy…`}
        </button>
      </div>
      {status && <p className={status.startsWith("Could not") ? "file-details-warning legacy-office-status" : "legacy-office-status"} role={status.startsWith("Could not") ? "alert" : "status"}>{status}</p>}
      <div className="legacy-office-body">
        {content.kind === "word" && <WordContent document={content.document} />}
        {content.kind === "excel" && <SheetGrid workbook={content.workbook} />}
        {content.kind === "powerpoint" && <Slides presentation={content.presentation} />}
      </div>
    </div>
  );
}
