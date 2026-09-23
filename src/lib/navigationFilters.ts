/** Presentation only: never remove these files from indexing, sync or recovery. */
export function isGeneratedNavigationFile(rel: string): boolean {
  const path = rel.replace(/\\/g, "/");
  return path.toLowerCase().startsWith("web archives/") ||
    / \(conflict from [^/]+ \d{4}-\d{2}-\d{2}\)(?: \(\d+\))?(?:\.[^/]*)?$/i.test(path);
}
