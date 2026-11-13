import type { RGB } from "../lib/pdf";
import type { PdfTextRun } from "./usePdfEditor";

export type Tool = "select" | "edit" | "text" | "highlight" | "ink";

/** Delay before showing the native read-only fallback while page 1 is loading. */
export const NATIVE_WARM_START_DELAY_MS = 120;

export const COLORS: { label: string; rgb: RGB }[] = [
  { label: "Black", rgb: { r: 0, g: 0, b: 0 } },
  { label: "Red", rgb: { r: 0.85, g: 0.12, b: 0.12 } },
  { label: "Blue", rgb: { r: 0.1, g: 0.45, b: 0.95 } },
  { label: "Yellow", rgb: { r: 1, g: 0.85, b: 0.15 } },
];

export interface PendingText {
  page: number;
  // page-local PDF coords (bottom-left origin)
  pdfX: number;
  pdfY: number;
  // screen position for the input overlay
  left: number;
  top: number;
}

export interface PendingReplace {
  run: PdfTextRun;
  left: number;
  top: number;
}
