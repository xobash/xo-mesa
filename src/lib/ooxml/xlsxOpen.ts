import { decideOoxmlEditPolicy, scanOoxmlCapabilities, type OoxmlCapabilityReport, type OoxmlEditPolicy, type OoxmlFeature } from "./capabilityGate";
import { openOoxmlPackage, type OoxmlPackage } from "./ooxmlPackage";
import { XlsxSession } from "./xlsxDraft";
import { openXlsxWorkbook } from "./xlsxWorkbook";

// Opening an Excel workbook for the viewer and editor: package checks, the
// capability gate and the workbook model, plus the user-facing reasons.

/**
 * Features the spreadsheet editor keeps without risk: they live in parts or
 * elements the cell patch layer never touches, and value edits do not
 * change what they mean.
 */
export const XLSX_PRESERVES: ReadonlySet<OoxmlFeature> = new Set<OoxmlFeature>([
  "comments", "alternateContent", "customXmlParts", "smartArt", "contentControls", "customXmlMarkup",
]);

const WARNING_TEXT: Partial<Record<OoxmlFeature, string>> = {
  macros: "It contains macros. Mesa keeps them unchanged, but cannot check what they expect of the cells.",
  charts: "It contains charts. They keep their saved data until Excel redraws them.",
  pivotTables: "It contains pivot tables. They keep their cached data until you refresh them in Excel.",
  externalLinks: "It links to other workbooks. Linked values update only in Excel.",
  embeddedObjects: "It contains embedded objects. Mesa keeps them unchanged.",
  dataConnections: "It contains data connections. Mesa does not refresh them.",
};

const REFUSAL_TEXT: Partial<Record<OoxmlFeature | "unknownKind", string>> = {
  digitalSignatures: "it is digitally signed, and any change would break the signature",
  trackedChanges: "it is a shared workbook with a change history, which Mesa cannot keep consistent",
  unknownKind: "its main part is not a standard Excel workbook",
};

export interface OpenedXlsx {
  readonly session: XlsxSession;
  readonly report: OoxmlCapabilityReport;
  readonly policy: OoxmlEditPolicy;
  /** Shown before editing starts; editing needs a confirmation. */
  readonly warnings: readonly string[];
  /** Why editing is refused; empty when it is allowed. */
  readonly refusals: readonly string[];
}

/** Opens workbook bytes. Throws `OoxmlPackageError` (with a user-facing message) when the package is refused. */
export function openXlsx(bytes: Uint8Array): OpenedXlsx {
  return openXlsxPackage(openOoxmlPackage(bytes));
}

/** Workbook model and edit policy of an opened package; `report` skips a scan already done elsewhere. */
export function openXlsxPackage(pkg: OoxmlPackage, scanned?: OoxmlCapabilityReport): OpenedXlsx {
  const workbook = openXlsxWorkbook(pkg);
  const report = scanned ?? scanOoxmlCapabilities(pkg);
  const policy = decideOoxmlEditPolicy(report, "spreadsheet", XLSX_PRESERVES);
  const warnings = policy.reasons.filter((r) => r.decision === "allowWithWarning").map((r) => WARNING_TEXT[r.feature as OoxmlFeature] ?? `It contains ${r.feature}.`);
  const refusals = policy.reasons.filter((r) => r.decision === "refuseSave").map((r) => REFUSAL_TEXT[r.feature] ?? `it contains ${r.feature}, which Mesa cannot keep`);
  if (workbook.strict) refusals.push("it uses Strict Open XML, which Mesa only displays");
  return { session: new XlsxSession(workbook), report, policy, warnings, refusals };
}
