import { scanOoxmlCapabilities, type OoxmlCapabilityReport } from "./capabilityGate";
import { openOoxmlPackage } from "./ooxmlPackage";
import { runRowShift, type RowShiftJob } from "./xlsxRowShift";
import { verifyXlsxBytes, writeXlsx, type XlsxSavePlan } from "./xlsxSave";
import { indexWorksheet, type SheetIndex } from "./xlsxSheet";
import { openXlsxWorkbook } from "./xlsxWorkbook";
import { OoxmlPackageError, type OoxmlRefusal, type ZipContainer } from "./zipContainer";

// Work that can take hundreds of milliseconds on a large workbook: opening
// (inflate, CRC, capability scan), indexing a sheet, moving rows, and
// writing plus verifying a save. The same handler runs in the spreadsheet worker and, where
// workers are unavailable, in the calling thread.

export type XlsxWorkerRequest =
  | { readonly kind: "open"; readonly bytes: Uint8Array }
  | { readonly kind: "index"; readonly xml: string }
  | { readonly kind: "shiftRows"; readonly job: Pick<RowShiftJob, "index" | "edits" | "row" | "delta"> }
  | { readonly kind: "write"; readonly plan: XlsxSavePlan };

/** A sheet index without its XML text; the receiver re-attaches the text it already has. */
export type SheetIndexData = Omit<SheetIndex, "xml">;

export interface XlsxOpenData {
  readonly container: Omit<ZipContainer, "bytes">;
  readonly parts: ReadonlyArray<readonly [string, Uint8Array]>;
  readonly report: OoxmlCapabilityReport;
  /** Index of the first visible worksheet, built while the parts were at hand. */
  readonly firstIndex: { readonly part: string; readonly index: SheetIndexData } | null;
}

export interface XlsxWorkerState {
  /** Container of the bytes last opened; saves are written against it. */
  container: ZipContainer | null;
}

/** A moved sheet: its new XML travels once, beside the index arrays. */
export interface RowShiftData {
  readonly xml: string;
  readonly index: SheetIndexData;
  readonly hadFormulas: boolean;
}

export interface XlsxWorkerReply {
  readonly result: XlsxOpenData | SheetIndexData | RowShiftData | Uint8Array;
  readonly transfer: Transferable[];
}

export interface XlsxWorkerFailure {
  readonly code: OoxmlRefusal | null;
  readonly message: string;
}

function stripXml(index: SheetIndex): { data: SheetIndexData; transfer: Transferable[] } {
  const { xml: _xml, ...data } = index;
  void _xml;
  const arrays = [data.rowNumbers, data.rowStart, data.rowOpenEnd, data.rowCloseStart, data.rowEnd];
  return { data, transfer: arrays.map((a) => a.buffer) };
}

function openRequest(state: XlsxWorkerState, bytes: Uint8Array): XlsxWorkerReply {
  const pkg = openOoxmlPackage(bytes);
  const report = scanOoxmlCapabilities(pkg);
  state.container = pkg.container;
  const workbook = openXlsxWorkbook(pkg);
  const first = workbook.sheets.find((s) => s.kind === "worksheet" && s.part && s.state === "visible") ?? workbook.sheets.find((s) => s.kind === "worksheet" && s.part);
  let firstIndex: XlsxOpenData["firstIndex"] = null;
  const transfer: Transferable[] = [];
  if (first?.part) {
    try {
      const stripped = stripXml(indexWorksheet(workbook.partText(first.part)));
      firstIndex = { part: first.part, index: stripped.data };
      transfer.push(...stripped.transfer);
    } catch {
      firstIndex = null; // the receiver indexes it again and reports the problem
    }
  }
  const { bytes: _bytes, ...container } = pkg.container;
  void _bytes;
  const parts = [...pkg.parts];
  for (const [, part] of parts) transfer.push(part.buffer);
  return { result: { container, parts, report, firstIndex }, transfer };
}

/** Runs one request. Throws on failure; `describeFailure` turns the error into a message. */
export function handleXlsxRequest(state: XlsxWorkerState, request: XlsxWorkerRequest): XlsxWorkerReply {
  if (request.kind === "open") return openRequest(state, request.bytes);
  if (request.kind === "index") {
    const stripped = stripXml(indexWorksheet(request.xml));
    return { result: stripped.data, transfer: stripped.transfer };
  }
  if (request.kind === "shiftRows") {
    const moved = runRowShift(request.job);
    const stripped = stripXml(moved.index);
    return { result: { xml: moved.index.xml, index: stripped.data, hadFormulas: moved.hadFormulas }, transfer: stripped.transfer };
  }
  if (!state.container) throw new Error("The workbook is not open.");
  const bytes = writeXlsx(state.container, request.plan);
  verifyXlsxBytes(state.container, request.plan, bytes);
  return { result: bytes, transfer: bytes === state.container.bytes ? [] : [bytes.buffer] };
}

export function describeFailure(error: unknown): XlsxWorkerFailure {
  return {
    code: error instanceof OoxmlPackageError ? error.code : null,
    message: error instanceof Error ? error.message : String(error),
  };
}

export function failureError(failure: XlsxWorkerFailure): Error {
  return failure.code ? new OoxmlPackageError(failure.code, failure.message) : new Error(failure.message);
}
