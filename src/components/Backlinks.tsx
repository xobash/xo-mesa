import { useAppStore } from "../store";
import { backlinksFor } from "../lib/graph";

export function Backlinks() {
  const notes = useAppStore((s) => s.notes);
  const activePath = useAppStore((s) => s.activePath);
  const selectFile = useAppStore((s) => s.selectFile);

  if (!activePath) return null;
  const links = backlinksFor(notes, activePath);

  return (
    <div className="backlinks">
      <div className="backlinks-title">
        Linked mentions <span className="count">{links.length}</span>
      </div>
      {links.length === 0 ? (
        <div className="backlinks-empty">No notes link here yet.</div>
      ) : (
        links.map((id) => (
          <button
            key={id}
            className="backlink"
            onClick={() => void selectFile(id)}
          >
            {notes[id]?.title ?? id}
          </button>
        ))
      )}
    </div>
  );
}
