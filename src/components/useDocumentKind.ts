import { useEffect, useState } from "react";
import type { VaultFile } from "../types";
import { sniffVaultText } from "../lib/vault";
import { documentKind, needsTextSniff, rememberSniffedText, type FileKind } from "../lib/vaultFileKinds";

/**
 * How a document surface renders `file`, the way the main pane does: an
 * unknown extension is sniffed from a bounded prefix once, and text opens as
 * text. While the sniff runs the kind stays "other"; a failed sniff keeps it.
 */
export function useDocumentKind(file: VaultFile | undefined): FileKind {
  const [, setSniffed] = useState(0);
  const pending = file !== undefined && needsTextSniff(file);
  useEffect(() => {
    if (!file || !pending) return;
    let alive = true;
    void sniffVaultText(file).then((text) => {
      if (!text) return;
      rememberSniffedText(file.path);
      if (alive) setSniffed((n) => n + 1);
    }, () => { /* the details view stays; it explains the file */ });
    return () => { alive = false; };
  }, [file, pending]);
  return file ? documentKind(file) : "text";
}
