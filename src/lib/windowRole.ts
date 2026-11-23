/**
 * True in the main workspace window; false in a torn-out panel, document,
 * Pi or Research window (their routes carry `panel`, `doc`, `agent` or
 * `research`). Only the main window owns the persisted pane layout: other
 * windows share settings storage, and the main window follows their writes.
 */
export function isWorkspaceWindow(search: string = typeof location === "undefined" ? "" : location.search): boolean {
  const params = new URLSearchParams(search);
  return !["panel", "doc", "agent", "research"].some((key) => params.has(key));
}
