/** `value` limited to [lo, hi]. An inverted range returns `lo`; a NaN operand returns NaN. */
export function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}
