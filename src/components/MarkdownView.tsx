import { useEffect, useRef, useState } from "react";
import type { VaultFile } from "../types";
import { resolveAssetPath } from "../lib/graph";
import { urlForPath } from "../lib/vault";
import { useAppStore } from "../store";
import { markMesaPerf } from "../lib/mesaPerf";

/**
 * Parses Markdown in a worker, sanitizes accepted output, delegates wiki clicks,
 * and resolves embedded images (![[img]] / ![](rel)) to real vault URLs.
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
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const rendererRef = useRef<ReturnType<typeof import("../lib/markdownRender").createMarkdownRenderer> | null>(null);
  const domRef = useRef<ReturnType<typeof import("../lib/markdownDom").createMarkdownDom> | null>(null);
  const filesRef = useRef(useFiles);
  filesRef.current = useFiles;
  const resolveImages = (nodes: readonly Node[]) => {
    const resolve = (img: HTMLImageElement) => {
      const raw = img.getAttribute("data-embed") ?? img.getAttribute("src") ?? "";
      if (!raw || /^(https?:|data:|asset:|blob:|tauri:|file:)/i.test(raw)) return;
      const abs = resolveAssetPath(filesRef.current, raw);
      if (abs) img.src = urlForPath(abs);
    };
    for (const node of nodes) if (node instanceof Element) {
      if (node instanceof HTMLImageElement) resolve(node);
      node.querySelectorAll<HTMLImageElement>('img').forEach(resolve);
    }
  };
  const sourceRef = useRef(source);
  sourceRef.current = source;
  useEffect(() => {
    let alive = true;
    void Promise.all([import("../lib/markdownRender"), import("../lib/markdownDom")]).then(([{ createMarkdownRenderer }, { createMarkdownDom }]) => {
      if (!alive || !ref.current) return;
      const dom = createMarkdownDom(ref.current, {
        onInsert: resolveImages,
        onComplete: (stats) => {
          if (!alive) return;
          setError(""); setRevision(value => value + 1);
          markMesaPerf("markdown-render", { ...stats });
        },
        onError: reason => { if (alive) setError(String(reason)); },
      });
      domRef.current = dom;
      const renderer = createMarkdownRenderer(
        blocks => { if (alive) dom.update(blocks); },
        message => { if (alive) { dom.fail(); setError(message); } }
      );
      rendererRef.current = renderer;
      dom.pending(); renderer.render(sourceRef.current);
    }).catch(reason => { if (alive) setError(String(reason)); });
    return () => {
      alive = false; rendererRef.current?.dispose(); rendererRef.current = null;
      domRef.current?.dispose(); domRef.current = null;
    };
  }, []);
  useEffect(() => { domRef.current?.pending(); rendererRef.current?.render(source); }, [source]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onLinkClick = (e: Event) => {
      const link = (e.target as Element).closest?.("a.wikilink, span.wikilink");
      if (!link || !el.contains(link)) return;
      const target = link.getAttribute("data-target");
      if (target) { e.preventDefault(); onClick(target); }
    };

    el.addEventListener("click", onLinkClick);
    return () => el.removeEventListener("click", onLinkClick);
  }, [onClick]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    resolveImages([...el.childNodes]);
  }, [useFiles]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
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

  }, [revision, highlight]);

  return (
    <>
      {error && <div role="alert">Preview unavailable: {error}</div>}
      <div
        className="markdown-body"
        ref={ref}
        aria-label="Markdown preview"
      />
    </>
  );
}
