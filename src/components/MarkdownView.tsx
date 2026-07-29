import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { VaultFile } from "../types";
import { resolveAssetPath } from "../lib/graph";
import { urlForPath } from "../lib/vault";
import { useAppStore } from "../store";

/**
 * The markdown renderer (markdown-it + dompurify, ~120 kB minified) is loaded
 * as its own chunk so it never blocks first paint — see `lib/markdown.ts`.
 * The import is kicked off when this module evaluates, not when a view mounts:
 * markdown can only render after note bytes come back from an async disk read,
 * which is orders of magnitude slower than resolving a local chunk, so
 * `renderer` is warm before the first render and the synchronous path below is
 * the one that always runs in practice. `ready` exists only to cover the
 * theoretical first-frame race, and keeps the rendered output correct if it
 * ever loses.
 */
type Renderer = (source: string) => string;
let renderer: Renderer | null = null;
const rendererReady: Promise<void> = import("../lib/markdown").then((m) => {
  renderer = m.renderMarkdown;
});

/**
 * Renders markdown to HTML, then walks the result to:
 *  - wire [[wiki links]] to open the target note
 *  - resolve embedded images (![[img]] / ![](rel)) to real vault URLs
 * Raw HTML in the source is preserved by the renderer.
 *
 * `files`/`onWikiClick` default to the global store, but can be supplied so the
 * popout document windows can render against their own vault scan.
 */
export function MarkdownView({
  source,
  files,
  onWikiClick,
  highlight,
}: {
  source: string;
  files?: VaultFile[];
  onWikiClick?: (target: string) => void;
  /** Highlight + scroll to the first occurrence of this text (the live change). */
  highlight?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const storeFiles = useAppStore((s) => s.files);
  const storeOpen = useAppStore((s) => s.openTarget);
  const useFiles = files ?? storeFiles;
  const onClick = onWikiClick ?? storeOpen;
  const [ready, setReady] = useState(renderer !== null);
  /**
   * Rendering is proportional to document size — measured 54.7 ms for one pass
   * over a real 420 kB note (markdown-it 14 ms + DOMPurify 18 ms at 100 kB,
   * both linear). Because `source` is the store's live editor text, an
   * un-deferred render ran that pass INSIDE the keystroke's own commit, so
   * typing in a large note blocked the main thread for the whole pass before
   * the caret could move (measured: one 592 ms task for five keystrokes).
   *
   * `useDeferredValue` moves it to transition priority: the keystroke commits
   * and paints with the previously rendered HTML, then the new render runs in
   * a separate task, and a keystroke arriving before that task starts discards
   * it instead of queueing another full pass. The settled output is always the
   * latest `source` — only the frame it lands on changes.
   */
  const deferredSource = useDeferredValue(source);
  const html = useMemo(
    () => (renderer ? renderer(deferredSource) : ""),
    [deferredSource, ready]
  );

  useEffect(() => {
    if (ready) return;
    let alive = true;
    void rendererReady.then(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, [ready]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onLinkClick = (e: Event) => {
      e.preventDefault();
      const target = (e.currentTarget as HTMLElement).getAttribute("data-target");
      if (target) onClick(target);
    };

    const links = Array.from(
      el.querySelectorAll<HTMLElement>("a.wikilink, span.wikilink")
    );
    links.forEach((a) => a.addEventListener("click", onLinkClick));

    el.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
      const raw = img.getAttribute("data-embed") ?? img.getAttribute("src") ?? "";
      if (!raw || /^(https?:|data:|asset:|blob:|tauri:|file:)/i.test(raw)) return;
      const abs = resolveAssetPath(useFiles, raw);
      if (abs) img.src = urlForPath(abs);
    });

    // Task lists: "- [ ] todo" / "- [x] done" → real (read-only) checkboxes.
    el.querySelectorAll<HTMLLIElement>("li").forEach((li) => {
      const m = /^\s*\[( |x|X)\]\s+/.exec(li.textContent || "");
      if (!m) return;
      const checked = m[1].toLowerCase() === "x";
      li.innerHTML = li.innerHTML.replace(/^\s*\[( |x|X)\]\s+/, "");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = checked;
      cb.disabled = true;
      li.prepend(cb);
      li.parentElement?.classList.add("task-list");
    });

    el.querySelectorAll<HTMLElement>("mark.md-hit").forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    });

    // Highlight + scroll to the live change (a chunk being edited/read/created).
    if (highlight) {
      const lineRaw =
        highlight.split("\n").find((l) => l.trim().length > 2) ?? highlight;
      const needle = lineRaw.replace(/[*_`#>~[\]]/g, "").trim().slice(0, 50);
      if (needle.length >= 3) {
        const lower = needle.toLowerCase();
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const txt = node.nodeValue ?? "";
          const idx = txt.toLowerCase().indexOf(lower);
          if (idx >= 0) {
            try {
              const range = document.createRange();
              range.setStart(node, idx);
              range.setEnd(node, idx + needle.length);
              const mark = document.createElement("mark");
              mark.className = "md-hit";
              range.surroundContents(mark);
              mark.scrollIntoView({ block: "center", inline: "nearest" });
            } catch {
              /* range can't be surrounded — skip silently */
            }
            break;
          }
        }
      }
    }

    return () => links.forEach((a) => a.removeEventListener("click", onLinkClick));
    // `html` is a pure function of `source`; it is listed so the DOM wiring
    // below also re-runs in the rare case the renderer chunk resolves after
    // the first render (html "" -> real markup).
  }, [deferredSource, html, useFiles, onClick, highlight]);

  return (
    <div
      className="markdown-body"
      ref={ref}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
