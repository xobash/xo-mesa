/** Why text files are matched by name only, for the search status line. The
 *  online-only part appears only when there are such files. */
export function describeUnindexedReasons(counts: { skipped: number; offline: number; failed: number }): string {
  const parts = [`${counts.skipped.toLocaleString()} over the 8 MiB limit`];
  if (counts.offline > 0) {
    parts.push(`${counts.offline.toLocaleString()} online-only in cloud storage (open one to download it)`);
  }
  parts.push(`${counts.failed.toLocaleString()} read failures`);
  return parts.join(", ");
}
