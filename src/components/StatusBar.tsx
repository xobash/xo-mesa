import { useMemo } from "react";
import { useAppStore } from "../store";
import { backlinksFor } from "../lib/graph";
import { SORT_LABELS } from "../lib/sort";

export function StatusBar() {
  const activePath = useAppStore((s) => s.activePath);
  const content = useAppStore((s) => s.content);
  const notes = useAppStore((s) => s.notes);
  const files = useAppStore((s) => s.files);
  const sortMode = useAppStore((s) => s.settings.sortMode);
  const syncListening = useAppStore((s) => s.syncListening);
  const linkCount = useAppStore((s) => s.openTabs.length);

  const words = content.trim() ? content.trim().split(/\s+/).length : 0;
  const backlinks = useMemo(
    () => (activePath ? backlinksFor(notes, activePath).length : 0),
    [notes, activePath]
  );
  const noteCount = Object.keys(notes).length;
  const assetCount = files.filter((f) => !f.isMarkdown).length;

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
