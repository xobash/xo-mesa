import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { findSyncConflicts, type SyncConflict } from '../lib/syncConflicts';
import { readReviewText } from '../lib/vault';
import { applyTextDiffChoice, diffTextLines, type TextDiffPart } from '../lib/textDiff';

const REVIEW_LIMIT = 1024 * 1024;
export function SyncConflictReview() {
  const files = useAppStore(s => s.files), vault = useAppStore(s => s.vaultPath);
  const busy = useAppStore(s => s.syncBusy);
  const conflicts = useMemo(() => findSyncConflicts(files), [files]);
  const [page, setPage] = useState(0);
  const [review, setReview] = useState<{ conflict: SyncConflict; original: string; other: string; root: string } | null>(null);
  const [draft, setDraft] = useState(''), [message, setMessage] = useState('');
  const [working, setWorking] = useState(false);
  const generation = useRef(0);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const editor = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { if (!working) { if (review) editor.current?.focus(); else trigger.current?.focus(); } }, [working, review]);
  useEffect(() => { generation.current++; setReview(null); setMessage(''); setWorking(false); setPage(0); return () => { generation.current++; }; }, [vault]);
  const open = async (conflict: SyncConflict) => {
    const token = ++generation.current;
    setReview(null); setMessage('Reading both copies…'); setWorking(true);
    try {
      if (!vault) return;
      for (const file of [conflict.original, conflict.copy]) {
        if ((!file.isMarkdown && file.ext !== 'txt') || (file.size !== undefined && file.size > REVIEW_LIMIT)) {
          throw new Error('Use Open original and Open copy for this format or large file. Inline merging is limited to Markdown and plain text up to 1 MiB.');
        }
      }
      await useAppStore.getState().flushSave();
      const [original, other] = await Promise.all([readReviewText(conflict.original), readReviewText(conflict.copy)]);
      if (token !== generation.current) return;
      if (original.length > REVIEW_LIMIT || other.length > REVIEW_LIMIT) throw new Error('A file grew beyond the inline review limit. Open each copy to review it.');
      setReview({ conflict, original, other, root: vault }); setDraft(original); setMessage('Both files remain intact until you save a reviewed version.');
    } catch (error) { if (token === generation.current) setMessage(String(error)); }
    finally { if (token === generation.current) setWorking(false); }
  };
  const save = async () => {
    if (!review) return;
    const token = generation.current;
    setWorking(true);
    try {
      const result = await useAppStore.getState().saveConflictReview(review.root, review.conflict.original.relPath, review.original, draft, review.conflict.copy.relPath);
      if (token === generation.current) { setMessage(result); setReview(null); }
    } catch (error) { if (token === generation.current) setMessage(`Review not saved: ${String(error)}`); }
    finally { if (token === generation.current) setWorking(false); }
  };
  const diffParts = useMemo(() => review ? diffTextLines(review.original, review.other) : [], [review]);
  const applyChoice = (part: TextDiffPart, choice: 'original' | 'other') => setDraft(value => applyTextDiffChoice(value, part, choice));
  if (!conflicts.length && !message) return null;
  const start = Math.min(page * 10, Math.max(0, Math.floor((conflicts.length - 1) / 10) * 10));
  return <section className="sync-section sync-conflicts" aria-label="Sync conflict review">
    <div className="sync-section-title">Review conflict copies ({conflicts.length})</div>
    <p className="setting-desc">Different versions are preserved as separate files. Compare them, keep both, or save reviewed text. A saved review also keeps the previous original.</p>
    {conflicts.slice(start, start + 10).map(conflict => <div className="sync-conflict-row" key={conflict.copy.relPath}>
      <div><strong>{conflict.original.relPath}</strong><div className="setting-desc">Copy from {conflict.peer} · {conflict.date}</div></div>
      <button className="btn" disabled={working || busy} onClick={(event) => { trigger.current = event.currentTarget; void open(conflict); }} aria-label={`Compare ${conflict.copy.relPath}`}>Compare</button>
      <button className="link-btn" onClick={() => { useAppStore.getState().setSyncOpen(false); void useAppStore.getState().openFile(conflict.original.relPath); }}>Open original</button>
      <button className="link-btn" onClick={() => { useAppStore.getState().setSyncOpen(false); void useAppStore.getState().openFile(conflict.copy.relPath); }}>Open copy</button>
    </div>)}
    {conflicts.length > 10 && <div className="sync-conflict-row"><button className="btn" disabled={start === 0} onClick={() => setPage(Math.max(0, page - 1))}>Previous copies</button><span>{start + 1}–{Math.min(start + 10, conflicts.length)} of {conflicts.length}</span><button className="btn" disabled={start + 10 >= conflicts.length} onClick={() => setPage(page + 1)}>Next copies</button></div>}
    {review && <div className="sync-review">
      <div className="sync-review-columns"><label>Original<textarea readOnly value={review.original} /></label><label>Conflict copy<textarea readOnly value={review.other} /></label></div>
      <div className="sync-diff" aria-label="Highlighted differences">
        {diffParts.map((part, index) => part.kind === 'same'
          ? <pre className="sync-diff-same" key={index}>{part.lines.join('')}</pre>
          : <div className="sync-diff-change" key={index}>
              <div className="sync-review-columns">
                <pre className="sync-diff-original">{part.original.join('') || 'No original lines'}</pre>
                <pre className="sync-diff-other">{part.other.join('') || 'No conflict lines'}</pre>
              </div>
              <div className="sync-conflict-row">
                <button className="btn" disabled={working} onClick={() => applyChoice(part, 'original')}>Use original for this change</button>
                <button className="btn" disabled={working} onClick={() => applyChoice(part, 'other')}>Use conflict for this change</button>
              </div>
            </div>)}
      </div>
      <label>Reviewed text<textarea ref={editor} value={draft} disabled={working} onChange={event => setDraft(event.target.value)} /></label>
      <div className="sync-conflict-row"><button className="btn" disabled={working} onClick={() => setDraft(review.original)}>Use original text</button><button className="btn" disabled={working} onClick={() => setDraft(review.other)}>Use conflict text</button><button className="btn primary" disabled={working || busy} onClick={() => void save()}>{working ? 'Saving…' : 'Save reviewed text'}</button><button className="btn" disabled={working} onClick={() => { setReview(null); setMessage('Both copies kept. No files changed.'); }}>Keep both</button></div>
    </div>}
    {message && <p role="status" aria-live="polite" className="setting-desc">{message}</p>}
  </section>;
}
