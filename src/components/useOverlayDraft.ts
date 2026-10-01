import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store";
import { readNoteResult } from "../lib/vault";
import { localNoteWriteMessage, readLocalNote } from "../lib/localNotes";
import { overlayDraftKey, readOverlayDraft, writeOverlayDraft, type OverlayDraft } from "../lib/overlayDraft";

const pendingDocuments = new Map<string, Promise<void>>();

/** Mount this hook under a root/generation/document key. Drafts survive remounts,
 * while read and save completions belong only to the originating mount. */
export function useOverlayDraft(kind: "scratchpad" | "whiteboard", rel: string, legacyKey: string, date?: string) {
  const root = useAppStore(s => s.vaultPath);
  const generation = useAppStore(s => s.getVaultGeneration());
  const key = overlayDraftKey(root, rel);
  const [draft, setDraft] = useState<OverlayDraft>(() => readOverlayDraft(key) ?? {
    version: 1, content: readLocalNote(legacyKey), dirty: readLocalNote(legacyKey) !== "",
  });
  const current = useRef(draft);
  const alive = useRef(true);
  const pendingSave = useRef(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [ready, setReady] = useState(false);
  const publish = (next: OverlayDraft) => {
    current.current = next;
    const message = localNoteWriteMessage(writeOverlayDraft(key, next));
    if (alive.current) { setDraft(next); setError(message); }
  };
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    const load = async () => {
      const pending = pendingDocuments.get(key);
      if (pending) {
        await pending;
        if (cancelled) return;
        const saved = readOverlayDraft(key);
        if (saved) current.current = { ...current.current, baseline: saved.baseline };
      }
      const file = useAppStore.getState().fileFor(rel);
      const result = file ? await readNoteResult(file) : { ok: true as const, text: "" };
      if (cancelled) return;
      if (!result.ok) { setError("Could not read the vault document. Your local draft is preserved. Reopen this surface to retry."); return; }
      const baseline = file ? result.text : null;
      const local = current.current;
      // A dirty draft keeps its original baseline across restarts. Updating it
      // to newly read disk bytes would authorize overwriting an external edit.
      publish(local.dirty
        ? { ...local, baseline: local.baseline === undefined ? baseline : local.baseline }
        : { version: 1, content: result.text, baseline, dirty: false });
      setReady(true);
    };
    void load().catch(error => { if (!cancelled) setError(String(error)); });
    return () => { cancelled = true; alive.current = false; };
  }, [key, generation]);
  const edit = (content: string) => {
    if (alive.current) setStatus("");
    publish({ ...current.current, content, dirty: true });
  };
  const save = async () => {
    if (!ready || pendingSave.current || !root) return;
    pendingSave.current = true;
    const snapshot = current.current;
    setSaving(true); setStatus("");
    let release!: () => void;
    const completed = new Promise<void>(resolve => { release = resolve; });
    pendingDocuments.set(key, completed);
    let saved: string | null;
    try {
      saved = await useAppStore.getState().saveOverlayArtifact(kind, snapshot.content, date, {
        root, generation, expected: snapshot.baseline!,
      });
    } catch (error) {
      if (alive.current) { setError(String(error)); setSaving(false); }
      release();
      if (pendingDocuments.get(key) === completed) pendingDocuments.delete(key);
      return;
    } finally { pendingSave.current = false; }
    const retained = readOverlayDraft(key) ?? current.current;
    if (saved && retained.baseline === snapshot.baseline) {
      writeOverlayDraft(key, { ...retained, baseline: snapshot.content, dirty: retained.content !== snapshot.content });
    }
    release();
    if (pendingDocuments.get(key) === completed) pendingDocuments.delete(key);
    if (!alive.current) return;
    setSaving(false);
    if (!saved) { setError("Could not save the vault document. Your draft is preserved; check the save notice for details."); return; }
    const latest = current.current;
    publish({ ...latest, baseline: snapshot.content, dirty: latest.content !== snapshot.content });
    setStatus(latest.content === snapshot.content ? `Saved ${saved}.` : "Saved the earlier draft. Newer edits are still local.");
  };
  return { content: draft.content, edit, save, error, status, ready, saving, root };
}
