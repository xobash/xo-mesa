import { useMemo } from "react";
import { useAppStore } from "../store";
import { backlinksFor } from "../lib/graph";
import { SORT_LABELS } from "../lib/sort";
import { countWords } from "../lib/wordCount";

export function StatusBar() {
  const activePath = useAppStore((s) => s.activePath);
  const content = useAppStore((s) => s.content);
  const notes = useAppStore((s) => s.notes);
  const files = useAppStore((s) => s.files);
  const sortMode = useAppStore((s) => s.settings.sortMode);
  const syncListening = useAppStore((s) => s.syncListening);
  const linkCount = useAppStore((s) => s.openTabs.length);

  // This bar subscribes to the live editor text, so everything derived from it
  // runs per keystroke. `countWords` scans without allocating; the asset count
  // is memoized because `files` does not change while typing (it changes only
  // on a vault scan or a create/delete), so filtering 4,000+ entries into a
  // throwaway array on every character was pure waste.
  const words = countWords(content);
  const backlinks = useMemo(
    () => (activePath ? backlinksFor(notes, activePath).length : 0),
    [notes, activePath]
  );
  const noteCount = Object.keys(notes).length;
  const assetCount = useMemo(
    () => files.reduce((n, f) => (f.isMarkdown ? n : n + 1), 0),
    [files]
  );

  return (
    <footer className="statusbar">
      <span>{noteCount} notes</span>
      {assetCount > 0 && <span>{assetCount} assets</span>}
      {linkCount > 0 && <span>{linkCount} open</span>}
      <span className="sb-sort">sort: {SORT_LABELS[sortMode].toLowerCase()}</span>
      {activePath && <span className="sb-path">{activePath}</span>}
      <span className="sb-spacer" />
      {syncListening && <span className="sb-sync">◉ sync on</span>}
      {activePath && (
        <>
          <span>{words.toLocaleString()} words</span>
          <span>{content.length.toLocaleString()} chars</span>
          <span>{backlinks} backlinks</span>
        </>
      )}
    </footer>
  );
}
