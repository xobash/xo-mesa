import { getStore } from "../store";
import { confirmAction } from "../lib/confirmAction";
import { saveDocumentBytes } from "../lib/documentBytesSave";
import { childRelPath, safeBaseName, splitRelPath } from "../lib/fsnames";
import { joinPath } from "../lib/vaultPaths";
import { CONVERSION_LOSSES, buildEditableCopy, verifyEditableCopy } from "../lib/legacyOffice/legacyConvert";
import type { LegacyOfficeContent } from "../lib/legacyOffice/legacyOffice";
import { LEGACY_COPY_EXT } from "../lib/officeFallbackReason";
import type { VaultFile } from "../types";

// "Make editable copy" for a legacy Office file: confirm what the copy
// loses, build a new OOXML package, check it through the package layer,
// write it as a NEW file (missing-file precondition, read-back check) next
// to the original and open it. The original's bytes are never written.

const KIND_LABEL: Record<LegacyOfficeContent["kind"], string> = { word: "Word document", excel: "Excel workbook", powerpoint: "PowerPoint presentation" };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Name of the copy: `<name>.<ext>` beside the original, or a numbered sibling when taken. */
export function editableCopyRelPath(taken: Iterable<string>, file: Pick<VaultFile, "relPath">, ext: string): string {
  const { dir, base } = splitRelPath(file.relPath);
  return childRelPath(taken, dir.replace(/\/+$/, ""), safeBaseName(base) || "Converted copy", ext);
}

/**
 * Runs the confirmed conversion. Returns the status to show, or `null` when
 * the user cancelled or the vault changed underneath.
 */
export async function makeEditableCopy(file: VaultFile, content: LegacyOfficeContent): Promise<string | null> {
  const root = getStore().vaultPath;
  if (!root) return "Open a vault folder first.";
  const ext = LEGACY_COPY_EXT[content.kind];
  const rel = editableCopyRelPath(getStore().files.map((f) => f.relPath), file, ext);
  const original = file.ext ? `${file.name}.${file.ext}` : file.name;
  const ok = await confirmAction(
    `Mesa will create a new ${KIND_LABEL[content.kind]}, ${rel}, that you can edit. ${original} itself is not changed.\n\n${CONVERSION_LOSSES[content.kind]}`,
    { title: "Make an editable copy?", okLabel: `Create .${ext} copy`, cancelLabel: "Cancel", kind: "info" },
  );
  if (!ok || getStore().vaultPath !== root) return null;
  let bytes: Uint8Array;
  try {
    bytes = buildEditableCopy(content);
    verifyEditableCopy(content, bytes);
  } catch (error) {
    return `Could not build the editable copy, so nothing was written: ${message(error)}`;
  }
  try {
    await saveDocumentBytes({
      path: joinPath(root, rel), bytes, expected: null, kind: KIND_LABEL[content.kind],
      validate: (candidate) => verifyEditableCopy(content, candidate),
    });
  } catch (error) {
    return `Could not write the editable copy: ${message(error)}`;
  }
  if (getStore().vaultPath !== root) return null;
  await getStore().registerVaultFile(rel);
  if (getStore().vaultPath !== root) return null;
  await getStore().openFile(rel);
  return `Created ${rel}. The original is unchanged.`;
}
