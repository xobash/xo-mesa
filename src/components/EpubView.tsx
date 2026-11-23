import { useEffect, useState } from "react";
import type { VaultFile } from "../types";
import { ByteSource } from "../lib/byteSource";
import { epubChapterMarkup, openEpub, type EpubBook } from "../lib/epub";
import { savedHtmlFrameDocument } from "../lib/html";
import { readVaultRange } from "../lib/vaultByteRead";

/**
 * Read-only EPUB reader: spine order, table of contents and one sanitized
 * chapter at a time in an empty-sandbox frame. Package images and fonts are
 * inlined; nothing else loads and links inside the book do not navigate.
 * Only the entries a chapter needs are read, never the whole file.
 */
export function EpubView({ file }: { file: VaultFile }) {
  const [book, setBook] = useState<EpubBook | { error: string } | null>(null);
  const [chapter, setChapter] = useState(0);

  useEffect(() => {
    let alive = true;
    setBook(null);
    setChapter(0);
    ByteSource.open((offset, len) => readVaultRange(file, offset, len))
      .then(openEpub)
      .then(
        (next) => { if (alive) setBook(next); },
        (reason: unknown) => { if (alive) setBook({ error: reason instanceof Error ? reason.message : String(reason) }); }
      );
    return () => { alive = false; };
  }, [file]);

  type Rendered = { book: EpubBook; chapter: number } & ({ html: string } | { error: string });
  const [rendered, setRendered] = useState<Rendered | null>(null);
  useEffect(() => {
    if (!book || "error" in book) return;
    let alive = true;
    epubChapterMarkup(book, chapter).then(savedHtmlFrameDocument).then(
      (html) => { if (alive) setRendered({ book, chapter, html }); },
      (reason: unknown) => { if (alive) setRendered({ book, chapter, error: reason instanceof Error ? reason.message : String(reason) }); }
    );
    return () => { alive = false; };
  }, [book, chapter]);

  if (!book) return <div className="editor-empty">Opening book…</div>;
  if ("error" in book) return <div className="file-fallback-error" role="alert">Cannot open this book: {book.error}</div>;
  const last = book.spine.length - 1;
  return (
    <div className="epub-view">
      <div className="code-bar">
        <span className="code-lang">{book.title || file.name}</span>
        {book.creator && <span className="code-meta">{book.creator}</span>}
        <span className="code-meta">Chapter {chapter + 1} of {book.spine.length} · read-only</span>
        <button type="button" className="btn" disabled={chapter <= 0} onClick={() => setChapter((c) => Math.max(0, c - 1))}>Previous</button>
        <button type="button" className="btn" disabled={chapter >= last} onClick={() => setChapter((c) => Math.min(last, c + 1))}>Next</button>
      </div>
      <div className="epub-body">
        {book.toc.length > 0 && (
          <nav className="epub-toc" aria-label="Table of contents">
            {book.toc.map((entry, i) => (
              <button key={i} type="button" className={"epub-toc-item" + (entry.spineIndex === chapter ? " is-current" : "")}
                style={{ paddingLeft: 8 + entry.depth * 12 }} disabled={entry.spineIndex < 0}
                aria-current={entry.spineIndex === chapter ? "page" : undefined}
                onClick={() => setChapter(entry.spineIndex)}>
                {entry.label}
              </button>
            ))}
          </nav>
        )}
        {!rendered || rendered.book !== book || rendered.chapter !== chapter ? (
          <div className="editor-empty">Opening chapter…</div>
        ) : "error" in rendered ? (
          <div className="file-fallback-error" role="alert">Cannot show this chapter: {rendered.error}</div>
        ) : (
          <iframe key={chapter} className="html-frame epub-frame" srcDoc={rendered.html}
            sandbox="" referrerPolicy="no-referrer" title={`${book.title || file.name}, chapter ${chapter + 1}`} />
        )}
      </div>
    </div>
  );
}
