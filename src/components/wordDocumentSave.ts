import { getStore } from "../store";
import { confirmAction } from "../lib/confirmAction";
import { duplicateRelPath } from "../lib/fsnames";
import { pdfBytesEqual } from "../lib/pdfBytes";
import { writeVaultBinaryFile } from "../lib/vault";
import { openOoxmlPackage, type OoxmlPackage } from "../lib/ooxml/ooxmlPackage";
import { describeCensusLosses, planWordSave } from "../lib/ooxml/wordCompose";
import { PLAIN_SOURCE, type OfficeByteSource } from "./officeByteSource";

// Save steps for the Word editor. Every write goes through the verified byte
// path; the composed package is re-opened and checked before it is written.

export interface WordSaveInput {
  /** Package as opened (or last saved); its bytes are the on-disk precondition. */
  original: OoxmlPackage;
  /** Editor output before any edit. */
  baseline: Uint8Array;
  /** Editor output now. */
  edited: Uint8Array;
}

export type WordSaveOutcome =
  | { kind: "unchanged" }
  | { kind: "cancelled"; message: string }
  | { kind: "refused"; message: string }
  | { kind: "saved"; bytes: Uint8Array; package: OoxmlPackage; message: string };

const MAX_LISTED_PROBLEMS = 3;

/** Composes, checks and (after confirming removals) returns the bytes to write; never writes. */
async function prepare(input: WordSaveInput, mode: "inPlace" | "copy"): Promise<WordSaveOutcome | { kind: "ready"; bytes: Uint8Array; package: OoxmlPackage }> {
  let plan;
  try {
    plan = planWordSave(input.original, input.baseline, input.edited, { mode });
  } catch (error) {
    return { kind: "refused", message: `Not saved: the edited document did not pass Mesa's package check (${error instanceof Error ? error.message : String(error)}). Your edits are still here.` };
  }
  if (plan.kind === "unchanged") return plan;
  if (plan.kind === "refused" || plan.kind === "blocked") {
    const listed = plan.problems.slice(0, MAX_LISTED_PROBLEMS).join("; ");
    const more = plan.problems.length > MAX_LISTED_PROBLEMS ? ` (and ${plan.problems.length - MAX_LISTED_PROBLEMS} more)` : "";
    const message = plan.kind === "blocked"
      ? `Not saved: ${listed}${more}. Undo that change, or use Save as copy; the original stays unchanged. Your edits are still here.`
      : `Not saved: the result would damage the file: ${listed}${more}. Your edits are still here.`;
    return { kind: "refused", message };
  }
  if (plan.losses.length) {
    const ok = await confirmAction(`This save removes ${describeCensusLosses(plan.losses)}. Save anyway?`, {
      title: "Save and remove these items?", okLabel: "Save", cancelLabel: "Keep editing", kind: "warning",
    });
    if (!ok) return { kind: "cancelled", message: "Not saved. Your edits are still here." };
  }
  return { kind: "ready", bytes: plan.bytes, package: plan.package };
}

/** Overwrites the file, refusing when its bytes on disk are not the opened ones. */
export async function saveWordInPlace(path: string, input: WordSaveInput, source: OfficeByteSource = PLAIN_SOURCE): Promise<WordSaveOutcome> {
  const prepared = await prepare(input, "inPlace");
  if (prepared.kind !== "ready") return prepared;
  await source.save({
    path,
    bytes: prepared.bytes,
    expected: input.original.original,
    kind: "Word document",
    validate: (candidate) => {
      if (!pdfBytesEqual(candidate, prepared.bytes)) throw new Error("Word bytes do not match the composed package.");
      openOoxmlPackage(candidate);
    },
  });
  return { kind: "saved", bytes: prepared.bytes, package: prepared.package, message: "Saved." };
}

/** Writes the edited document to a new sibling file; the original is never touched. */
export async function saveWordCopy(relPath: string, input: WordSaveInput, source: OfficeByteSource = PLAIN_SOURCE): Promise<WordSaveOutcome> {
  const prepared = await prepare(input, "copy");
  if (prepared.kind !== "ready") return prepared.kind === "unchanged" ? { kind: "refused", message: "There are no edits to copy." } : prepared;
  const store = getStore();
  const root = store.vaultPath;
  if (!root) return { kind: "refused", message: "No vault is open." };
  const rel = duplicateRelPath(store.files.map((f) => f.relPath), relPath);
  await writeVaultBinaryFile(root, rel, await source.copyBytes(prepared.bytes), { expectedMissing: true });
  if (getStore().vaultPath === root) await getStore().registerVaultFile(rel);
  return { kind: "saved", bytes: prepared.bytes, package: prepared.package, message: `Saved a copy as ${rel}. This view shows the original again.` };
}
