export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** pdf.js failures caused by our own cancel/destroy during cleanup — not real
 *  render errors, so they must never flip the UI into the error/fallback state. */
export function isPdfjsCancellation(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  if (name === "RenderingCancelledException" || name === "AbortException") return true;
  return /destroyed|cancell/i.test(String((err as Error)?.message ?? err));
}
