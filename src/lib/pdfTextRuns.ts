/** Group document-wide PDF text runs by zero-based page, preserving run order. */
export function groupPdfTextRunsByPage<T extends { page: number }>(
  runs: readonly T[]
): Map<number, T[]> {
  const byPage = new Map<number, T[]>();
  for (const run of runs) {
    const pageRuns = byPage.get(run.page);
    if (pageRuns) pageRuns.push(run);
    else byPage.set(run.page, [run]);
  }
  return byPage;
}
