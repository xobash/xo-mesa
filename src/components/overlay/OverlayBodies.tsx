import { useMemo, useState } from "react";
import { useAppStore } from "../../store";
import { localISO } from "../../lib/daily";
import { isImageExt, urlForPath } from "../../lib/vault";
import { useOverlayDraft } from "../useOverlayDraft";

export const SCRATCH_PREFIX = "mesa:scratch:";

/** Draft identity includes the vault session and the selected day. */
export function Scratchpad() {
  const [day, setDay] = useState(localISO());
  const identity = useAppStore(s => `${s.vaultPath}\0${s.getVaultGeneration()}`);
  return <div className="ov-scratch-win">
    <input aria-label="Scratchpad date" type="date" className="text-input" value={day}
      onChange={e => setDay(e.target.value || localISO())} />
    <ScratchpadDocument key={`${identity}\0${day}`} day={day} />
  </div>;
}

export function ScratchpadDocument({ day }: { day: string }) {
  const draft = useOverlayDraft("scratchpad", `Scratchpad/${day}.md`, SCRATCH_PREFIX + day, day);
  return <>
    <textarea aria-label="Scratchpad draft" className="ov-scratch" placeholder="A quick note for this day…"
      value={draft.content} onChange={e => draft.edit(e.target.value)} />
    <button className="btn ghost ov-save-vault" disabled={!draft.ready || draft.saving || !draft.root}
      onClick={() => void draft.save()}>{draft.saving ? "Saving…" : "Save as vault document"}</button>
    {draft.status && <p className="ov-vault-status" role="status">{draft.status}</p>}
    {draft.error && <p className="ov-local-warn" role="alert">{draft.error}</p>}
  </>;
}

/** Gallery of the vault's images. */
export function Gallery() {
  const files = useAppStore((s) => s.files);
  const selectFile = useAppStore((s) => s.selectFile);
  const setOverlayOpen = useAppStore((s) => s.setOverlayOpen);
  const images = useMemo(
    () => files.filter((f) => isImageExt(f.ext) || f.ext === "svg"),
    [files]
  );
  if (images.length === 0)
    return <div className="palette-empty ov-empty">No images in this vault yet.</div>;
  return (
    <div className="ov-gallery">
      {images.map((f) => (
        <button
          key={f.relPath}
          className="ov-gallery-cell"
          title={f.relPath}
          onClick={() => {
            void selectFile(f.relPath);
            setOverlayOpen(false);
          }}
        >
          <img src={urlForPath(f.path)} alt={f.name} loading="lazy" />
          <span className="ov-gallery-name">{f.name}</span>
        </button>
      ))}
    </div>
  );
}
