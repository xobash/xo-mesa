import { memo, useEffect, useState } from "react";
import { getStore, useAppStore } from "../store";
import { backlinksFor } from "../lib/graph";
import { isMarkdownPath } from "../lib/markdownCode";
import type { MentionScanResult, UnlinkedMention } from "../lib/unlinkedMentions";

const SCAN_SLICE_MS = 8;
const MENTIONS_SHOWN_PER_NOTE = 5;

// No props: memo keeps it from re-rendering with Preview on every keystroke;
// its own store subscriptions still update it.
export const Backlinks = memo(function Backlinks() {
  const notes = useAppStore((s) => s.notes);
  const activePath = useAppStore((s) => s.activePath);
  const selectFile = useAppStore((s) => s.selectFile);
  const indexingTextFiles = useAppStore((s) => s.indexingTextFiles);
  const [unlinkedOpen, setUnlinkedOpen] = useState(false);
  const [scan, setScan] = useState<{ key: string; results: MentionScanResult[]; unread: number; done: boolean } | null>(null);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);

  const meta = activePath ? notes[activePath] : undefined;
  // Raw title and aliases; the lazily loaded scanner normalizes them.
  const namesKey = meta ? [meta.title, ...meta.aliases].join("\n") : "";
  const links = activePath ? backlinksFor(notes, activePath) : [];
  const linksKey = links.join("\n");
  const scanKey = `${activePath ?? ""}\0${namesKey}\0${nonce}`;
  const indexing = indexingTextFiles > 0;

  // Opt-in, time-sliced vault scan: it runs only while the section is open,
  // and again after a link is made or the note's names change.
  useEffect(() => {
    if (!unlinkedOpen || !activePath || !namesKey) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void import("../lib/unlinkedMentions").then(({ createMentionScan, mentionNames }) => {
      if (cancelled) return;
      const names = mentionNames({ title: namesKey.split("\n")[0], aliases: namesKey.split("\n").slice(1) });
      if (!names.length) { setScan({ key: scanKey, results: [], unread: 0, done: true }); return; }
      const state = getStore();
      // Notes that already link here are scanned too: their other plain mentions still count.
      const candidates = Object.keys(state.notes).filter((rel) => rel !== activePath && isMarkdownPath(rel));
      const cache = state.contentCache;
      const job = createMentionScan(candidates, (rel) => cache[rel], names);
      const step = () => {
        if (cancelled) return;
        const done = job.advance(SCAN_SLICE_MS);
        setScan({ key: scanKey, results: [...job.results()], unread: job.unread(), done });
        if (!done) timer = setTimeout(step, 0);
      };
      step();
    });
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
    // The scan reads the store snapshot when it starts; `indexing` reruns it
    // once background indexing finishes.
  }, [unlinkedOpen, activePath, namesKey, linksKey, scanKey, indexing]);

  if (!activePath) return null;
  const current = scan?.key === scanKey ? scan : null;
  const mentionCount = current?.results.reduce((sum, item) => sum + item.mentions.length, 0) ?? 0;

  const link = async (relPath: string, mention: UnlinkedMention) => {
    const id = `${relPath}\0${mention.start}`;
    setBusy(id);
    try {
      if (await getStore().linkUnlinkedMention(relPath, mention, activePath)) setNonce((value) => value + 1);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="backlinks">
      <div className="backlinks-title">
        Linked mentions <span className="count">{links.length}</span>
      </div>
      {indexingTextFiles > 0 && <div className="backlinks-empty" role="status">Indexing {indexingTextFiles} text files; links may grow.</div>}
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
      <button
        type="button"
        className="backlinks-section-toggle"
        aria-expanded={unlinkedOpen}
        onClick={() => setUnlinkedOpen((open) => !open)}
      >
        {unlinkedOpen ? "▾" : "▸"} Unlinked mentions
        {current?.done && <span className="count">{mentionCount}</span>}
      </button>
      {unlinkedOpen && (
        <div className="unlinked-mentions" aria-busy={!current?.done}>
          {!current?.done && <div className="backlinks-empty" role="status">Searching notes…</div>}
          {current && current.unread > 0 && (
            <div className="backlinks-empty" role="status">{current.unread} notes are not indexed yet and were skipped.</div>
          )}
          {current?.done && current.results.length === 0 && (
            <div className="backlinks-empty">No other note mentions {meta?.title ?? "this note"} without a link.</div>
          )}
          {current?.results.map(({ relPath, mentions }) => (
            <div key={relPath}>
              {mentions.slice(0, MENTIONS_SHOWN_PER_NOTE).map((mention) => (
                <div className="unlinked-mention" key={mention.start}>
                  <button type="button" className="unlinked-mention-open" onClick={() => void selectFile(relPath)}>
                    {notes[relPath]?.title ?? relPath}
                  </button>
                  <span className="unlinked-mention-snippet">
                    {mention.before}<mark>{mention.text}</mark>{mention.after}
                  </span>
                  <button
                    type="button"
                    className="seg-btn"
                    disabled={busy !== null}
                    aria-label={`Link “${mention.text}” in ${notes[relPath]?.title ?? relPath}`}
                    onClick={() => void link(relPath, mention)}
                  >
                    Link
                  </button>
                </div>
              ))}
              {mentions.length > MENTIONS_SHOWN_PER_NOTE && (
                <div className="backlinks-empty">{mentions.length - MENTIONS_SHOWN_PER_NOTE} more in this note.</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
