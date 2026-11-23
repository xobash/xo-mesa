import type { CellInput } from "./xlsxCells";
import { currentIndex, sheetEditRefusal, sheetNamed, viewOf, withSheetDraft, XlsxEditRefusal, type XlsxDraft, type XlsxSession } from "./xlsxDraft";
import { patchSheetCells, shiftSheetRows } from "./xlsxPatch";
import { rowShiftRefusal } from "./xlsxRefusals";
import { indexWorksheet, type SheetIndex } from "./xlsxSheet";

// Insert and delete row in two halves. The proof that nothing refers to the
// moved rows only reads and runs on the calling thread; the text rewrite
// (write pending cells, renumber every later row, re-index) is linear in the
// sheet and runs in the spreadsheet worker (`xlsxWorkerProtocol.ts`).

/** Text work for one row move; structured-cloneable. */
export interface RowShiftJob {
  readonly part: string;
  /** The sheet as the draft holds it, before pending cell edits are written. */
  readonly index: SheetIndex;
  readonly edits: ReadonlyArray<readonly [number, CellInput]>;
  readonly row: number;
  readonly delta: 1 | -1;
}

export interface RowShiftResult {
  readonly index: SheetIndex;
  /** The sheet had formulas before the move (its calculation chain is stale). */
  readonly hadFormulas: boolean;
}

/**
 * Checks a row insert (or delete) at 0-based `row` against the draft and
 * returns the text work. Throws `XlsxEditRefusal` with the reason.
 */
export function prepareRowShift(session: XlsxSession, draft: XlsxDraft, part: string, row: number, insert: boolean): RowShiftJob {
  const sheetRefusal = sheetEditRefusal(session, draft, part);
  if (sheetRefusal) throw new XlsxEditRefusal(`This sheet is read-only: ${sheetRefusal}.`);
  const refusal = rowShiftRefusal(viewOf(session, draft), part, sheetNamed(draft, part).name, row, insert);
  if (refusal) throw new XlsxEditRefusal(`Mesa cannot ${insert ? "insert" : "delete"} this row because ${refusal}.`);
  const edits = [...(draft.sheetDrafts.get(part)?.edits ?? [])];
  return { part, index: currentIndex(session, draft, part), edits, row, delta: insert ? 1 : -1 };
}

/** Writes pending cells, moves the rows and re-indexes. Pure; runs in the worker. */
export function runRowShift(job: Pick<RowShiftJob, "index" | "edits" | "row" | "delta">): RowShiftResult {
  const materialized = job.edits.length ? indexWorksheet(patchSheetCells(job.index, new Map(job.edits))) : job.index;
  return { index: indexWorksheet(shiftSheetRows(materialized, job.row, job.delta)), hadFormulas: materialized.hasFormulas };
}

/** The draft after a finished row move; `draft` must be the one the job was prepared from. */
export function applyRowShift(draft: XlsxDraft, job: RowShiftJob, result: RowShiftResult): XlsxDraft {
  const movedFormulas = (draft.sheetDrafts.get(job.part)?.movedFormulas ?? false) || result.hadFormulas;
  return withSheetDraft(draft, job.part, { index: result.index, edits: new Map(), movedFormulas });
}

/** Draft with a row inserted before (or deleted at) 0-based `row`, all on this thread. Throws `XlsxEditRefusal`. */
export function shiftRows(session: XlsxSession, draft: XlsxDraft, part: string, row: number, insert: boolean): XlsxDraft {
  const job = prepareRowShift(session, draft, part, row, insert);
  return applyRowShift(draft, job, runRowShift(job));
}
